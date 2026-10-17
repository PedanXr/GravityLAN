import hashlib
import math
import secrets
import time
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Body, Response, Request, Header, WebSocket, Query
from fastapi.requests import HTTPConnection
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models.setting import Setting
from app.config import settings
import logging

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

from app.services.auth_service import hash_password, verify_password, looks_hashed, secure_compare
from app.services.session_service import session_store
from app.services.agent_telemetry import _setting_cache

def _required_scope_for(path: str, method: str) -> str | None:
    """Map an API path/method to the scope a read-only token needs."""
    read_methods = ("GET", "HEAD")
    if path.startswith("/api/devices") or path.startswith("/api/groups") or path.startswith("/api/services"):
        return "devices:read" if method in read_methods else "devices:write"
    if path.startswith("/api/topology"):
        return "topology:read" if method in read_methods else "topology:write"
    if path.startswith("/api/network"):
        return "network:read" if method in read_methods else "network:write"
    if path.startswith("/api/agent"):
        if path.startswith("/api/agent/download/config") or path.startswith("/api/agent/token") or path.startswith("/api/agent/enroll"):
            return "agent:write"
        return "agent:read" if method in read_methods else "agent:write"
    if path.startswith("/api/settings"):
        return "settings:read" if method in read_methods else "settings:write"
    if path.startswith("/api/backup"):
        return "backup:read" if method in read_methods else "backup:write"
    if path.startswith("/api/scanner"):
        return "scanner:read" if method in read_methods else "scanner:start"
    if path.startswith("/api/webhooks"):
        # /test posts to every subscriber, so even its GET variant needs write access
        if path.rstrip("/") == "/api/webhooks/test":
            return "settings:write"
        return "settings:read" if method in read_methods else "settings:write"
    if path.startswith("/api/summary") or path.startswith("/api/issues"):
        return "devices:read"  # summary/issues require general read permission
    if path.startswith("/api/auth/tokens") or path.startswith("/api/logs"):
        return "settings:read" if method in read_methods else "settings:write"
    if path.startswith("/api/agents"):
        return "agent:read" if method in read_methods else "agent:write"
    if path.startswith("/api/scan-profiles"):
        return "scanner:read" if method in read_methods else "scanner:start"
    if path.startswith("/api/notifications") or path.startswith("/api/health"):
        return "devices:read" if method in read_methods else "devices:write"
    return None


_READONLY_FORBIDDEN_PATHS = ("/api/backup/export", "/api/settings/reset-db")
_READONLY_DEFAULT_SCOPES = {
    "devices:read", "topology:read", "network:read", "agent:read",
    "settings:read", "backup:read", "scanner:read"
}

# Routes the first-run wizard calls before any admin credential exists.
# Everything else stays closed until setup.complete is set (fresh install or
# after a factory reset), so an unconfigured instance cannot be exported,
# reconfigured or used to deploy agents by anyone on the LAN.
_SETUP_WIZARD_ROUTES = frozenset({
    ("GET", "/api/scanner/subnets"),
    ("GET", "/api/scanner/discovered"),
    ("POST", "/api/scanner/start"),
    ("POST", "/api/scanner/stop"),
    ("WEBSOCKET", "/api/scanner/ws"),
})


def _is_setup_wizard_route(conn: HTTPConnection) -> bool:
    """Return True when the request targets a route the setup wizard needs."""
    method = conn.scope.get("method") or conn.scope.get("type", "").upper()
    return (method, conn.url.path) in _SETUP_WIZARD_ROUTES


async def _verify_api_token(db: AsyncSession, token_val: str, conn: HTTPConnection) -> str:
    """Validate a read-only API token, enforce scopes, and update last_used_at."""
    h = hashlib.sha256(token_val.encode()).hexdigest()
    from app.models.api_token import ApiToken
    token_res = await db.execute(select(ApiToken).where(ApiToken.token_hash == h, ApiToken.is_active == True))
    db_token = token_res.scalar_one_or_none()

    if not db_token:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    _enforce_token_scopes(db_token, conn)

    # Update last_used_at timestamp with throttling
    try:
        now = datetime.now(timezone.utc)
        last_used = db_token.last_used_at
        if last_used and last_used.tzinfo is None:
            last_used = last_used.replace(tzinfo=timezone.utc)
        if not last_used or (now - last_used).total_seconds() > 60:
            db_token.last_used_at = now
            await db.commit()
    except Exception as e:
        logger.error(f"Failed to update API token last_used_at: {e}")
        await db.rollback()

    return f"api_token:{db_token.name}"


