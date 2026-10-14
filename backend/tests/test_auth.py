import hashlib

import pytest
import app.api.auth as auth_api
from app.models.api_token import ApiToken
from app.models.setting import Setting
from sqlalchemy import select

@pytest.mark.asyncio
async def test_full_auth_flow(client, db):
    """Test the complete authentication lifecycle using cookies."""
    
    # 1. Setup credentials in the test DB
    password = "testpassword123"
    token = "test-token-xyz"
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="api.admin_password", value=password))
    db.add(Setting(key="api.master_token", value=token))
    await db.commit()

    # 2. Try accessing protected endpoint (should fail)
    response = await client.get("/api/settings")
    assert response.status_code == 401

    # 3. Login
    login_res = await client.post("/api/auth/login", json={"password": password})
    assert login_res.status_code == 200
    
    # 4. Access protected endpoint WITH cookie
    settings_res = await client.get("/api/settings")
    assert settings_res.status_code == 200
    
    # 5. Logout
    logout_res = await client.post("/api/auth/logout")
    assert logout_res.status_code == 200
    
    # 6. Verify access is denied again
    final_res = await client.get("/api/settings")
    assert final_res.status_code == 401

@pytest.mark.asyncio
async def test_login_invalid_password(client, db):
    """Verify that wrong password doesn't grant access."""
    db.add(Setting(key="api.admin_password", value="secret"))
    db.add(Setting(key="api.master_token", value="some-token"))
    await db.commit()

    login_res = await client.post("/api/auth/login", json={"password": "wrongpassword"})
    assert login_res.status_code == 401

@pytest.mark.asyncio
async def test_session_channel_separation_and_expiration(client, db):
    """Verify primary and secondary authentication channels and expiration behavior."""
    from app.services.session_service import session_store
    
    # 1. Setup credentials
    password = "supersecurepassword"
    master_token = "master-token-abc"
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="api.admin_password", value=password))
    db.add(Setting(key="api.master_token", value=master_token))
    await db.commit()

    # 2. Login to get a valid session ID
    login_res = await client.post("/api/auth/login", json={"password": password})
    assert login_res.status_code == 200
    
    # Retrieve session cookie
    session_id = client.cookies.get("gravitylan_token")
    assert session_id.startswith("session_")

    # 3. Test Session ID in Cookie (Allowed - Primary Browser Channel)
    res_cookie = await client.get("/api/settings")
    assert res_cookie.status_code == 200

    # 4. Test Session ID via Authorization Header (Strictly Forbidden / 401)
    client.cookies.clear()
    res_header_session = await client.get(
        "/api/settings", 
        headers={"Authorization": f"Bearer {session_id}"}
    )
    assert res_header_session.status_code == 401

    # 5. Test Master Token via Authorization Header (Allowed - Primary External API Channel)
    res_header_master = await client.get(
        "/api/settings", 
        headers={"Authorization": f"Bearer {master_token}"}
    )
    assert res_header_master.status_code == 200

    # 6. Test Master Token via Cookie (Allowed for Deprecated Legacy Fallback)
    client.cookies.set("gravitylan_token", master_token)
    res_legacy_cookie = await client.get("/api/settings")
    assert res_legacy_cookie.status_code == 200
    client.cookies.clear()

    # 7. Test Query Param Authentication on HTTP route (Strictly Forbidden / 401)
    res_query_http = await client.get(f"/api/settings?token={session_id}")
    assert res_query_http.status_code == 401

    # 8. Test Session Expiration / Invalidation
    session_store.delete_session(session_id)
    
    # Invalid session cookie should be rejected
    client.cookies.set("gravitylan_token", session_id)
    res_expired_cookie = await client.get("/api/settings")
    assert res_expired_cookie.status_code == 401

