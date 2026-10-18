"""Regression tests: a stored agent token hash must never work as the token itself.

0.3.20 to 0.3.24 stored SHA-256 digests without a marker and fell back to a
plaintext comparison, so the stored value (DB file, volume backup) was itself
a valid agent token. Stored values are now tagged ``sha256:``; see
app.services.agent_tokens.
"""

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.api.auth import _authenticate_websocket_impl
from app.models.agent import AgentToken
from app.models.device import Device
from app.models.setting import Setting
from app.services.agent_tokens import (
    find_agent_token,
    hash_agent_token,
    match_agent_token,
    normalize_agent_tokens,
    normalize_stored_token,
)

ADMIN = {"Authorization": "Bearer test-admin-token-12345"}
# The test client connects from 127.0.0.1; devices live elsewhere so a rejected
# token cannot slip into the auto-adoption path.
DEVICE_IP = "192.168.1.60"


@pytest.fixture(autouse=True)
def clear_setting_cache():
    from app.api import agent as _agent
    _agent._setting_cache.clear()


def _digest(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _payload(device_id: int) -> dict:
    return {
        "device_id": device_id,
        "agent_version": "0.3.9",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 5.0,
        "ram": {"total_mb": 1024, "used_mb": 512, "percent": 50.0},
        "disk": [],
    }


async def _report(client, device_id: int, token: str):
    return await client.post(
        "/api/agent/report", json=_payload(device_id), headers={"Authorization": f"Bearer {token}"},
    )


async def _seed(db, device_id: int, stored: str, last_seen=None) -> None:
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Device(id=device_id, ip=DEVICE_IP, display_name=f"Agent {device_id}", is_online=True))
    db.add(AgentToken(device_id=device_id, token=stored, is_active=True, last_seen=last_seen))
    await db.commit()


async def _row(db, device_id: int) -> AgentToken:
    row = (await db.execute(select(AgentToken).where(AgentToken.device_id == device_id))).scalar_one()
    await db.refresh(row)
    return row


async def _ws_auth(db, device_id: int, token: str) -> dict:
    ws = AsyncMock()
    ws.query_params = {"token": token}
    ws.cookies = {}
    ws.headers = {}
    return await _authenticate_websocket_impl(ws, endpoint_type="agent", device_id=device_id, db=db)


# --- the reported attack ------------------------------------------------------

@pytest.mark.asyncio
async def test_tagged_hash_is_rejected_as_token_on_report(client, db):
    raw = secrets.token_hex(32)
    stored = hash_agent_token(raw)
    await _seed(db, 201, stored, last_seen=datetime.now(timezone.utc))

    for leaked in (stored, stored.removeprefix("sha256:")):
        assert (await _report(client, 201, leaked)).status_code == 401
    assert (await _row(db, 201)).token == stored  # nothing "migrated" by the attempt

    assert (await _report(client, 201, raw)).status_code == 200
    assert (await _row(db, 201)).token == stored


@pytest.mark.asyncio
async def test_untagged_hash_from_0_3_20_is_rejected_but_real_agent_stays_logged_in(client, db):
    """The exact 0.3.20-0.3.24 state: an untagged digest of a reported agent."""
    raw = secrets.token_hex(32)
    leaked = _digest(raw)
    await _seed(db, 202, leaked, last_seen=datetime.now(timezone.utc) - timedelta(minutes=1))

    assert (await _report(client, 202, leaked)).status_code == 401
    assert (await _row(db, 202)).token == leaked  # the attacker did not lock the agent out

    for _ in range(2):
        assert (await _report(client, 202, raw)).status_code == 200
    assert (await _row(db, 202)).token == "sha256:" + leaked
    assert (await _report(client, 202, leaked)).status_code == 401


@pytest.mark.asyncio
async def test_websocket_rejects_stored_hash_and_accepts_real_token(db):
    raw = secrets.token_hex(32)
    leaked = _digest(raw)
    await _seed(db, 203, leaked, last_seen=datetime.now(timezone.utc))

    assert (await _ws_auth(db, 203, leaked)).get("authenticated") is not True
    assert (await _ws_auth(db, 203, "sha256:" + leaked)).get("authenticated") is not True
    res = await _ws_auth(db, 203, raw)
    assert res.get("authenticated") is True and res.get("auth_type") == "agent"
    assert (await _row(db, 203)).token == "sha256:" + leaked


# --- legacy tokens keep working -------------------------------------------------

@pytest.mark.asyncio
async def test_legacy_plaintext_deploy_token_is_migrated(client, db):
    """SSH deploys handed out uuid4().hex; a reported agent kept it in plaintext before 0.3.20."""
    raw = "0123456789abcdef0123456789abcdef"
    await _seed(db, 204, raw, last_seen=datetime.now(timezone.utc) - timedelta(days=30))

    assert (await _report(client, 204, raw)).status_code == 200
    assert (await _row(db, 204)).token == hash_agent_token(raw)
    assert (await _report(client, 204, raw)).status_code == 200
    assert (await _report(client, 204, hash_agent_token(raw))).status_code == 401


@pytest.mark.asyncio
async def test_unreported_64_char_plaintext_from_config_download_is_migrated(client, db):
    """A config downloaded under 0.3.20-0.3.24 but installed only after the upgrade."""
    raw = secrets.token_hex(32)
    await _seed(db, 205, raw, last_seen=None)

    assert (await _report(client, 205, raw)).status_code == 200
    assert (await _row(db, 205)).token == hash_agent_token(raw)