def _enforce_token_scopes(db_token, conn: HTTPConnection) -> None:
    """Enforce scope rules for a read-only API token on HTTP requests."""
    if db_token.scopes:
        token_scopes = {s.strip() for s in db_token.scopes.split(",") if s.strip()}
    else:
        token_scopes = _READONLY_DEFAULT_SCOPES

    if conn.scope.get("type") != "http":
        return

    method = conn.method
    path = conn.url.path

    # Exclude path /api/auth/check and /api/auth/me from strict scoping
    if path in ("/api/auth/check", "/api/auth/me"):
        return

    # Block read-only token from accessing sensitive admin/export, token-management, SSH or sensitive agent endpoints
    if (
        path in _READONLY_FORBIDDEN_PATHS
        or path.startswith("/api/auth/tokens")
        or path.startswith("/api/ssh")
        or path.startswith("/api/agent/download/config")
        or path.startswith("/api/agent/enroll")
        or path.startswith("/api/agent/adopt")
        or path.startswith("/api/agent/deploy")
        or path.startswith("/api/agent/uninstall")
        or path.startswith("/api/agent/patches")
    ):
        raise HTTPException(
            status_code=403,
            detail="Read-only token is not authorized for this administrative action. Token is not authorized for sensitive administrative actions."
        )

    required_scope = _required_scope_for(path, method)
    if required_scope and required_scope not in token_scopes:
        if method not in ("GET", "HEAD"):
            raise HTTPException(
                status_code=403,
                detail=f"Read-only token cannot perform state-modifying actions. Token is missing the required scope '{required_scope}'."
            )
        raise HTTPException(
            status_code=403,
            detail=f"Token is missing the required scope '{required_scope}'."
        )


async def _authenticate_query_param(db: AsyncSession, token: str, conn: HTTPConnection) -> str:
    """Authenticate via query parameter (WebSockets ONLY)."""
    is_websocket = conn.scope.get("type") == "websocket"
    if not is_websocket:
        logger.warning("Security Warning: Attempted query parameter authentication on non-WebSocket route. Blocked.")
        raise HTTPException(
            status_code=401,
            detail="Query parameter authentication is restricted to WebSockets."
        )

    if token.startswith("session_"):
        session = session_store.get_session(token)
        if session:
            return token
    else:
        res_token = await db.execute(select(Setting).where(Setting.key == "api.master_token"))
        master_setting = res_token.scalar_one_or_none()
        if master_setting and secure_compare(token, master_setting.value):
            return token
    raise HTTPException(status_code=401, detail="Invalid or expired token")


