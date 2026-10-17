"""Automated security remediation regression tests (Befunde 1, 2, 3)."""

import hashlib
import secrets
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select

from app.api.agent import _find_and_migrate_agent_token
from app.api.auth import _authenticate_websocket_impl
from app.models.agent import AgentToken
from app.models.api_token import ApiToken
from app.models.device import Device
from app.models.setting import Setting
from app.models.ssh import SshKnownHost
from app.services.patch_service import _query_dnf_updates
from app.services.ssh_utils import CapturedHostKey


@pytest.mark.asyncio
async def test_readonly_api_token_cannot_download_agent_config(client, db):
    """Befund 1: Read-only API tokens must not be able to export agent configurations."""
    device = Device(id=42, ip="192.168.1.42", display_name="Test Host", is_online=True)
    db.add(device)
    db.add(Setting(key="setup.complete", value="true"))

    raw_token = "gl_pat_readonly_token_123456789012345"
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    api_token = ApiToken(
        name="Readonly Token",
        token_hash=token_hash,
        prefix=raw_token[:12],
        scopes="agent:read,topology:read",
    )
    db.add(api_token)
    await db.commit()

    res = await client.get(
        "/api/agent/download/config/42",
        headers={"Authorization": f"Bearer {raw_token}"},
    )

    assert res.status_code == 403
    assert "not authorized" in res.text.lower()


@pytest.mark.asyncio
async def test_agent_token_hashed_and_legacy_auto_migrated(db):
    """Befund 2: Both 36-char UUIDs and 64-char hex tokens auto-migrate to SHA-256 without double-hashing."""
    dev1 = Device(id=77, ip="192.168.1.77", display_name="Host 77", is_online=True)
    dev2 = Device(id=78, ip="192.168.1.78", display_name="Host 78", is_online=True)
    db.add_all([dev1, dev2])
    await db.commit()

    # Case A: 36-char legacy UUID token
    raw_uuid = "98765432-aaaa-bbbb-cccc-112233445566"
    expected_uuid_hash = hashlib.sha256(raw_uuid.encode("utf-8")).hexdigest()
    db.add(AgentToken(device_id=77, token=raw_uuid, is_active=True))

    # Case B: 64-char hex token (secrets.token_hex(32))
    raw_hex64 = secrets.token_hex(32)
    assert len(raw_hex64) == 64
    expected_hex64_hash = hashlib.sha256(raw_hex64.encode("utf-8")).hexdigest()
    db.add(AgentToken(device_id=78, token=raw_hex64, is_active=True))
    await db.commit()

    # 1. First lookup migrates both to SHA-256
    found1 = await _find_and_migrate_agent_token(db, raw_uuid, device_id=77)
    assert found1 is not None
    assert found1.token == expected_uuid_hash

    found2 = await _find_and_migrate_agent_token(db, raw_hex64, device_id=78)
    assert found2 is not None
    assert found2.token == expected_hex64_hash

    # 2. Subsequent lookup with same raw token matches hash and does NOT double-hash
    again1 = await _find_and_migrate_agent_token(db, raw_uuid, device_id=77)
    assert again1 is not None and again1.token == expected_uuid_hash

    again2 = await _find_and_migrate_agent_token(db, raw_hex64, device_id=78)
    assert again2 is not None and again2.token == expected_hex64_hash

    # 3. Invalid raw token returns None
    invalid = await _find_and_migrate_agent_token(db, "invalid-token", device_id=77)
    assert invalid is None


@pytest.mark.asyncio
async def test_websocket_rejects_out_of_scope_api_token(db):
    """Befund 1: WebSockets authenticated via query param API token enforce required scopes."""
    db.add(Setting(key="setup.complete", value="true"))
    raw_token = "gl_pat_topology_only_ws_token_12345"
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    api_token = ApiToken(
        name="Topology WebSocket Token",
        token_hash=token_hash,
        prefix=raw_token[:12],
        scopes="topology:read",
    )
    db.add(api_token)
    await db.commit()

    mock_ws = AsyncMock()
    mock_ws.query_params = {"token": raw_token}
    mock_ws.cookies = {}
    mock_ws.headers = {}

    res = await _authenticate_websocket_impl(
        mock_ws,
        endpoint_type="logs",
        device_id=None,
        db=db,
    )
    assert res.get("authenticated") is False
    mock_ws.close.assert_awaited_with(code=4003, reason="Insufficient token scopes")


@pytest.mark.asyncio
async def test_websocket_agent_auth_accepts_hashed_agent_token(db):
    """Befund 2: Agent WebSocket auth accepts raw token when AgentToken.token is stored as SHA-256 hash."""
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Device(id=88, ip="192.168.1.88", display_name="Agent 88", is_online=True))
    raw_agent_tok = secrets.token_hex(32)
    hashed_tok = hashlib.sha256(raw_agent_tok.encode("utf-8")).hexdigest()
    db.add(AgentToken(device_id=88, token=hashed_tok, is_active=True))
    await db.commit()

    mock_ws = AsyncMock()
    mock_ws.query_params = {"token": raw_agent_tok}
    mock_ws.cookies = {}
    mock_ws.headers = {}

    res = await _authenticate_websocket_impl(
        mock_ws,
        endpoint_type="agent",
        device_id=88,
        db=db,
    )
    assert res.get("authenticated") is True
    assert res.get("auth_type") == "agent"


@pytest.mark.asyncio
async def test_tofu_does_not_persist_host_key_on_failed_ssh_probe(client, db, admin_token, monkeypatch):
    """Befund 3: Failed SSH probes must not persist unauthenticated TOFU host keys in SshKnownHost."""
    device = Device(id=91, ip="192.168.1.91", display_name="Host 91", is_online=True)
    db.add(device)
    await db.commit()

    async def fake_failed_list_updates(**kwargs):
        tofu = kwargs.get("tofu_policy")
        if tofu is not None:
            tofu.captured = CapturedHostKey(
                key_type="ssh-ed25519",
                fingerprint="SHA256:untrusted_key_fp",
                public_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUntrusted",
            )
        return {"patch_manager": None, "packages": [], "error": "Authentication failed."}

    monkeypatch.setattr("app.api.agent.list_device_updates", fake_failed_list_updates)

    res = await client.post(
        "/api/agent/patches/91/query",
        json={"ssh_user": "root", "ssh_password": "wrong", "ssh_port": 22},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert res.status_code == 500

    known = (
        await db.execute(select(SshKnownHost).where(SshKnownHost.host == "192.168.1.91"))
    ).scalar_one_or_none()
    assert known is None


def test_dnf_query_escapes_package_names():
    """Befund 3: Package names in _query_dnf_updates must be shell-quoted."""
    mock_client = MagicMock()
    captured_commands = []

    def fake_exec_command(cmd, timeout=None):
        captured_commands.append(cmd)
        mock_stdout = MagicMock()
        if "dnf check-update" in cmd:
            mock_stdout.read.return_value = b"test;reboot;.x86_64  1.0.0-1  updates\n"
        else:
            mock_stdout.read.return_value = b"test;reboot 1.0.0-1\n"
        return MagicMock(), mock_stdout, MagicMock()

    mock_client.exec_command = fake_exec_command
    result = {"packages": []}

    _query_dnf_updates(mock_client, result)

    assert len(captured_commands) == 2
    batch_cmd = captured_commands[1]
    assert "rpm -q --qf" in batch_cmd
    assert "'test;reboot;'" in batch_cmd
