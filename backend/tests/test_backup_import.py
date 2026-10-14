"""Backup import: protected settings, excluded agent tokens, all-or-nothing transaction."""

import json
import sqlite3

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api import backup
from app.config import settings as app_config
from app.database import Base
from app.models.agent import AgentToken
from app.models.device import Device, DeviceGroup
from app.models.setting import Setting

PROTECTED = {
    "api.master_token": "current-master-token",
    "api.admin_password": "$argon2id$current-hash",
    "setup.complete": "true",
}


@pytest.fixture
def backup_db(tmp_path):
    """A file-based SQLite database with the full schema and a running instance's state."""
    path = tmp_path / "gravitylan.db"
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        for key, value in PROTECTED.items():
            s.add(Setting(key=key, value=value))
        s.add(Setting(key="scan_interval", value="5"))
        s.add(DeviceGroup(id=1, name="Servers"))
        s.add(Device(id=1, ip="10.0.0.1", display_name="nas"))
        s.flush()
        s.add(AgentToken(device_id=1, token="live-agent-token"))
        s.commit()
    engine.dispose()
    return str(path)


def _query(db_path, sql):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def _settings(db_path) -> dict:
    return dict(_query(db_path, "SELECT key, value FROM app_settings"))


def test_agent_tokens_not_importable():
    assert "agent_tokens" not in backup.ALLOWED_TABLE_MAP


def test_import_keeps_protected_settings(backup_db):
    data = {
        "settings": [
            # ids collide with the protected rows that stay in the table
            {"id": 1, "key": "api.master_token", "value": "attacker-token", "category": "general"},
            {"id": 2, "key": "api.admin_password", "value": "", "category": "system"},
            {"id": 3, "key": "setup.complete", "value": "false", "category": "system"},
            {"id": 4, "key": "scan_interval", "value": "30", "category": "scan"},
            {"id": 5, "key": "theme", "value": "dark", "category": "ui"},
        ],
    }

    backup._write_db(backup_db, data)

    stored = _settings(backup_db)
    for key, value in PROTECTED.items():
        assert stored[key] == value
    assert stored["scan_interval"] == "30"
    assert stored["theme"] == "dark"


def test_import_without_protected_keys_does_not_delete_them(backup_db):
    backup._write_db(backup_db, {"settings": [{"key": "scan_interval", "value": "15", "category": "scan"}]})

    stored = _settings(backup_db)
    for key, value in PROTECTED.items():
        assert stored[key] == value
    assert stored["scan_interval"] == "15"


def test_import_ignores_agent_tokens(backup_db):
    data = {
        "devices": [{"id": 1, "ip": "10.0.0.1", "display_name": "nas"}],
        "agent_tokens": [{"id": 99, "device_id": 1, "token": "stolen-token", "is_active": 1}],
    }

    imported = backup._write_db(backup_db, data)

    assert "agent_tokens" not in imported
    assert _query(backup_db, "SELECT token FROM agent_tokens") == [("live-agent-token",)]


def test_failed_import_rolls_back_everything(backup_db):
    data = {
        # Processed first: deleted and re-inserted before the error below
        "device_groups": [{"id": 10, "name": "Replaced"}],
        "settings": [{"key": "scan_interval", "value": "99", "category": "scan"}],
        # Duplicate unique ip -> IntegrityError halfway through the import
        "devices": [
            {"id": 2, "ip": "10.0.0.2", "display_name": "a"},
            {"id": 3, "ip": "10.0.0.2", "display_name": "b"},
        ],
    }

    with pytest.raises(sqlite3.IntegrityError):
        backup._write_db(backup_db, data)

    assert _query(backup_db, "SELECT name FROM device_groups") == [("Servers",)]
    assert _query(backup_db, "SELECT ip FROM devices") == [("10.0.0.1",)]
    assert _settings(backup_db)["scan_interval"] == "5"
    # The database is not left locked by an open transaction
    backup._write_db(backup_db, {"settings": [{"key": "scan_interval", "value": "7", "category": "scan"}]})
    assert _settings(backup_db)["scan_interval"] == "7"


# --- endpoint -----------------------------------------------------------------

@pytest.fixture
def import_endpoint_db(backup_db, monkeypatch):
    monkeypatch.setattr(app_config, "database_url", f"sqlite+aiosqlite:///{backup_db}")
    return backup_db


async def _post_backup(client, admin_token, payload: bytes):
    return await client.post(
        "/api/backup/import",
        files={"file": ("backup.json", payload, "application/json")},
        headers={"Authorization": f"Bearer {admin_token}"},
    )


@pytest.mark.asyncio
async def test_import_endpoint_success(client, admin_token, import_endpoint_db):
    payload = json.dumps({
        "metadata": {"version": "0.1.0"},
        "settings": [{"key": "api.master_token", "value": "attacker"}, {"key": "scan_interval", "value": "20"}],
    }).encode()

    response = await _post_backup(client, admin_token, payload)

    assert response.status_code == 200
    stored = _settings(import_endpoint_db)
    assert stored["api.master_token"] == PROTECTED["api.master_token"]
    assert stored["scan_interval"] == "20"


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [b"not json", b"[1, 2]", b'{"devices": {"ip": "x"}}', b'{"devices": [1]}'])
async def test_import_endpoint_rejects_malformed_backup(client, admin_token, import_endpoint_db, payload):
    response = await _post_backup(client, admin_token, payload)
    assert response.status_code == 400
    assert _query(import_endpoint_db, "SELECT ip FROM devices") == [("10.0.0.1",)]


@pytest.mark.asyncio
async def test_import_endpoint_failure_leaves_database_unchanged(client, admin_token, import_endpoint_db):
    payload = json.dumps({
        "device_groups": [{"id": 10, "name": "Replaced"}],
        "devices": [{"id": 2, "ip": "10.0.0.2"}, {"id": 3, "ip": "10.0.0.2"}],
    }).encode()

    response = await _post_backup(client, admin_token, payload)

    assert response.status_code == 500
    assert "no changes were made" in response.json()["detail"]
    assert _query(import_endpoint_db, "SELECT name FROM device_groups") == [("Servers",)]