async def get_current_admin(
    conn: HTTPConnection,
    authorization: str | None = Header(None),
    token: str | None = Query(None),
    db: AsyncSession = Depends(get_db)
) -> str:
    """
    Dependency to validate authentication via Cookie, Authorization header, or Query param.
    Works for both HTTP Requests and WebSockets.
    """
    # 0. Before setup is complete no credentials exist: only the wizard's routes are open
    from app.models.setting import Setting
    setup_res = await db.execute(select(Setting).where(Setting.key == "setup.complete"))
    setup_setting = setup_res.scalar_one_or_none()
    is_setup_done = setup_setting is not None and setup_setting.value == "true"

    if not is_setup_done:
        if _is_setup_wizard_route(conn):
            return "setup_mode"
        raise HTTPException(status_code=403, detail="Initial setup not completed.")

    # 1. Try Browser Cookie (Primary channel for Browser sessions)
    cookie_token = conn.cookies.get("gravitylan_token")
    if cookie_token:
        if cookie_token.startswith("session_"):
            session = session_store.get_session(cookie_token)
            if session:
                # Weak plausibility check for User-Agent (not a hard security guarantee)
                req_ua = conn.headers.get("user-agent")
                if session.user_agent and req_ua and session.user_agent != req_ua:
                    logger.warning("Session User-Agent mismatch: expected '%s', got '%s'", session.user_agent, req_ua)
                return cookie_token
            raise HTTPException(status_code=401, detail="Session expired or invalid")
        else:
            # Deprecated Legacy Cookie Fallback (Master-Token in Cookie)
            res_token = await db.execute(select(Setting).where(Setting.key == "api.master_token"))
            master_setting = res_token.scalar_one_or_none()
            if master_setting and secure_compare(cookie_token, master_setting.value):
                logger.warning(
                    "DEPRECATION WARNING: Master-Token used in browser cookie. "
                    "This legacy authentication path is deprecated and will be removed in a future release."
                )
                return cookie_token
            raise HTTPException(status_code=401, detail="Invalid token")

    # 2. Try Authorization Header (Primary channel for external API/Agent calls)
    if authorization and authorization.startswith("Bearer "):
        token_val = authorization.removeprefix("Bearer ").strip()
        # Strictly reject Session IDs in the Authorization Header
        if token_val.startswith("session_"):
            logger.warning("Security Warning: Session ID submitted in Authorization Header. Rejected.")
            raise HTTPException(
                status_code=401,
                detail="Invalid authentication method. Session IDs are only accepted via cookies."
            )
        
        # A. Check Master-Token
        res_token = await db.execute(select(Setting).where(Setting.key == "api.master_token"))
        master_setting = res_token.scalar_one_or_none()
        if master_setting and secure_compare(token_val, master_setting.value):
            return token_val

        # B. Check Read-Only API Tokens
        return await _verify_api_token(db, token_val, conn)

    # 3. Special Fallback Channel: Query Parameter (WebSockets ONLY)
    if token:
        return await _authenticate_query_param(db, token, conn)

    raise HTTPException(status_code=401, detail="Missing authentication token")

async def authenticate_websocket(
    websocket: WebSocket,
    endpoint_type: str,  # "logs" (Logs), "scanner" (Scan Status), "agent" (Agent metrics)
    device_id: int | None = None,
    db: AsyncSession | None = None
) -> dict:
    """
    Centralized, secure helper to authenticate WebSocket connections.
    Enforces strict endpoint classification and channel policies.
    
    Supports:
    1. Browser-based clients: Authenticates via 'gravitylan_token' cookie (Session ID).
    2. External scripts / CLI: Authenticates via 'token' query parameter (Master Token, ONLY on 'logs' endpoints).
    3. Specialized Agents: Authenticates via 'token' query parameter (Agent Token, ONLY on 'agent' endpoints).
    4. Setup Bypass: Allowed ONLY on 'scanner' endpoints during initial configuration.
    
    Returns:
        dict: A dictionary containing auth info:
            {
                "authenticated": bool,
                "auth_type": "session" | "master" | "agent" | "master_legacy" | "setup_bypass",
                "identity": str
            }
    """
    if db is None:
        from app.database import async_session
        async with async_session() as session_ctx:
            return await _authenticate_websocket_impl(websocket, endpoint_type, device_id, session_ctx)
    else:
        return await _authenticate_websocket_impl(websocket, endpoint_type, device_id, db)


async def authenticate_websocket_authorized(
    websocket: WebSocket,
    endpoint_type: str,
    allowed_levels: tuple[str, ...] = ("session", "master", "master_legacy", "api_token"),
    device_id: int | None = None,
) -> dict | None:
    """
    Authenticate a WebSocket and enforce an authorization level.

    Returns the auth info dict when the client is authenticated AND the
    auth type is allowed, otherwise closes the connection and returns None.
    """
    auth_info = await authenticate_websocket(websocket, endpoint_type=endpoint_type, device_id=device_id)
    if not auth_info.get("authenticated"):
        return None
    if auth_info.get("auth_type") not in allowed_levels:
        await websocket.close(code=4003, reason="Unauthorized access level")
        return None
    return auth_info

async def _touch_api_token(db: AsyncSession, db_token) -> None:
    """Throttled last_used_at update for an API token."""
    try:
        now = datetime.now(timezone.utc)
        last_used = db_token.last_used_at
        if last_used and last_used.tzinfo is None:
            last_used = last_used.replace(tzinfo=timezone.utc)
        if not last_used or (now - last_used).total_seconds() > 60:
            db_token.last_used_at = now
            await db.commit()
    except Exception as e:
        logger.error(f"Failed to update WebSocket API token last_used_at: {e}")
        await db.rollback()