@pytest.mark.asyncio
async def test_find_agent_token_ignores_inactive_and_unknown(db):
    raw = secrets.token_hex(32)
    await _seed(db, 206, hash_agent_token(raw))
    row = await _row(db, 206)
    row.is_active = False
    await db.commit()

    assert await find_agent_token(db, raw) is None
    assert await find_agent_token(db, "") is None
    assert await find_agent_token(db, "unknown") is None


def test_match_rules():
    raw = secrets.token_hex(32)
    tagged = hash_agent_token(raw)
    now = datetime.now(timezone.utc)
    assert match_agent_token(tagged, raw, now) == tagged
    assert match_agent_token(tagged, tagged, now) is None
    assert match_agent_token(tagged, tagged, None) is None
    assert match_agent_token(_digest(raw), raw, now) == tagged
    assert match_agent_token(_digest(raw), _digest(raw), now) is None
    assert match_agent_token(raw, raw, None) == tagged
    assert match_agent_token(None, raw, None) is None
    assert match_agent_token(tagged, "", now) is None


# --- config download never hands out a stored value -----------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("last_seen", [None, datetime(2026, 10, 1, tzinfo=timezone.utc)])
async def test_config_download_never_returns_a_stored_value(client, db, admin_token, monkeypatch, last_seen):
    raw = secrets.token_hex(32)
    # Untagged digest: the old download handed this out as "raw_token" when last_seen was empty
    stored = _digest(raw)
    db.add(Device(id=207, ip=DEVICE_IP, display_name="Agent 207", is_online=True))
    db.add(AgentToken(device_id=207, token=stored, is_active=True, last_seen=last_seen,
                      pending_token=hash_agent_token("stray")))
    db.add(Setting(key="server.url", value="http://gravity.example:9000"))
    await db.commit()
    monkeypatch.setattr("app.scanner.utils.get_local_subnets", None)

    response = await client.get("/api/agent/download/config/207", headers=ADMIN)
    assert response.status_code == 200
    handed_out = json.loads(response.text)["token"]

    row = await _row(db, 207)
    assert handed_out not in (stored, raw, row.token)
    assert not handed_out.startswith("sha256:")
    assert row.token == hash_agent_token(handed_out)
    assert row.pending_token is None
    assert (await _report(client, 207, handed_out)).status_code == 200


# --- adoption and startup migration ---------------------------------------------

@pytest.mark.asyncio
async def test_adopting_a_legacy_plaintext_pending_token_stores_its_hash(client, db, admin_token):
    pending_raw = secrets.token_hex(32)
    db.add(Device(id=208, ip=DEVICE_IP, display_name="Agent 208", is_online=True))
    # pending_token in plaintext, as written by 0.3.24 or older
    db.add(AgentToken(device_id=208, token=hash_agent_token("old"), is_active=True, pending_token=pending_raw))
    await db.commit()

    response = await client.post("/api/agent/adopt/208", headers=ADMIN)
    assert response.status_code == 200
    row = await _row(db, 208)
    assert row.token == hash_agent_token(pending_raw)
    assert (await _report(client, 208, pending_raw)).status_code == 200
    assert (await _report(client, 208, hash_agent_token(pending_raw))).status_code == 401


def test_normalize_stored_token_rules():
    raw = secrets.token_hex(32)
    seen = datetime.now(timezone.utc)
    assert normalize_stored_token(hash_agent_token(raw), seen) is None
    assert normalize_stored_token(_digest(raw), seen) == "sha256:" + _digest(raw)
    assert normalize_stored_token("98765432-aaaa-bbbb-cccc-112233445566", seen) == \
        hash_agent_token("98765432-aaaa-bbbb-cccc-112233445566")
    # Ambiguous (64 hex, never reported) stays until first use decides
    assert normalize_stored_token(raw, None) is None


@pytest.mark.asyncio
async def test_startup_migration_tags_tokens_and_keeps_agents_working(client, db):
    seen = datetime.now(timezone.utc) - timedelta(hours=1)
    hashed_raw = secrets.token_hex(32)       # 0.3.20+: untagged digest after a report
    deploy_raw = "fedcba9876543210fedcba9876543210"  # pre-0.3.20 deploy token, plaintext
    pending_raw = "pending-plaintext"
    db.add(Setting(key="setup.complete", value="true"))
    for device_id in (210, 211):
        db.add(Device(id=device_id, ip=f"192.168.1.{device_id - 100}", display_name=str(device_id), is_online=True))
    db.add(AgentToken(device_id=210, token=_digest(hashed_raw), is_active=True, last_seen=seen))
    db.add(AgentToken(device_id=211, token=deploy_raw, is_active=True, last_seen=seen, pending_token=pending_raw))
    await db.commit()

    assert await normalize_agent_tokens(db) == 3
    assert await normalize_agent_tokens(db) == 0  # idempotent
    assert (await _row(db, 210)).token == "sha256:" + _digest(hashed_raw)
    row211 = await _row(db, 211)
    assert row211.token == hash_agent_token(deploy_raw)
    assert row211.pending_token == hash_agent_token(pending_raw)

    assert (await _report(client, 210, hashed_raw)).status_code == 200
    assert (await _report(client, 211, deploy_raw)).status_code == 200
    assert (await _report(client, 210, _digest(hashed_raw))).status_code == 401
