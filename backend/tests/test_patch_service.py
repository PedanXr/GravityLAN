import asyncio
import time

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import status
from app.models.device import Device
from app.models.agent import AgentToken
from app.services.patch_service import list_device_updates, run_ssh_command_stream

# Test data for mocked SSH outputs
APT_UPGRADABLE_MOCK = """
Listing... Done
curl/jammy-updates 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1ubuntu1.15]
libssl3/jammy-updates 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
"""

DNF_CHECK_UPDATE_MOCK = """
Last metadata expiration check: 0:15:32 ago on Fri Jul 17 09:00:00 2026.

curl.x86_64               7.81.0-1.fc39             updates
libssl.x86_64             3.0.2-1.fc39              updates
"""

RPM_Q_MOCK = """
curl 7.81.0-1.fc38
libssl 3.0.2-1.fc38
"""

@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_list_device_updates_apt(mock_ssh_client):
    # Setup mocks
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    
    # 1. which apt-get output
    mock_chan_which = MagicMock()
    mock_chan_which.read.return_value = b"/usr/bin/apt-get"
    
    # 2. apt-get update channel (finished, no pending output; a bare MagicMock reported
    #    data forever and the test sat out the 90 s refresh deadline)
    mock_chan_update = _real_channel_mock(0)
    
    # 3. apt list --upgradable output
    mock_chan_list = MagicMock()
    mock_chan_list.read.return_value = APT_UPGRADABLE_MOCK.encode("utf-8")
    
    # 4. which do-release-upgrade (major release upgrade check)
    mock_chan_do_release = MagicMock()
    mock_chan_do_release.read.return_value = b"/usr/bin/do-release-upgrade"
    
    # 5. do-release-upgrade -c output
    mock_chan_release_c = MagicMock()
    mock_chan_release_c.read.return_value = b"New release '24.04 LTS' available."

    # Return different mocks for consecutive exec_command calls
    client_instance.exec_command.side_effect = [
        (None, mock_chan_which, None),
        (None, mock_chan_list, None),
        (None, mock_chan_do_release, None),
        (None, mock_chan_release_c, None),
    ]
    
    # Mock transport and update channel
    mock_transport = MagicMock()
    client_instance.get_transport.return_value = mock_transport
    mock_transport.open_session.return_value = mock_chan_update
    
    res = await list_device_updates(
        host_ip="192.168.1.100",
        ssh_user="root",
        ssh_password="password",
        ssh_port=22
    )
    
    assert res["patch_manager"] == "apt"
    assert len(res["packages"]) == 2
    assert res["packages"][0]["package"] == "curl"
    assert res["packages"][0]["current_version"] == "7.81.0-1ubuntu1.15"
    assert res["packages"][0]["new_version"] == "7.81.0-1ubuntu1.16"
    assert res["major_upgrade_available"] == "24.04 LTS"


@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_list_device_updates_dnf(mock_ssh_client):
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    
    # 1. which dnf
    mock_chan_which = MagicMock()
    mock_chan_which.read.return_value = b"/usr/bin/dnf"
    
    # 2. dnf check-update output
    mock_chan_check = MagicMock()
    mock_chan_check.read.return_value = DNF_CHECK_UPDATE_MOCK.encode("utf-8")
    
    # 3. rpm -q query
    mock_chan_rpm = MagicMock()
    mock_chan_rpm.read.return_value = RPM_Q_MOCK.encode("utf-8")
    
    client_instance.exec_command.side_effect = [
        (None, mock_chan_which, None),
        (None, mock_chan_check, None),
        (None, mock_chan_rpm, None),
    ]
    
    res = await list_device_updates(
        host_ip="192.168.1.101",
        ssh_user="root",
        ssh_password="password",
        ssh_port=22
    )
    
    assert res["patch_manager"] == "dnf"
    assert len(res["packages"]) == 2
    assert res["packages"][0]["package"] == "curl"
    assert res["packages"][0]["current_version"] == "7.81.0-1.fc38"
    assert res["packages"][0]["new_version"] == "7.81.0-1.fc39"