@pytest.mark.asyncio
async def test_websocket_authentication_scenarios(db):
    """Verify all WebSocket authentication channels and fallbacks using the unified helper."""
    from app.api.auth import authenticate_websocket
    from app.services.session_service import session_store
    from app.models.agent import AgentToken
    
    # 1. Setup credentials
    password = "supersecurepassword"
    master_token = "master-token-abc"
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="api.admin_password", value=password))
    db.add(Setting(key="api.master_token", value=master_token))
    await db.commit()

    # Define a clean mock WebSocket helper
    class MockWebSocket:
        def __init__(self, cookies=None, query_params=None, headers=None, type_="websocket"):
            self.cookies = cookies or {}
            self.query_params = query_params or {}
            self.headers = headers or {}
            self.scope = {"type": type_}
            self.close_called = False
            self.close_code = None
            self.close_reason = None

        async def close(self, code=1000, reason=None):
            self.close_called = True
            self.close_code = code
            self.close_reason = reason

    # Scenario A: Setup not complete (Bypass is only allowed on 'scanner' route)
    from sqlalchemy import select
    setup_res = await db.execute(select(Setting).where(Setting.key == "setup.complete"))
    setup_setting = setup_res.scalar_one_or_none()
    if setup_setting:
        setup_setting.value = "false"
    await db.commit()

    # Scanner setup bypass allowed
    ws_bypass_scanner = MockWebSocket()
    auth_bypass_scanner = await authenticate_websocket(ws_bypass_scanner, endpoint_type="scanner", db=db)
    assert auth_bypass_scanner["authenticated"] is True
    assert auth_bypass_scanner["auth_type"] == "setup_bypass"

    # Logs setup bypass forbidden
    ws_bypass_logs = MockWebSocket()
    auth_bypass_logs = await authenticate_websocket(ws_bypass_logs, endpoint_type="logs", db=db)
    assert auth_bypass_logs["authenticated"] is False
    assert ws_bypass_logs.close_called is True
    assert ws_bypass_logs.close_code == 4003

    # Agent setup bypass forbidden
    ws_bypass_agent = MockWebSocket()
    auth_bypass_agent = await authenticate_websocket(ws_bypass_agent, endpoint_type="agent", device_id=42, db=db)
    assert auth_bypass_agent["authenticated"] is False
    assert ws_bypass_agent.close_called is True
    assert ws_bypass_agent.close_code == 4003

    # Restore setup complete
    if setup_setting:
        setup_setting.value = "true"
    await db.commit()

    # Scenario B: Browser Session via Cookie (Allowed - Primary on all routes)
    session_id = session_store.create_session(user_agent="TestAgent")
    
    ws_cookie_logs = MockWebSocket(cookies={"gravitylan_token": session_id})
    auth_cookie_logs = await authenticate_websocket(ws_cookie_logs, endpoint_type="logs", db=db)
    assert auth_cookie_logs["authenticated"] is True
    assert auth_cookie_logs["auth_type"] == "session"
    assert auth_cookie_logs["identity"] == session_id

    ws_cookie_scanner = MockWebSocket(cookies={"gravitylan_token": session_id})
    auth_cookie_scanner = await authenticate_websocket(ws_cookie_scanner, endpoint_type="scanner", db=db)
    assert auth_cookie_scanner["authenticated"] is True

    # Scenario C: Invalid Session Cookie (Rejected with 4003)
    ws_invalid_cookie = MockWebSocket(cookies={"gravitylan_token": "session_invalid"})
    auth_invalid_cookie = await authenticate_websocket(ws_invalid_cookie, endpoint_type="logs", db=db)
    assert auth_invalid_cookie["authenticated"] is False
    assert ws_invalid_cookie.close_called is True
    assert ws_invalid_cookie.close_code == 4003

    # Scenario D: Session ID via Query Parameter (Strictly Forbidden Globally)
    ws_query_session = MockWebSocket(query_params={"token": session_id})
    auth_query_session = await authenticate_websocket(ws_query_session, endpoint_type="logs", db=db)
    assert auth_query_session["authenticated"] is False
    assert ws_query_session.close_called is True
    assert ws_query_session.close_code == 4003

    # Scenario E: Master Token via Query Parameter (Allowed ONLY on 'logs' route)
    # Logs allows it
    ws_query_master_logs = MockWebSocket(query_params={"token": master_token})
    auth_query_master_logs = await authenticate_websocket(ws_query_master_logs, endpoint_type="logs", db=db)
    assert auth_query_master_logs["authenticated"] is True
    assert auth_query_master_logs["auth_type"] == "master"
    assert auth_query_master_logs["identity"] == master_token

    # Scanner route allows query master token
    ws_query_master_scanner = MockWebSocket(query_params={"token": master_token})
    auth_query_master_scanner = await authenticate_websocket(ws_query_master_scanner, endpoint_type="scanner", db=db)
    assert auth_query_master_scanner["authenticated"] is True
    assert auth_query_master_scanner["auth_type"] == "master"
    assert auth_query_master_scanner["identity"] == master_token

    # Scenario F: Agent Token (Allowed ONLY on 'agent' route with device_id matching)
    from app.models.device import Device
    db.add(Device(id=42, ip="192.168.1.42", display_name="Test Device 42"))
    agent_token = "agent-token-xyz"
    db.add(AgentToken(device_id=42, token=agent_token, is_active=True))
    await db.commit()

    # Logs route rejects agent token
    ws_agent_logs = MockWebSocket(query_params={"token": agent_token})
    auth_agent_logs = await authenticate_websocket(ws_agent_logs, endpoint_type="logs", db=db)
    assert auth_agent_logs["authenticated"] is False

    # Agent route with device_id and matching token accepts it
    ws_agent_ok = MockWebSocket(query_params={"token": agent_token})
    auth_agent_ok = await authenticate_websocket(ws_agent_ok, endpoint_type="agent", device_id=42, db=db)
    assert auth_agent_ok["authenticated"] is True
    assert auth_agent_ok["auth_type"] == "agent"

    # Agent route with wrong device_id rejects it
    ws_agent_wrong_dev = MockWebSocket(query_params={"token": agent_token})
    auth_agent_wrong_dev = await authenticate_websocket(ws_agent_wrong_dev, endpoint_type="agent", device_id=99, db=db)
    assert auth_agent_wrong_dev["authenticated"] is False
    assert ws_agent_wrong_dev.close_called is True
    assert ws_agent_wrong_dev.close_code == 4003

    # Scenario G: Legacy Cookie Fallback (Allowed with Warning on all endpoints)
    ws_legacy = MockWebSocket(cookies={"gravitylan_token": master_token})
    auth_legacy = await authenticate_websocket(ws_legacy, endpoint_type="logs", db=db)
    assert auth_legacy["authenticated"] is True
    assert auth_legacy["auth_type"] == "master_legacy"

    # Scenario H: Missing Token altogether (Rejected with 4001)
    ws_missing = MockWebSocket()
    auth_missing = await authenticate_websocket(ws_missing, endpoint_type="logs", db=db)
    assert auth_missing["authenticated"] is False
    assert ws_missing.close_called is True
    assert ws_missing.close_code == 4001

    # Scenario I: Master Token via Query Parameter on Agent Route (Allowed - Universal Admin Fallback)
    ws_query_master_agent = MockWebSocket(query_params={"token": master_token})
    auth_query_master_agent = await authenticate_websocket(ws_query_master_agent, endpoint_type="agent", device_id=42, db=db)
    assert auth_query_master_agent["authenticated"] is True
    assert auth_query_master_agent["auth_type"] == "master"
    assert auth_query_master_agent["identity"] == master_token


# --- Scopes ---------------------------------------------------------------------

def test_webhook_test_endpoint_needs_write_scope_even_for_get():
    assert auth_api._required_scope_for("/api/webhooks/test", "GET") == "settings:write"
    assert auth_api._required_scope_for("/api/webhooks/test/", "GET") == "settings:write"
    assert auth_api._required_scope_for("/api/webhooks/test", "POST") == "settings:write"
    assert auth_api._required_scope_for("/api/webhooks", "GET") == "settings:read"


@pytest.mark.asyncio
async def test_read_only_token_cannot_fire_test_webhooks(client, db, admin_token):
    raw = "gl_pat_settings_read_only"
    db.add(ApiToken(name="ro", token_hash=hashlib.sha256(raw.encode()).hexdigest(),
                    prefix="gl_pat_set...", is_active=True, scopes="settings:read"))
    await db.commit()
    headers = {"Authorization": f"Bearer {raw}"}

    assert (await client.get("/api/webhooks", headers=headers)).status_code == 200
    assert (await client.get("/api/webhooks/test", headers=headers)).status_code == 403
