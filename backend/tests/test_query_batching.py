"""List endpoints load related rows in batches, not one query per listed item (N+1)."""

import re
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from sqlalchemy import event

from app.models.agent import AgentToken
from app.models.device import Device
from app.models.ssh import SshHistory, SshKey, SshProfile
from app.services.cache_service import dashboard_cache

ITEMS = 6


@contextmanager
def count_selects(db):
    """Collect the table each SELECT statement reads from (FROM <table>)."""
    tables: list[str] = []

    def before_execute(conn, cursor, statement, parameters, context, executemany):
        match = re.search(r"\bFROM (\w+)", statement)
        if statement.lstrip().upper().startswith("SELECT") and match:
            tables.append(match.group(1))

    sync_engine = db.bind.sync_engine
    event.listen(sync_engine, "before_cursor_execute", before_execute)
    try:
        yield tables
    finally:
        event.remove(sync_engine, "before_cursor_execute", before_execute)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_list_devices_batches_agent_tokens_and_parents(client, db, admin_token):
    hidden_parent = Device(ip="10.0.0.1", display_name="hidden-host", is_hidden=True)
    db.add(hidden_parent)
    await db.flush()
    devices = [
        Device(ip=f"10.0.0.{i + 10}", display_name=f"dev{i}", parent_id=hidden_parent.id)
        for i in range(ITEMS)
    ]
    db.add_all(devices)
    await db.flush()
    db.add_all([AgentToken(device_id=d.id, token=f"token-{d.id}", agent_version="0.3.5") for d in devices[::2]])
    await db.commit()
    dashboard_cache.invalidate_all()

    with count_selects(db) as tables:
        response = await client.get("/api/devices", headers=_auth(admin_token))

    assert response.status_code == 200
    body = {d["display_name"]: d for d in response.json()}
    assert len(body) == ITEMS
    assert body["dev0"]["has_agent"] is True
    assert body["dev1"]["has_agent"] is False
    assert all(d["parent_name"] == "hidden-host" for d in body.values())
    # One query for the device list, one for parents outside it, one for all agent tokens
    assert tables.count("agent_tokens") == 1
    assert tables.count("devices") == 2


async def _seed_ssh(db):
    devices = [Device(ip=f"10.1.0.{i + 1}", display_name=f"host{i}") for i in range(ITEMS)]
    keys = [
        SshKey(name=f"key{i}", key_type="ssh-ed25519", fingerprint=f"SHA256:{i}",
               public_key=f"ssh-ed25519 AAAA{i}", encrypted_private_key="x")
        for i in range(ITEMS)
    ]
    db.add_all(devices + keys)
    await db.flush()
    now = datetime.now(timezone.utc)
    for i, (device, key) in enumerate(zip(devices, keys)):
        db.add(SshProfile(name=f"profile{i}", device_id=device.id, username="root", auth_method="key", key_id=key.id))
        db.add(SshHistory(device_id=device.id, port=22, username="root", auth_method="key", key_id=key.id, last_used_at=now))
    await db.commit()
    # Fresh identity map: otherwise db.get() would answer from memory and hide the N+1
    db.expunge_all()


@pytest.mark.asyncio
async def test_list_ssh_profiles_batches_devices_and_keys(client, db, admin_token):
    await _seed_ssh(db)

    with count_selects(db) as tables:
        response = await client.get("/api/ssh/profiles", headers=_auth(admin_token))

    assert response.status_code == 200
    profiles = response.json()
    assert len(profiles) == ITEMS
    assert {p["device_name"] for p in profiles} == {f"host{i}" for i in range(ITEMS)}
    assert {p["key_name"] for p in profiles} == {f"key{i}" for i in range(ITEMS)}
    assert tables.count("devices") == 1
    assert tables.count("ssh_keys") == 1


@pytest.mark.asyncio
async def test_list_ssh_history_batches_devices_and_keys(client, db, admin_token):
    await _seed_ssh(db)

    with count_selects(db) as tables:
        response = await client.get("/api/ssh/history", headers=_auth(admin_token))

    assert response.status_code == 200
    entries = response.json()
    assert len(entries) == ITEMS
    assert all(e["label"].startswith("root@host") for e in entries)
    assert {e["key_name"] for e in entries} == {f"key{i}" for i in range(ITEMS)}
    assert tables.count("devices") == 1
    assert tables.count("ssh_keys") == 1