async def _load_master_token(db: AsyncSession) -> str | None:
    """Fetch the configured master token (or None when unset)."""
    from app.models.setting import Setting
    from sqlalchemy import select
    master_res = await db.execute(select(Setting).where(Setting.key == "api.master_token"))
    master_setting = master_res.scalar_one_or_none()
    return master_setting.value if master_setting else None


def _auth_result(auth_type: str, identity: str) -> dict:
    """Build a successful websocket auth result dict."""
    return {"authenticated": True, "auth_type": auth_type, "identity": identity}


async def _auth_reject(websocket: WebSocket, reason: str = "Unauthorized") -> dict:
    """Close the websocket with 4003 and return a failed auth dict."""
    logger.warning("WebSocket connection rejected: %s", reason)
    await websocket.close(code=4003, reason="Unauthorized")
    return {"authenticated": False}


async def _auth_logs_query(db: AsyncSession, query_token: str, websocket: WebSocket) -> dict | None:
    """Query-token auth for the logs channel (Master-Token only)."""
    master_token = await _load_master_token(db)
    if master_token and secure_compare(query_token, master_token):
        return _auth_result("master", query_token)
    return await _auth_reject(websocket, "Invalid master token in query params for logs route.")


async def _auth_agent_query(db: AsyncSession, query_token: str, device_id: int | None, websocket: WebSocket) -> dict | None:
    """Query-token auth for the agent channel (Master-Token or device Agent-Token)."""
    from app.models.agent import AgentToken

    master_token = await _load_master_token(db)
    if master_token and secure_compare(query_token, master_token):
        return _auth_result("master", query_token)

    if device_id is not None:
        agent_res = await db.execute(
            select(AgentToken).where(
                AgentToken.device_id == device_id,
                AgentToken.is_active.is_(True)
            )
        )
        agent_token_obj = agent_res.scalar_one_or_none()
        if agent_token_obj and secure_compare(query_token, agent_token_obj.token):
            return _auth_result("agent", query_token)
    return await _auth_reject(websocket, "Invalid agent/master token or device mismatch in query params.")


async def _auth_scanner_query(db: AsyncSession, query_token: str, websocket: WebSocket) -> dict | None:
    """Query-token auth for the scanner channel (Master-Token only)."""
    master_token = await _load_master_token(db)
    if master_token and secure_compare(query_token, master_token):
        return _auth_result("master", query_token)
    return await _auth_reject(websocket, "Invalid master token in query params for scanner route.")


async def _auth_query_by_endpoint(
    db: AsyncSession,
    endpoint_type: str,
    query_token: str,
    device_id: int | None,
    websocket: WebSocket,
) -> dict | None:
    """Channel-policy query-token auth for logs/agent/scanner; returns auth dict or None on failure."""
    if endpoint_type == "logs":
        return await _auth_logs_query(db, query_token, websocket)
    if endpoint_type == "agent":
        return await _auth_agent_query(db, query_token, device_id, websocket)
    if endpoint_type == "scanner":
        return await _auth_scanner_query(db, query_token, websocket)
    return None


