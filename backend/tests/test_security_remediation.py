"""Automated security remediation regression tests (Befunde 1, 2, 3)."""

import hashlib
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.agent import _find_and_migrate_agent_token
from app.api.auth import _authenticate_websocket_impl
from app.models.agent import AgentToken
from app.models.api_token import ApiToken
from app.models.device import Device
from app.models.setting import Setting
from app.services.patch_service import _query_dnf_updates


@pytest.mark.asyncio
async def test_readonly_api_token_cannot_download_agent_config(client, db):
    """Befund 1: Read-only API tokens must not be able to export agent configurations."""
    # Setup test device
    device = Device(id=42, ip="192.168.1.42", display_name="Test Host", is_online=True)
    db.add(device)
    db.add(Setting(key="setup.complete", value="true"))

    # Create an API token with read-only scopes
    raw_token = "gl_pat_readonly_token_123456789012345"
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    api_token = ApiToken(
        name="Readonly Token",
        token_hash=token_hash,
        prefix=raw_token[:12],
        scopes=json.dumps(["agent:read", "topology:read"]),
    )
    db.add(api_token)
    await db.commit()

    # Attempt to download agent config using the read-only API token
    res = await client.get(
        "/api/agent/download/config/42",
        headers={"Authorization": f"Bearer {raw_token}"},
    )

    # Must be forbidden with 403 status code
    assert res.status_code == 403
    assert "not authorized" in res.text.lower()


@pytest.mark.asyncio
async def test_agent_token_hashed_and_legacy_auto_migrated(db):
    """Befund 2: Agent tokens are stored as SHA-256 hashes with auto-migration of legacy tokens."""
    # 0. Seed device for foreign key
    device = Device(id=77, ip="192.168.1.77", display_name="Host 77", is_online=True)
    db.add(device)
    await db.commit()

    raw_token = "98765432-aaaa-bbbb-cccc-112233445566"
    expected_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    # 1. Seed legacy plaintext token
    agent_tok = AgentToken(
        device_id=77,
        token=raw_token,
        is_active=True,
    )
    db.add(agent_tok)
    await db.commit()

    # 2. Look up token: should find it and auto-migrate to SHA-256
    found = await _find_and_migrate_agent_token(db, raw_token, device_id=77)
    assert found is not None
    assert found.token == expected_hash
    assert len(found.token) == 64

    # 3. Subsequent lookup using the same raw token still works
    found2 = await _find_and_migrate_agent_token(db, raw_token, device_id=77)
    assert found2 is not None
    assert found2.id == found.id
    assert found2.token == expected_hash

    # 4. Invalid raw token returns None
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

    # Attempt to authenticate logs endpoint (which requires settings:read scope)
    res = await _authenticate_websocket_impl(
        mock_ws,
        endpoint_type="logs",
        device_id=None,
        db=db,
    )
    assert res.get("authenticated") is False
    mock_ws.close.assert_awaited_with(code=4003, reason="Insufficient token scopes")


def test_dnf_query_escapes_package_names():
    """Befund 3: Package names in _query_dnf_updates must be shell-quoted."""
    mock_client = MagicMock()
    captured_commands = []

    def fake_exec_command(cmd, timeout=None):
        captured_commands.append(cmd)
        mock_stdout = MagicMock()
        if "dnf check-update" in cmd:
            # Package name containing shell injection characters
            mock_stdout.read.return_value = b"test;reboot;.x86_64  1.0.0-1  updates\n"
        else:
            mock_stdout.read.return_value = b"test;reboot 1.0.0-1\n"
        return MagicMock(), mock_stdout, MagicMock()

    mock_client.exec_command = fake_exec_command
    result = {"packages": []}

    _query_dnf_updates(mock_client, result)

    assert len(captured_commands) == 2
    # Second command should be the batch rpm command with quoted package name
    batch_cmd = captured_commands[1]
    assert "rpm -q --qf" in batch_cmd
    assert "'test;reboot;'" in batch_cmd
