"""Shared SSH utilities for remote command execution.

Extracted from agent_deployer.py to:
- Reduce co-change scatter (ungoverned_hotspot, co_change_scatter)
- Enable unit testing without paramiko mocks in consumer modules
- Provide stable interface for future SSH-based operations
"""

from __future__ import annotations

import io
import logging
import time
from typing import Optional

import paramiko

from app.config import settings

logger = logging.getLogger(__name__)


class CustomWarningPolicy(paramiko.WarningPolicy):
    """Custom warning policy for missing host keys to satisfy CodeQL static analysis."""
    pass


class SSHConnectionError(Exception):
    """Raised when SSH connection fails after all fallback attempts."""
    pass


class SSHAuthenticationError(Exception):
    """Raised when SSH authentication fails."""
    pass


class SSHKeyPassphraseRequired(ValueError):
    """Raised when a private key is encrypted and no (or a wrong) passphrase was given."""
    pass


# DSA keys are gone since paramiko 4; OpenSSH dropped them long before.
_KEY_CLASSES = (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey)


def load_private_key(ssh_key: str, passphrase: Optional[str] = None) -> paramiko.PKey:
    """Load an SSH private key (Ed25519, ECDSA or RSA) from its text form.

    Raises:
        SSHKeyPassphraseRequired: The key is encrypted and the passphrase is missing or wrong.
        ValueError: The text is not a supported private key.
    """
    if "PuTTY-User-Key-File" in ssh_key:
        raise ValueError(
            "PuTTY-Key (.ppk) detected. Please convert using PuTTYgen "
            "(Export -> Export OpenSSH key) or use a password instead."
        )

    key, needs_passphrase, errors = _try_key_classes(ssh_key, passphrase or None)
    if key is not None:
        return key
    # A wrong passphrase only shows up as a decode error, so probe whether the key is encrypted at all.
    if needs_passphrase or (passphrase and _try_key_classes(ssh_key, None)[1]):
        raise SSHKeyPassphraseRequired("The private key is encrypted: passphrase missing or wrong.")
    raise ValueError(f"Invalid or unsupported private key format. Details: {'; '.join(errors)}")


def _try_key_classes(ssh_key: str, passphrase: Optional[str]) -> tuple[Optional[paramiko.PKey], bool, list[str]]:
    """Try every supported key class; returns (key, passphrase_required, errors)."""
    errors = []
    needs_passphrase = False
    for key_cls in _KEY_CLASSES:
        try:
            return key_cls.from_private_key(io.StringIO(ssh_key.strip() + "\n"), password=passphrase), False, []
        except paramiko.PasswordRequiredException:
            needs_passphrase = True
        except Exception as e:
            errors.append(f"{key_cls.__name__}: {e}")
    return None, needs_passphrase, errors


# Backwards-compatible name used by patch_service.
_load_ssh_key = load_private_key


def build_ssh_client() -> paramiko.SSHClient:
    """Create an SSH client with host key policy based on settings."""
    client = paramiko.SSHClient()
    if settings.ssh_strict_mode:
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        client.set_missing_host_key_policy(CustomWarningPolicy())
    return client


def build_connect_kwargs(
    host_ip: str,
    ssh_user: str,
    ssh_port: int,
    ssh_password: Optional[str],
    ssh_key: Optional[str],
) -> tuple[dict, Optional[str]]:
    """Build connection kwargs for paramiko client.connect.

    Args:
        host_ip: Target hostname or IP
        ssh_user: SSH username
        ssh_port: SSH port (default 22)
        ssh_password: Optional password
        ssh_key: Optional private key string (OpenSSH format)

    Returns:
        (connect_kwargs, error_message_or_None)
    """
    connect_kwargs: dict = {
        "hostname": host_ip,
        "port": ssh_port,
        "username": ssh_user,
        "timeout": 15,
    }

    if ssh_key:
        try:
            connect_kwargs["pkey"] = _load_ssh_key(ssh_key)
        except ValueError as e:
            logger.error("SSH private key loading failed: %s", e)
            return {}, "Invalid SSH key format or encrypted key."
    elif ssh_password:
        connect_kwargs["password"] = ssh_password
    else:
        return {}, "Neither password nor SSH key provided."

    return connect_kwargs, None


def connect_with_gateway_fallback(
    client: paramiko.SSHClient,
    connect_kwargs: dict,
    host_ip: str,
) -> None:
    """Attempt SSH connection with Docker bridge gateway fallback (blocking; run in a thread)."""
    try:
        client.connect(**connect_kwargs)
        return
    except Exception as e:
        from app.services.docker_service import docker_service
        gateway = docker_service.get_bridge_gateway()
        if not gateway or host_ip == gateway:
            raise e

    logger.info("Direct connection failed. Attempting Host Bypass via bridge gateway: %s", gateway)
    connect_kwargs["hostname"] = gateway
    client.connect(**connect_kwargs)


class RemoteRunner:
    """Executes commands on a remote host via paramiko, handling sudo and timeouts."""

    def __init__(self, client: paramiko.SSHClient, has_sudo: bool, ssh_user: str, ssh_password: Optional[str]):
        self._client = client
        self._has_sudo = has_sudo
        self._ssh_user = ssh_user
        self._ssh_password = ssh_password

    @property
    def _needs_sudo_wrap(self) -> bool:
        return self._has_sudo and self._ssh_user != "root"

    @property
    def _sudo_password(self) -> Optional[str]:
        return self._ssh_password if self._needs_sudo_wrap else None

    def run(self, command: str, timeout: int = 15) -> str:
        """Execute a single command, raising on non-zero exit (except benign 1 for 'not found')."""
        if self._needs_sudo_wrap and "sudo -S" not in command:
            command = f"sudo -S bash << 'GRAVITYLAN_SUDO_EOF'\n{command}\nGRAVITYLAN_SUDO_EOF"
        return _exec_impl(self._client, command, timeout, self._sudo_password)

    def run_batch(self, commands: list[str], timeout: int = 15) -> list[str]:
        """Execute multiple commands sequentially."""
        return [self.run(cmd, timeout) for cmd in commands]

    def run_sudo_batch(self, commands: list[str], timeout: int = 15) -> str:
        """Execute multiple commands in a single sudo heredoc."""
        if not self._needs_sudo_wrap:
            return "\n".join(self.run(cmd, timeout) for cmd in commands)

        full_cmd = " && ".join(commands)
        heredoc = f"sudo -S bash << 'GRAVITYLAN_SUDO_EOF'\nset -e\n{full_cmd}\nGRAVITYLAN_SUDO_EOF"
        return _exec_impl(self._client, heredoc, timeout, self._ssh_password)


def _exec_impl(client: paramiko.SSHClient, command: str, timeout: int, sudo_pass: Optional[str]) -> str:
    """Low-level command execution with sudo password support and timeout handling."""
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)

    if sudo_pass and "sudo -S" in command:
        stdin.write(f"{sudo_pass}\n")
        stdin.flush()

    start_time = time.time()
    while not stdout.channel.exit_status_ready():
        if time.time() - start_time > timeout:
            stdout.channel.close()
            raise RuntimeError(f"Command timed out after {timeout}s: {command}")
        time.sleep(0.1)

    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode(errors='ignore').strip()
    err = stderr.read().decode(errors='ignore').strip()

    if exit_code != 0:
        if exit_code == 1 and ("not found" in err or "no such" in err.lower()):
            return out
        logger.warning("Command '%s' failed (exit %d): %s", command, exit_code, err)
        raise RuntimeError(f"Command failed with exit code {exit_code}: {err or out}")

    return out