async def _authenticate_websocket_impl(
    websocket: WebSocket,
    endpoint_type: str,
    device_id: int | None,
    db: AsyncSession
) -> dict:
    from app.models.setting import Setting
    from app.services.auth_service import secure_compare
    from sqlalchemy import select

    # 1. Setup Bypass Check
    # Only "scanner" endpoint allows setup bypass so the wizard can show progress of initial scans.
    setup_res = await db.execute(select(Setting).where(Setting.key == "setup.complete"))
    setup_setting = setup_res.scalar_one_or_none()
    is_setup_done = setup_setting is not None and setup_setting.value == "true"

    if not is_setup_done:
        if endpoint_type == "scanner":
            return {
                "authenticated": True,
                "auth_type": "setup_bypass",
                "identity": "anonymous"
            }
        logger.warning(
            "WebSocket connection rejected: Setup bypass requested on non-scanner route '%s'.",
            endpoint_type
        )
        await websocket.close(code=4003, reason="Setup incomplete")
        return {"authenticated": False}

    cookie_token = websocket.cookies.get("gravitylan_token")
    query_token = websocket.query_params.get("token")

    # Reject any attempts to pass a Session ID (?token=session_...) via query params globally
    if query_token and query_token.startswith("session_"):
        logger.warning("WebSocket connection rejected: Session-IDs via query parameters are strictly forbidden.")
        await websocket.close(code=4003, reason="Query-based session auth forbidden")
        return {"authenticated": False}

    # 2. Browser Session Validation (via HTTP Cookie)
    # Both "logs", "scanner", and "agent" endpoints support Cookie auth (UI clients subscribing)
    if cookie_token and cookie_token.startswith("session_"):
        session = session_store.get_session(cookie_token)
        if session:
            # User-Agent check (weak mitigation signal)
            req_ua = websocket.headers.get("user-agent")
            if session.user_agent and req_ua and session.user_agent != req_ua:
                logger.warning(
                    "WebSocket Session User-Agent mismatch: expected '%s', got '%s'",
                    session.user_agent, req_ua
                )
            return {
                "authenticated": True,
                "auth_type": "session",
                "identity": cookie_token
            }
        # Reject and close if session cookie is invalid
        logger.warning("WebSocket connection rejected: Expired or invalid session cookie.")
        await websocket.close(code=4003, reason="Session expired or invalid")
        return {"authenticated": False}

    # 3. Dedicated Query Parameter Auth per channel policy
    if query_token:
        # Check if query_token is a valid read-only API Token
        h = hashlib.sha256(query_token.encode()).hexdigest()
        from app.models.api_token import ApiToken
        token_res = await db.execute(select(ApiToken).where(ApiToken.token_hash == h, ApiToken.is_active == True))
        db_token = token_res.scalar_one_or_none()

        if db_token:
            if db_token.scopes:
                token_scopes = {s.strip() for s in db_token.scopes.split(",") if s.strip()}
            else:
                token_scopes = _READONLY_DEFAULT_SCOPES

            ws_scope_map = {
                "logs": "settings:read",
                "scanner": "scanner:read",
                "agent": "agent:read",
            }
            required_scope = ws_scope_map.get(endpoint_type)
            if required_scope and required_scope not in token_scopes:
                logger.warning(
                    "WebSocket API token '%s' rejected: missing required scope '%s'",
                    db_token.name, required_scope
                )
                await websocket.close(code=4003, reason="Insufficient token scopes")
                return {"authenticated": False}

            await _touch_api_token(db, db_token)
            return {
                "authenticated": True,
                "auth_type": "api_token",
                "identity": f"api_token:{db_token.name}"
            }

        channel_auth = await _auth_query_by_endpoint(db, endpoint_type, query_token, device_id, websocket)
        if channel_auth is not None:
            return channel_auth
        # An invalid query token must not fall through to other channels: reject it.
        logger.warning("WebSocket connection rejected: Invalid query token.")
        await websocket.close(code=4003, reason="Unauthorized")
        return {"authenticated": False}

    # 4. Deprecated Legacy Cookie Fallback (Master-Token in Cookie)
    if cookie_token:
        master_token = await _load_master_token(db)
        if master_token and secure_compare(cookie_token, master_token):
            logger.warning(
                "DEPRECATION WARNING: Master-Token used in browser cookie for WebSocket auth. "
                "This legacy path is deprecated and will be removed in a future release."
            )
            return {
                "authenticated": True,
                "auth_type": "master_legacy",
                "identity": cookie_token
            }

    # 5. Missing Credentials
    logger.warning("WebSocket connection rejected: Missing authentication token.")
    await websocket.close(code=4001, reason="Missing authentication token")
    return {"authenticated": False}

# Brute-force guard for /login: at most LOGIN_MAX_FAILURES attempts per client IP
# within the sliding window. In memory, which fits the single uvicorn worker.
LOGIN_MAX_FAILURES = 5
LOGIN_FAILURE_WINDOW_SECONDS = 60
_login_attempts: dict[str, list[float]] = {}


