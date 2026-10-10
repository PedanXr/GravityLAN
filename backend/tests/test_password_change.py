"""Changing the admin password (POST /api/auth/password) and protecting it in /api/settings."""

import pytest
from sqlalchemy import select

from app.models.setting import Setting
from app.services.auth_service import hash_password, looks_hashed, verify_password
from app.services.session_service import session_store

OLD = "old-password-1"
NEW = "new-password-2"
MASTER = "master-token-xyz"


@pytest.fixture
async def logged_in(client, db):
    """Admin with a hashed password, logged in through the browser login (session cookie)."""
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="api.admin_password", value=hash_password(OLD)))
    db.add(Setting(key="api.master_token", value=MASTER))
    await db.commit()
    res = await client.post("/api/auth/login", json={"password": OLD})
    assert res.status_code == 200
    return client.cookies.get("gravitylan_token")


async def _stored_hash(db) -> str:
    db.expire_all()
    return (await db.execute(select(Setting).where(Setting.key == "api.admin_password"))).scalar_one().value


@pytest.mark.asyncio
async def test_change_password_logs_out_other_sessions(client, db, logged_in):
    other_session = session_store.create_session(user_agent="phone")

    res = await client.post("/api/auth/password", json={"current_password": OLD, "new_password": NEW})

    assert res.status_code == 200, res.text
    assert res.json()["other_sessions_ended"] >= 1
    stored = await _stored_hash(db)
    assert looks_hashed(stored) and verify_password(NEW, stored)
    assert session_store.get_session(other_session) is None
    # The session that changed the password stays logged in
    assert session_store.get_session(logged_in) is not None
    assert (await client.post("/api/auth/check")).status_code == 200

    client.cookies.clear()
    assert (await client.post("/api/auth/login", json={"password": OLD})).status_code == 401
    assert (await client.post("/api/auth/login", json={"password": NEW})).status_code == 200


@pytest.mark.asyncio
async def test_change_password_needs_the_current_password(client, db, logged_in):
    before = await _stored_hash(db)

    res = await client.post("/api/auth/password", json={"current_password": "wrong", "new_password": NEW})
    assert res.status_code == 400  # not 401: a typo must not look like "logged out"
    assert "current password" in res.json()["detail"]

    res = await client.post("/api/auth/password", json={"current_password": OLD, "new_password": OLD})
    assert res.status_code == 400

    res = await client.post("/api/auth/password", json={"current_password": OLD, "new_password": "short"})
    assert res.status_code == 422

    assert await _stored_hash(db) == before
    assert session_store.get_session(logged_in) is not None


@pytest.mark.asyncio
async def test_change_password_requires_a_browser_session(client, db, logged_in):
    client.cookies.clear()
    res = await client.post(
        "/api/auth/password",
        json={"current_password": OLD, "new_password": NEW},
        headers={"Authorization": f"Bearer {MASTER}"},
    )
    assert res.status_code == 403

    client.cookies.clear()
    res = await client.post("/api/auth/password", json={"current_password": OLD, "new_password": NEW})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_change_password_from_legacy_plaintext(client, db):
    """Older installs may still hold the password in plain text: it is checked and replaced by a hash."""
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="api.admin_password", value=OLD))
    db.add(Setting(key="api.master_token", value=MASTER))
    await db.commit()
    # Log in via a session created directly, so the login's own plaintext migration does not run first
    client.cookies.set("gravitylan_token", session_store.create_session(user_agent=None))

    res = await client.post("/api/auth/password", json={"current_password": OLD, "new_password": NEW})

    assert res.status_code == 200, res.text
    assert verify_password(NEW, await _stored_hash(db))


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["api.admin_password", "api.master_token"])
async def test_settings_endpoint_cannot_write_credentials(client, db, logged_in, key):
    before = await _stored_hash(db)

    res = await client.post("/api/settings", json={key: "overwritten", "scan_interval": "5"})

    assert res.status_code == 400
    assert key in res.json()["detail"]
    assert await _stored_hash(db) == before
    # Nothing of the request was applied
    assert (await db.execute(select(Setting).where(Setting.key == "scan_interval"))).scalar_one_or_none() is None


def test_delete_all_except_keeps_one_session():
    keep = session_store.create_session(user_agent=None)
    others = [session_store.create_session(user_agent=None) for _ in range(2)]

    ended = session_store.delete_all_except(keep)

    assert ended >= 2
    assert session_store.get_session(keep) is not None
    assert all(session_store.get_session(s) is None for s in others)