@pytest.mark.asyncio
async def test_query_device_patches_endpoint_unauthorized(client, db):
    # Setup setup.complete = true to enforce authentication
    from app.models.setting import Setting
    db.add(Setting(key="setup.complete", value="true"))
    await db.commit()

    # Verify protected endpoint returns 401
    response = await client.post("/api/agent/patches/1/query", json={
        "ssh_user": "root",
        "ssh_password": "password"
    })
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_prepare_patch_action_endpoint_authorized(client, db, admin_token):
    # Setup a dummy device in DB
    device = Device(ip="192.168.1.100", display_name="Test agent device")
    db.add(device)
    await db.commit()
    await db.refresh(device)
    
    response = await client.post(
        f"/api/agent/patches/{device.id}/prepare",
        json={
            "ssh_user": "root",
            "ssh_password": "password",
            "mode": "upgrade"
        },
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "patch_token" in data
    assert data["patch_token"].startswith("patch_tok_")


@pytest.mark.asyncio
async def test_prepare_patch_action_with_stored_key(client, db, admin_token):
    from app.models.ssh import SshKey
    from app.services.secret_vault import vault
    from app.api.agent_patches import _temp_patch_tokens

    from app.services.session_service import session_store

    device = Device(ip="192.168.1.105", display_name="Proxmox Node")
    db.add(device)
    await db.commit()

    key = SshKey(
        name="Homelab Key",
        key_type="ed25519",
        fingerprint="SHA256:1234567890abcdef",
        public_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...",
        encrypted_private_key=vault.encrypt("-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----"),
    )
    db.add(key)
    await db.commit()

    # Browser session cookie (ADR-002 requires browser session to decrypt stored keys)
    client.cookies.set("gravitylan_token", session_store.create_session(user_agent=None))

    response = await client.post(
        f"/api/agent/patches/{device.id}/prepare",
        json={
            "ssh_user": "root",
            "key_id": key.id,
            "mode": "upgrade"
        },
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == 200
    token = response.json()["patch_token"]
    assert _temp_patch_tokens[token]["ssh_key"] == "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----"
    assert _temp_patch_tokens[token]["host_ip"] == "192.168.1.105"


def _real_channel_mock(exit_code: int = 0) -> MagicMock:
    """A channel mock limited to paramiko.Channel's real API (a bare MagicMock accepts any
    attribute, which hid calls to the non-existent Channel.get_exit_status)."""
    import paramiko

    chan = MagicMock(spec=paramiko.Channel)
    chan.recv_ready.return_value = False
    chan.send_ready.return_value = True
    chan.exit_status_ready.return_value = True
    chan.recv_exit_status.return_value = exit_code
    return chan


@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_run_ssh_command_stream_reads_exit_code_with_paramiko_api(mock_ssh_client):
    """Regression: patching aborted with "'Channel' object has no attribute 'get_exit_status'"."""
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    client_instance.get_transport.return_value.open_session.return_value = _real_channel_mock(0)

    ok, message = await run_ssh_command_stream(
        host_ip="192.168.1.100", ssh_user="root", ssh_password="pw",
        command="true", output_callback=lambda _chunk: None,
    )
    assert (ok, message) == (True, "Success")

    client_instance.get_transport.return_value.open_session.return_value = _real_channel_mock(3)
    ok, message = await run_ssh_command_stream(
        host_ip="192.168.1.100", ssh_user="root", ssh_password="pw",
        command="false", output_callback=lambda _chunk: None,
    )
    assert ok is False and "3" in message


@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_apt_update_exit_code_uses_paramiko_api(mock_ssh_client):
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    which = MagicMock()
    which.read.return_value = b"/usr/bin/apt-get"
    listing = MagicMock()
    listing.read.return_value = APT_UPGRADABLE_MOCK.encode("utf-8")
    no_release = MagicMock()
    no_release.read.return_value = b""
    client_instance.exec_command.side_effect = [
        (None, which, None), (None, listing, None), (None, no_release, None), (None, no_release, None),
    ]
    client_instance.get_transport.return_value.open_session.return_value = _real_channel_mock(0)

    res = await list_device_updates(host_ip="192.168.1.100", ssh_user="root", ssh_password="pw", ssh_port=22)

    assert "error" not in res, res.get("error")
    assert res["patch_manager"] == "apt"
    assert len(res["packages"]) == 2


@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_run_ssh_command_stream_sends_sudo_password_on_late_prompt(mock_ssh_client):
    """Non-root upgrades: the password went out only if sudo prompted within 0.5 s, and a plain
    'sudo <cmd>' left env assignments and $(...) of the update command outside sudo."""
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    chan = _real_channel_mock(0)
    chunks = [b"", b"", b"", b"", b"", b"", b"", b"SUDOPROMPT:", b"Reading package lists... Done\r\n"]

    def recv_ready():
        # b"" entries are ticks where nothing has arrived yet (the prompt comes well after 0.5 s)
        if chunks and chunks[0] == b"":
            chunks.pop(0)
            return False
        return bool(chunks)

    chan.recv_ready.side_effect = recv_ready
    chan.recv.side_effect = lambda _n: chunks.pop(0)
    chan.exit_status_ready.side_effect = lambda: not chunks
    client_instance.get_transport.return_value.open_session.return_value = chan
    output: list[str] = []

    ok, _msg = await run_ssh_command_stream(
        host_ip="192.168.1.100", ssh_user="oliver", ssh_password="pw",
        command="DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y $(echo x)",
        output_callback=output.append,
    )

    assert ok is True
    sent_cmd = chan.exec_command.call_args.args[0]
    assert sent_cmd.startswith("sudo -S -p 'SUDOPROMPT:' sh -c ")
    assert "'DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y $(echo x)'" in sent_cmd
    chan.send.assert_called_once_with("pw\n")
    assert "SUDOPROMPT" not in "".join(output)
    assert "Reading package lists" in "".join(output)


# A blocking paramiko call on the event loop shows up as a stall this long
_SLOW_SSH_SECONDS = 0.5


def _slow(value):
    """Side effect that blocks the calling thread like a slow SSH round trip, then returns value."""
    def call(*_args, **_kwargs):
        time.sleep(_SLOW_SSH_SECONDS)
        return value
    return call


async def _run_and_measure_loop_stall(coro):
    """Await ``coro`` while a parallel task ticks; returns (result, longest gap between ticks)."""
    loop = asyncio.get_running_loop()
    gaps: list[float] = []
    done = False

    async def ticker():
        last = loop.time()
        while not done:
            await asyncio.sleep(0.01)
            now = loop.time()
            gaps.append(now - last)
            last = now

    task = asyncio.create_task(ticker())
    await asyncio.sleep(0)  # the ticker takes its first timestamp before coro can block
    try:
        result = await coro
    finally:
        done = True
        await task
    return result, max(gaps)


@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_list_device_updates_keeps_event_loop_running(mock_ssh_client):
    """A slow connect, apt-get update and package query used to freeze the whole backend
    (API, WebSockets, scheduler) for as long as paramiko blocked."""
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    client_instance.connect.side_effect = _slow(None)

    which = MagicMock()
    which.read.return_value = b"/usr/bin/apt-get"
    listing = MagicMock()
    listing.read.side_effect = _slow(APT_UPGRADABLE_MOCK.encode("utf-8"))
    no_release = MagicMock()
    no_release.read.return_value = b""
    client_instance.exec_command.side_effect = [
        (None, which, None), (None, listing, None), (None, no_release, None),
    ]
    # apt-get update only finishes after a few polls of the refresh loop
    update_chan = _real_channel_mock(0)
    polls = iter([False, False, False])
    update_chan.exit_status_ready.side_effect = lambda: next(polls, True)
    client_instance.get_transport.return_value.open_session.return_value = update_chan

    res, stall = await _run_and_measure_loop_stall(
        list_device_updates(host_ip="192.168.1.100", ssh_user="root", ssh_password="pw")
    )

    assert "error" not in res, res.get("error")
    assert res["patch_manager"] == "apt"
    assert len(res["packages"]) == 2
    assert stall < _SLOW_SSH_SECONDS / 2, f"event loop stalled for {stall:.2f} s"


@pytest.mark.asyncio
@patch("paramiko.SSHClient")
async def test_run_ssh_command_stream_keeps_event_loop_running(mock_ssh_client):
    """Connect and exec_command run off the event loop; the async output callback is still
    awaited before the next read, so a slow first send cannot reorder the output."""
    client_instance = MagicMock()
    mock_ssh_client.return_value = client_instance
    client_instance.connect.side_effect = _slow(None)
    pending = [b"first\n", b"second\n"]
    chan = _real_channel_mock(0)
    chan.recv_ready.side_effect = lambda: bool(pending)
    chan.recv.side_effect = lambda _n: pending.pop(0)
    chan.exit_status_ready.side_effect = lambda: not pending
    chan.exec_command.side_effect = _slow(None)
    client_instance.get_transport.return_value.open_session.return_value = chan
    output: list[str] = []

    async def output_callback(chunk: str) -> None:
        if chunk.startswith("first"):
            await asyncio.sleep(0.2)  # longer than one read-loop tick
        output.append(chunk)

    (ok, message), stall = await _run_and_measure_loop_stall(
        run_ssh_command_stream(
            host_ip="192.168.1.100", ssh_user="root", ssh_password="pw",
            command="apt-get dist-upgrade -y", output_callback=output_callback,
        )
    )

    assert (ok, message) == (True, "Success")
    assert output == ["first\n", "second\n"]
    assert stall < _SLOW_SSH_SECONDS / 2, f"event loop stalled for {stall:.2f} s"