def reset_login_rate_limit() -> None:
    """Forget all counted login attempts (used by the test fixtures)."""
    _login_attempts.clear()


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _reserve_login_attempt(ip: str) -> int | None:
    """Count a login attempt for ``ip``; returns Retry-After seconds once the limit is hit.

    The attempt is counted before the password is checked (no await in between), so
    parallel requests cannot all pass the check; a successful login clears the count.
    """
    now = time.monotonic()
    window_start = now - LOGIN_FAILURE_WINDOW_SECONDS
    if len(_login_attempts) > 1000:
        # Drop clients whose attempts have all expired so the store stays small
        for stale_ip in [k for k, v in _login_attempts.items() if v[-1] <= window_start]:
            del _login_attempts[stale_ip]

    attempts = [t for t in _login_attempts.get(ip, ()) if t > window_start]
    if len(attempts) >= LOGIN_MAX_FAILURES:
        _login_attempts[ip] = attempts
        return max(1, math.ceil(attempts[0] - window_start))
    attempts.append(now)
    _login_attempts[ip] = attempts
    return None


SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


def issue_session_cookie(response: Response, user_agent: str | None) -> None:
    """Create a browser session and attach it as the httpOnly gravitylan_token cookie."""
    session_id = session_store.create_session(user_agent=user_agent)
    response.set_cookie(
        key="gravitylan_token",
        value=session_id,
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookies,
        path="/",
        max_age=SESSION_COOKIE_MAX_AGE,
    )


@router.post("/login")
async def login(
    request: Request,
    response: Response,
    password: str = Body(..., embed=True),
    db: AsyncSession = Depends(get_db)
):
    """Authenticate and set a secure httpOnly session cookie."""
    client_ip = _client_ip(request)
    retry_after = _reserve_login_attempt(client_ip)
    if retry_after is not None:
        logger.warning("Login blocked for %s: too many failed attempts", client_ip)
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts. Try again in {retry_after} seconds.",
            headers={"Retry-After": str(retry_after)},
        )

    res_token = await db.execute(select(Setting).where(Setting.key == "api.master_token"))
    master_setting = res_token.scalar_one_or_none()
    
    if not master_setting:
        raise HTTPException(status_code=500, detail="System not initialized. Run setup first.")
    
    res_pass = await db.execute(select(Setting).where(Setting.key == "api.admin_password"))
    admin_pass_setting = res_pass.scalar_one_or_none()
    
    required_pass = admin_pass_setting.value if admin_pass_setting else master_setting.value
    
    is_valid = False
    needs_migration = False

    if looks_hashed(required_pass):
        is_valid = verify_password(password, required_pass)
    else:
        # Legacy plaintext comparison
        is_valid = secure_compare(password, required_pass)
        if is_valid:
            needs_migration = True
    
    if is_valid:
        logger.info("Login successful, generating lock-free in-memory session")
        _login_attempts.pop(client_ip, None)

        # Auto-migrate to hashed password if it was plaintext
        if needs_migration:
            logger.info("Migrating legacy plaintext password to hash")
            hashed = hash_password(password)
            if admin_pass_setting:
                admin_pass_setting.value = hashed
            else:
                db.add(Setting(key="api.admin_password", value=hashed, category="system"))
            await db.commit()

        issue_session_cookie(response, request.headers.get("user-agent"))
        return {
            "status": "ok", 
            "message": "Login successful"
        }
    
    logger.warning("Login failed: invalid password provided")
    raise HTTPException(status_code=401, detail="Invalid password")

@router.post("/logout")
async def logout(request: Request, response: Response):
    """Clear the authentication cookie and invalidate the in-memory session."""
    cookie_token = request.cookies.get("gravitylan_token")
    if cookie_token and cookie_token.startswith("session_"):
        session_store.delete_session(cookie_token)
    response.delete_cookie(key="gravitylan_token", path="/")
    return {"status": "ok", "message": "Logged out"}

PASSWORD_MIN_LENGTH = 8


class PasswordChange(BaseModel):
    current_password: str = Field(..., max_length=256)
    new_password: str = Field(..., min_length=PASSWORD_MIN_LENGTH, max_length=256)


