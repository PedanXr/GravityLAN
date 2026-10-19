"""SSH-based service for listing and applying package updates on Linux agents.

Reuses connection logic and warning policy from ssh_utils.py for robustness.
paramiko blocks (connect timeouts, exec_command, stdout.read()), so these calls run
in a worker thread via ``asyncio.to_thread`` instead of freezing the event loop.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import re
import shlex
import time
import paramiko
from typing import Any, Awaitable, Callable

from app.config import settings
from app.services.ssh_utils import (
    CustomWarningPolicy,
    PinnedHostKey,
    TofuHostKeyPolicy,
    _load_ssh_key,
    build_pinned_ssh_client,
)

logger = logging.getLogger(__name__)

# Fixed sudo prompt (sudo -p) so it can be recognised regardless of the host's language
_SUDO_PROMPT = "SUDOPROMPT:"


def _build_client(
    pinned_host_key: PinnedHostKey | None = None,
    tofu_policy: TofuHostKeyPolicy | None = None,
) -> paramiko.SSHClient:
    """Create a hardened SSH client with the configured host-key policy."""
    if pinned_host_key is not None:
        return build_pinned_ssh_client(pinned_host_key)
    client = paramiko.SSHClient()
    if settings.ssh_strict_mode:
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    elif tofu_policy is not None:
        client.set_missing_host_key_policy(tofu_policy)
    else:
        client.set_missing_host_key_policy(CustomWarningPolicy())
    return client


def _build_connect_kwargs(
    host_ip: str,
    ssh_user: str,
    ssh_port: int,
    ssh_password: str | None = None,
    ssh_key: str | None = None,
    ssh_key_passphrase: str | None = None,
) -> tuple[dict | None, str | None]:
    """Build paramiko connect kwargs; returns (kwargs, error_message)."""
    connect_kwargs: dict = {
        "hostname": host_ip,
        "port": ssh_port,
        "username": ssh_user,
        "timeout": 15,
    }
    if ssh_key:
        try:
            connect_kwargs["pkey"] = _load_ssh_key(ssh_key, ssh_key_passphrase)
        except Exception as e:
            return None, f"Invalid SSH key format: {e}"
    elif ssh_password:
        connect_kwargs["password"] = ssh_password
    else:
        return None, "Neither password nor SSH key provided."
    return connect_kwargs, None


def _connect_with_fallback(client: paramiko.SSHClient, connect_kwargs: dict, host_ip: str) -> None:
    """Connect directly, falling back to the Docker bridge gateway on failure."""
    try:
        client.connect(**connect_kwargs)
    except Exception as e:
        from app.services.docker_service import docker_service
        gateway = docker_service.get_bridge_gateway()
        if gateway and host_ip != gateway:
            logger.info("Direct connection failed (%s). Trying Host Bypass gateway: %s", e, gateway)
            connect_kwargs["hostname"] = gateway
            client.connect(**connect_kwargs)
        else:
            raise e


def _open_command_channel(
    client: paramiko.SSHClient, connect_kwargs: dict, host_ip: str, run_cmd: str
) -> paramiko.Channel | None:
    """Connect and start ``run_cmd`` on a PTY channel; None without a transport.

    Blocks on the network (connect timeout, gateway fallback, exec round trip),
    so only call it via ``asyncio.to_thread``.
    """
    _connect_with_fallback(client, connect_kwargs, host_ip)

    # Set up shell channel or execute command
    transport = client.get_transport()
    if not transport:
        return None

    channel = transport.open_session()
    channel.get_pty()  # request pty to get combined output and avoid buffering issues
    channel.exec_command(run_cmd)
    return channel


async def run_ssh_command_stream(
    *,
    host_ip: str,
    ssh_user: str,
    ssh_password: str | None = None,
    ssh_key: str | None = None,
    ssh_port: int = 22,
    command: str,
    output_callback: Callable[[str], Awaitable[None] | None],
    ssh_key_passphrase: str | None = None,
    pinned_host_key: PinnedHostKey | None = None,
    tofu_policy: TofuHostKeyPolicy | None = None,
) -> tuple[bool, str]:
    """Connects to host and executes command, streaming stdout/stderr line-by-line.

    Connect and exec run in a worker thread; the read loop stays on the event loop
    because it only reads what recv_ready() reports as already buffered.
    """
    client = _build_client(pinned_host_key=pinned_host_key, tofu_policy=tofu_policy)

    try:
        connect_kwargs, err = _build_connect_kwargs(host_ip, ssh_user, ssh_port, ssh_password, ssh_key, ssh_key_passphrase)
        if err:
            return False, err

        needs_sudo = ssh_user != "root"
        if not needs_sudo:
            run_cmd = command
        elif ssh_password:
            # The whole command runs as root in one shell (a plain "sudo <cmd>" left env
            # assignments and $(...) of the update command outside sudo). The fixed prompt
            # marker is answered whenever it shows up in the stream, however late or localised.
            run_cmd = f"sudo -S -p '{_SUDO_PROMPT}' sh -c {shlex.quote(command)}"
        else:
            # No password: fail fast (passwordless sudo only) instead of waiting for input
            run_cmd = f"sudo -n sh -c {shlex.quote(command)}"

        channel = await asyncio.to_thread(_open_command_channel, client, connect_kwargs, host_ip, run_cmd)
        if channel is None:
            return False, "Failed to get SSH transport channel."

        password_sent = False
        while True:
            # Check if there is data to read
            if channel.recv_ready():
                chunk = channel.recv(4096).decode("utf-8", errors="replace")
                if not chunk:
                    break
                if needs_sudo and ssh_password and not password_sent and _SUDO_PROMPT in chunk:
                    channel.send(f"{ssh_password}\n")
                    password_sent = True
                    chunk = chunk.replace(_SUDO_PROMPT, "")
                if chunk:
                    # An async callback is awaited before the next read: output keeps its
                    # order and no fire-and-forget send task outlives the session
                    result = output_callback(chunk)
                    if inspect.isawaitable(result):
                        await result
            elif channel.exit_status_ready():
                # Exit once finished and no data remains
                if not channel.recv_ready():
                    break
            await asyncio.sleep(0.1)

        # paramiko has no Channel.get_exit_status(). After an EOF break recv_exit_status()
        # may still wait for the exit-status message, so it runs in a worker thread too.
        exit_code = await asyncio.to_thread(channel.recv_exit_status)
        if exit_code == 0:
            return True, "Success"
        else:
            return False, f"Command exited with code {exit_code}"

    except Exception as e:
        logger.error("SSH command execution error: %s", e)
        return False, str(e)
    finally:
        client.close()

async def list_device_updates(
    *,
    host_ip: str,
    ssh_user: str,
    ssh_password: str | None = None,
    ssh_key: str | None = None,
    ssh_port: int = 22,
    ssh_key_passphrase: str | None = None,
    pinned_host_key: PinnedHostKey | None = None,
    tofu_policy: TofuHostKeyPolicy | None = None,
) -> dict[str, Any]:
    """Queries package updates lists over SSH (Debian/Ubuntu/Fedora/CentOS).

    The whole SSH session (connect, apt-get update of up to 90 s, package queries)
    blocks, so it runs in a worker thread like agent_deployer.deploy_agent.
    """
    return await asyncio.to_thread(
        _list_device_updates_blocking,
        host_ip=host_ip,
        ssh_user=ssh_user,
        ssh_password=ssh_password,
        ssh_key=ssh_key,
        ssh_port=ssh_port,
        ssh_key_passphrase=ssh_key_passphrase,
        pinned_host_key=pinned_host_key,
        tofu_policy=tofu_policy,
    )


def _list_device_updates_blocking(
    *,
    host_ip: str,
    ssh_user: str,
    ssh_password: str | None,
    ssh_key: str | None,
    ssh_port: int,
    ssh_key_passphrase: str | None = None,
    pinned_host_key: PinnedHostKey | None = None,
    tofu_policy: TofuHostKeyPolicy | None = None,
) -> dict[str, Any]:
    """Blocking body of :func:`list_device_updates`; only call it via ``asyncio.to_thread``."""
    client = _build_client(pinned_host_key=pinned_host_key, tofu_policy=tofu_policy)

    try:
        connect_kwargs, err = _build_connect_kwargs(
            host_ip, ssh_user, ssh_port, ssh_password, ssh_key, ssh_key_passphrase
        )
        if err:
            return {"patch_manager": None, "packages": [], "major_upgrade_available": None, "error": err}

        _connect_with_fallback(client, connect_kwargs, host_ip)

        # 1. Detect Package Manager
        _, stdout, _ = client.exec_command("command -v apt-get || command -v dnf || command -v yum", timeout=10)
        pkg_manager_path = stdout.read().decode().strip()
        
        result = {
            "patch_manager": None,
            "packages": [],
            "major_upgrade_available": None
        }

        if not pkg_manager_path:
            # Diagnostic fallback: report what the target system actually is,
            # so the UI shows a useful message instead of a generic one.
            try:
                _, stdout_os, _ = client.exec_command(
                    "cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|ID|VERSION_ID)=' || echo 'no /etc/os-release'",
                    timeout=10,
                )
                result["detected_os"] = stdout_os.read().decode().strip()
            except Exception:
                result["detected_os"] = None

        if "apt-get" in pkg_manager_path:
            result["patch_manager"] = "apt"
            _query_apt_updates(client, result, host_ip, ssh_user, ssh_password)

        elif "dnf" in pkg_manager_path:
            result["patch_manager"] = "dnf"
            _query_dnf_updates(client, result)

        elif "yum" in pkg_manager_path:
            result["patch_manager"] = "yum"
            _query_yum_updates(client, result)

        return result

    except Exception as e:
        logger.error("Failed to query package updates over SSH: %s", e)
        return {"patch_manager": None, "packages": [], "major_upgrade_available": None, "error": str(e)}
    finally:
        client.close()


def _query_apt_updates(client, result: dict[str, Any], host_ip: str, ssh_user: str, ssh_password: str | None) -> None:
    """Populate apt upgrade results (refresh cache + parse 'apt list --upgradable').

    Blocking; runs inside :func:`_list_device_updates_blocking`'s worker thread.
    """
    # Refresh package cache first (requires sudo/root).
    # Read the channel continuously so the PTY buffer never fills up
    # (previously this hung forever), and only send the password when
    # sudo actually asks for it (SUDOPROMPT).
    needs_sudo = ssh_user != "root"
    # -n (never prompt) only without a password: combined with -S it made sudo refuse
    # ("a password is required") before the password below could be sent.
    if not needs_sudo:
        update_cmd = "apt-get update"
    elif ssh_password:
        update_cmd = "sudo -S -p 'SUDOPROMPT:' apt-get update"
    else:
        update_cmd = "sudo -n apt-get update"

    chan = client.get_transport().open_session()
    chan.get_pty()
    chan.exec_command(update_cmd)

    update_output = ""
    password_sent = False
    update_deadline = time.monotonic() + 90
    while time.monotonic() < update_deadline:
        if chan.recv_ready():
            update_output += chan.recv(4096).decode("utf-8", errors="replace")
            if (
                needs_sudo
                and ssh_password
                and not password_sent
                and "SUDOPROMPT" in update_output
            ):
                chan.send(f"{ssh_password}\n")
                password_sent = True
        elif chan.exit_status_ready():
            while chan.recv_ready():
                update_output += chan.recv(4096).decode("utf-8", errors="replace")
            break
        time.sleep(0.1)

    update_exit = chan.recv_exit_status() if chan.exit_status_ready() else None
    if update_exit != 0:
        logger.warning(
            "apt-get update on %s failed (exit %s): %s",
            host_ip, update_exit, update_output.strip()[-500:],
        )
        result["error"] = (
            "apt-get update failed (exit %s). Set an SSH password or "
            "enable passwordless sudo to refresh package lists."
        ) % (update_exit if update_exit is not None else "timeout")

    # Query upgradable packages
    _, stdout, _ = client.exec_command("apt list --upgradable 2>/dev/null", timeout=15)
    output = stdout.read().decode("utf-8")

    # Parse apt list --upgradable output. Format:
    # package/suite version arch [upgradable from: old_version]
    # e.g., curl/jammy-updates 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]
    for line in output.splitlines():
        if "upgradable from" in line:
            match = re.match(r"^([^/]+)/([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+\[upgradable from:\s+([^\]]+)\]", line)
            if match:
                pkg_name, suite, new_ver, arch, old_ver = match.groups()
                result["packages"].append({
                    "package": pkg_name,
                    "current_version": old_ver,
                    "new_version": new_ver,
                    "repo": suite
                })

    # Check major upgrade (Ubuntu only)
    _, stdout, _ = client.exec_command("which do-release-upgrade", timeout=5)
    if stdout.read().decode().strip():
        _, stdout, _ = client.exec_command("do-release-upgrade -c", timeout=10)
        out_upgrade = stdout.read().decode("utf-8")
        for line in out_upgrade.splitlines():
            if "New release" in line and "available" in line:
                parts = line.split("'")
                if len(parts) >= 3:
                    result["major_upgrade_available"] = parts[1]


def _query_dnf_updates(client, result: dict[str, Any]) -> None:
    """Populate dnf upgrade results (check-update + batch rpm current versions); blocking."""
    # Get list of upgrades
    _, stdout, _ = client.exec_command("dnf check-update --quiet", timeout=20)
    output = stdout.read().decode("utf-8")

    # Parse dnf check-update output. Lines look like:
    # curl.x86_64               7.81.0-1.fc39             updates
    # Let's get installed versions of those packages to populate current_version
    upgrades = []
    pkg_names = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 3 and not line.startswith("Last metadata"):
            # parts: [package_name.arch, new_version, repo]
            pkg_and_arch = parts[0]
            pkg_name = pkg_and_arch.rsplit(".", 1)[0]
            upgrades.append({
                "package": pkg_name,
                "new_version": parts[1],
                "repo": parts[2],
                "current_version": "Installed"  # Default fallback
            })
            pkg_names.append(pkg_name)

    # Optimisation: fetch current versions in a batch if there are upgrades
    if pkg_names:
        quoted_pkgs = " ".join(shlex.quote(p) for p in pkg_names[:100])
        batch_cmd = f"rpm -q --qf '%{{NAME}} %{{VERSION}}-%{{RELEASE}}\\n' {quoted_pkgs}"
        _, stdout_rpm, _ = client.exec_command(batch_cmd, timeout=10)
        rpm_output = stdout_rpm.read().decode("utf-8")
        version_map = {}
        for line in rpm_output.splitlines():
            subparts = line.split()
            if len(subparts) == 2:
                version_map[subparts[0]] = subparts[1]

        for item in upgrades:
            if item["package"] in version_map:
                item["current_version"] = version_map[item["package"]]

    result["packages"] = upgrades


def _query_yum_updates(client, result: dict[str, Any]) -> None:
    """Populate yum upgrade results (check-update); blocking."""
    _, stdout, _ = client.exec_command("yum check-update --quiet", timeout=20)
    output = stdout.read().decode("utf-8")

    upgrades = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            pkg_and_arch = parts[0]
            pkg_name = pkg_and_arch.rsplit(".", 1)[0]
            upgrades.append({
                "package": pkg_name,
                "new_version": parts[1],
                "repo": parts[2],
                "current_version": "Installed"
            })
    result["packages"] = upgrades