@router.post("/password")
async def change_password(
    req: PasswordChange,
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Change the admin login password; logs out every other browser session.

    Only a logged-in browser session may do this (not API or master tokens), and the
    current password must be confirmed. Errors are 400, not 401, so the UI does not
    treat a typo as "logged out".
    """
    if not (token.startswith("session_") and session_store.get_session(token)):
        raise HTTPException(status_code=403, detail="Only a logged-in browser session can change the password.")

    master_setting = (await db.execute(select(Setting).where(Setting.key == "api.master_token"))).scalar_one_or_none()
    admin_setting = (await db.execute(select(Setting).where(Setting.key == "api.admin_password"))).scalar_one_or_none()
    required = admin_setting.value if admin_setting else (master_setting.value if master_setting else "")
    if not required:
        raise HTTPException(status_code=500, detail="System not initialized. Run setup first.")

    current_ok = (
        verify_password(req.current_password, required) if looks_hashed(required)
        else secure_compare(req.current_password, required)
    )
    if not current_ok:
        logger.warning("Password change rejected: current password is wrong")
        raise HTTPException(status_code=400, detail="The current password is wrong.")
    if req.new_password == req.current_password:
        raise HTTPException(status_code=400, detail="Choose a password that differs from the current one.")
    if not req.new_password.strip():
        raise HTTPException(status_code=400, detail="The new password must not be blank.")

    hashed = hash_password(req.new_password)
    if admin_setting:
        admin_setting.value = hashed
    else:
        db.add(Setting(key="api.admin_password", value=hashed, category="system",
                       description="Administrator password for dashboard login"))
    await db.commit()

    ended = session_store.delete_all_except(token)
    logger.info("Admin password changed; %d other session(s) logged out", ended)
    return {"status": "ok", "other_sessions_ended": ended}


@router.post("/check")
async def check_auth(token: str = Depends(get_current_admin)):
    """Check if currently authenticated (via dependency)."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# API Token Management Endpoints
# ---------------------------------------------------------------------------

from app.models.api_token import ApiToken
from app.schemas.api_token import ApiTokenCreate, ApiTokenResponse, ApiTokenCreated

@router.get("/tokens", response_model=list[ApiTokenResponse])
async def list_api_tokens(
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """List all configured read-only API tokens (Admin only)."""
    if token.startswith("api_token:"):
        raise HTTPException(status_code=403, detail="Read-only tokens cannot view or manage other tokens.")
    
    res = await db.execute(select(ApiToken).order_by(ApiToken.created_at.desc()))
    return res.scalars().all()

@router.post("/tokens", response_model=ApiTokenCreated)
async def create_api_token(
    payload: ApiTokenCreate,
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """Create a new read-only API token (Admin only)."""
    if token.startswith("api_token:"):
        raise HTTPException(status_code=403, detail="Read-only tokens cannot view or manage other tokens.")
    
    raw_token = "gl_pat_" + secrets.token_hex(24)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    prefix = raw_token[:11] + "..."
    scopes_str = ",".join(payload.scopes) if payload.scopes else None

    new_token = ApiToken(
        name=payload.name,
        token_hash=token_hash,
        prefix=prefix,
        is_active=True,
        scopes=scopes_str
    )
    db.add(new_token)
    await db.commit()
    await db.refresh(new_token)

    return ApiTokenCreated(
        id=new_token.id,
        name=new_token.name,
        prefix=new_token.prefix,
        is_active=new_token.is_active,
        created_at=new_token.created_at,
        last_used_at=new_token.last_used_at,
        token=raw_token,
        scopes=payload.scopes
    )

@router.delete("/tokens/{token_id}")
async def delete_api_token(
    token_id: int,
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """Delete (revoke) an API token (Admin only)."""
    if token.startswith("api_token:"):
        raise HTTPException(status_code=403, detail="Read-only tokens cannot view or manage other tokens.")
    
    res = await db.execute(select(ApiToken).where(ApiToken.id == token_id))
    db_token = res.scalar_one_or_none()
    if not db_token:
        raise HTTPException(status_code=404, detail="API Token not found")
    
    await db.delete(db_token)
    await db.commit()
    return {"status": "ok", "message": "Token revoked successfully"}

@router.get("/me")
async def auth_me(
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """Token introspection endpoint returning authorized scopes."""
    if token.startswith("api_token:"):
        name = token.removeprefix("api_token:")
        from app.models.api_token import ApiToken
        res = await db.execute(select(ApiToken).where(ApiToken.name == name))
        db_token = res.scalar_one_or_none()
        if db_token:
            if db_token.scopes:
                scopes = [s.strip() for s in db_token.scopes.split(",") if s.strip()]
            else:
                scopes = [
                    "devices:read", "topology:read", "network:read", "agent:read",
                    "settings:read", "backup:read", "scanner:read"
                ]
            return {"scopes": scopes}
    # Master token or admin browser session has full scopes
    return {"scopes": ["*"]}
