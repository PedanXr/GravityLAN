"""Agent API — Handles incoming metrics from deployed agents and provides real-time status."""

import asyncio
import hashlib
import inspect
import json
import logging
import secrets
import shlex
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict


from app.scanner.utils import ensure_utc
from app.version import normalize_version

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import PlainTextResponse, FileResponse
from sqlalchemy import delete, desc, select, func
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from app.config import settings
from app.database import async_session, get_db
from app.models.agent import AgentConfig, DeviceMetrics, AgentToken
from app.models.device import Device
from app.models.ssh import SshKnownHost
from app.services.ssh_utils import PinnedHostKey, TofuHostKeyPolicy
from app.api.auth import get_current_admin
from app.schemas.agent import (
    AgentReportPayload,
    AgentReportResponse,
    AgentStatusResponse,
    AgentDeployRequest,
    AgentDeployResponse,
    AgentEnrollmentResponse,
    AgentInstallRequest,
    AgentConfigUpdate,
    AgentConfigResponse,
    MetricsHistoryResponse,
    AgentsOverviewResponse,
    AgentSummary,
    GlobalMetricPoint,
    GlobalMetricsResponse,
)
from app.services.agent_deployer import deploy_agent, remove_agent, LATEST_AGENT_VERSION
from app.services.agent_tokens import hash_agent_token, new_agent_token, pending_storage_form
from app.services.enrollment_service import enrollment_store
from app.services.session_service import has_browser_session
from app.services.ssh_credentials import StoredLoginError, resolve_key_profile, resolve_stored_key

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent", tags=["agent"])

# Telemetry and time-series services re-exported for backwards-compatibility
from app.services.agent_telemetry import (
    _latest_metrics,
    _ws_subscribers,
    _setting_cache,
    _setting_cache_time,
    _hash_agent_token,
    _find_and_migrate_agent_token,
    _get_auto_adopt_setting,
    _is_device_stale,
    _resolve_token_mismatch,
    _persist_device_metadata,
    _build_metrics_row,
    _build_config_payload,
    _persist_agent_report,
    _build_metrics_snapshot,
    _broadcast_metrics,
    downsample_metrics,
    _is_agent_active,
    _compute_uptime_pct,
    _compute_uptime_history,
    _build_agent_summary,
    assemble_agents_overview_data,
    aggregate_global_metrics_buckets,
)
from app.services.agent_scripts import (
    INSTALL_CODE_REJECTED_SCRIPT,
    _PREFERRED_IFACE_KEYWORDS,
    _AVOID_IFACE_KEYWORDS,
    _pick_best_subnet,
    _server_url_from_ip,
    _detect_server_url,
    build_agent_config_json,
    build_install_script,
    build_uninstall_script,
)
_INSTALL_CODE_REJECTED_SCRIPT = INSTALL_CODE_REJECTED_SCRIPT


# ---------------------------------------------------------------------------
# Report Endpoint (Agent -> Server)
# ---------------------------------------------------------------------------

@router.post("/report", response_model=AgentReportResponse)
async def receive_report(
    payload: AgentReportPayload,
    request: Request,
    authorization: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> AgentReportResponse:
    """
    Receive a metrics report from a deployed agent.
    
    Includes advanced auto-healing logic to recover agent sessions after 
    database resets or device re-discovery.
    
    Args:
        payload: The metrics data from the agent.
        request: FastAPI request object (used for client IP).
        authorization: Bearer token for authentication.
        db: Injected database session.
        
    Returns:
        AgentReportResponse with status and optional command config.
        
    Raises:
        HTTPException: 401 if token is invalid or 404 if device is missing.
    """
    token = authorization.replace("Bearer ", "").strip()
    client_ip = request.client.host if request.client else None

    # 1. Validate token (supports SHA-256 and transparent legacy UUID auto-migration)
    agent_token = await _find_and_migrate_agent_token(db, token)

    # 2. Settings Cache (Global)
    allow_auto_adopt = await _get_auto_adopt_setting(db)

    # 3. Handle Token Mismatch / Pending Adoption
    agent_token = await _resolve_token_mismatch(db, agent_token, token, client_ip, payload.device_id, allow_auto_adopt)

    # 4. Main Persistence Transaction (with Retry)
    effective_device_id = agent_token.device_id
    config_to_send = await _persist_agent_report(db, agent_token, payload, client_ip)

    # 5. Ingest Layer-2 ARP neighbors if reported by probe (the service drops them
    #    unless this device has the scanner relay on, and keeps only its own subnets)
    if payload.arp_table:
        try:
            from app.services.agent_scanner_relay import ingest_agent_arp_table
            await ingest_agent_arp_table(db, effective_device_id, payload.arp_table)
        except Exception as e:
            logger.warning(f"Failed to ingest agent ARP table: {e}")

    # 8. Broadcast to WebSocket subscribers
    await _broadcast_metrics(payload, effective_device_id)

    return AgentReportResponse(
        status="success",
        config_version=config_to_send["version"],
        config={
            "interval": config_to_send["interval"],
            "disk_paths": config_to_send["disk_paths"],
            "enable_temp": config_to_send["enable_temp"],
            "enable_patch_check": config_to_send["enable_patch_check"],
            "enable_scanner_relay": config_to_send.get("enable_scanner_relay", False),
        },
        commands=[]
    )


@router.get("/config/{device_id}", response_model=AgentConfigResponse)
async def get_agent_config(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
):
    """Get the persistent configuration for a specific agent."""
    config_res = await db.execute(select(AgentConfig).where(AgentConfig.device_id == device_id))
    config = config_res.scalar_one_or_none()
    
    if not config:
        # Create default config if missing
        config = AgentConfig(device_id=device_id)
        db.add(config)
        await db.commit()
        await db.refresh(config)
        
    return AgentConfigResponse(
        device_id=device_id,
        interval=config.interval,
        disk_paths=config.disk_paths,
        enable_temp=config.enable_temp,
        enable_patch_check=config.enable_patch_check,
        enable_scanner_relay=getattr(config, "enable_scanner_relay", False),
    )


@router.patch("/config/{device_id}", response_model=AgentConfigResponse)
async def update_agent_config(
    device_id: int, 
    update: AgentConfigUpdate, 
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
):
    """Update agent configuration and increment version to trigger a push."""
    config_res = await db.execute(select(AgentConfig).where(AgentConfig.device_id == device_id))
    config = config_res.scalar_one_or_none()
    
    if not config:
        config = AgentConfig(device_id=device_id)
        db.add(config)

    if update.interval is not None:
        config.interval = update.interval
    if update.disk_paths is not None:
        config.disk_paths = update.disk_paths
    if update.enable_temp is not None:
        config.enable_temp = update.enable_temp
    if update.enable_patch_check is not None:
        config.enable_patch_check = update.enable_patch_check
    if update.enable_scanner_relay is not None:
        config.enable_scanner_relay = update.enable_scanner_relay
        
    # Increment version so the agent knows to update its local config.json
    config.version += 1
    
    await db.commit()
    await db.refresh(config)
    
    return AgentConfigResponse(
        device_id=device_id,
        interval=config.interval,
        disk_paths=config.disk_paths,
        enable_temp=config.enable_temp,
        enable_patch_check=config.enable_patch_check,
        enable_scanner_relay=getattr(config, "enable_scanner_relay", False),
    )


@router.get("/overview", response_model=AgentsOverviewResponse)
async def get_agents_overview(
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> AgentsOverviewResponse:
    """Get a summary of all agents for the Agents Tab.

    Optimized to use 2 bulk queries instead of N×27 sequential queries.
    Pre-fetches latest metrics and 24-hour hourly counts in one pass each,
    then assembles the response in Python.
    """
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)

    # 1. Fetch all agent-linked devices in a single JOIN
    res = await db.execute(
        select(Device, AgentToken)
        .join(AgentToken, Device.id == AgentToken.device_id)
    )
    results = res.all()

    if not results:
        return AgentsOverviewResponse(
            agents=[], total_agents=0, active_agents=0,
            total_data_points=0, avg_cpu=0.0, avg_ram=0.0
        )

    device_ids = [d.id for d, _ in results]
    token_map = {d.id: t for d, t in results}
    device_map = {d.id: d for d, _ in results}

    # 2. Bulk-fetch all metrics for all agents in last 24h (single query)
    metrics_res = await db.execute(
        select(DeviceMetrics)
        .where(
            DeviceMetrics.device_id.in_(device_ids),
            DeviceMetrics.timestamp >= cutoff_24h.replace(tzinfo=None)
        )
        .order_by(DeviceMetrics.device_id, DeviceMetrics.timestamp.desc())
    )
    all_24h_metrics = metrics_res.scalars().all()

    # 3. Bulk-count total metrics per device (single query)
    total_count_res = await db.execute(
        select(DeviceMetrics.device_id, func.count(DeviceMetrics.id).label("cnt"))
        .where(DeviceMetrics.device_id.in_(device_ids))
        .group_by(DeviceMetrics.device_id)
    )
    total_count_map: dict[int, int] = {row.device_id: row.cnt for row in total_count_res.all()}

    agents_list, n, active_count, total_metrics_count, avg_cpu, avg_ram = assemble_agents_overview_data(
        device_ids, device_map, token_map, all_24h_metrics, total_count_map, now, cutoff_24h
    )
    return AgentsOverviewResponse(
        agents=agents_list,
        total_agents=n,
        active_agents=active_count,
        total_data_points=total_metrics_count,
        avg_cpu=avg_cpu,
        avg_ram=avg_ram,
    )


@router.get("/global-metrics", response_model=GlobalMetricsResponse)
async def get_global_metrics(
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> GlobalMetricsResponse:
    """Get aggregated network-wide performance history for the last 24 hours."""
    now = datetime.now(timezone.utc)
    cutoff_24h = now - timedelta(hours=24)
    
    # Fetch all metrics for the last 24h
    res = await db.execute(
        select(DeviceMetrics.timestamp, DeviceMetrics.cpu_percent, DeviceMetrics.ram_percent)
        .where(DeviceMetrics.timestamp >= cutoff_24h.replace(tzinfo=None))
        .order_by(DeviceMetrics.timestamp.asc())
    )
    all_metrics = res.all()
    return GlobalMetricsResponse(history=aggregate_global_metrics_buckets(all_metrics))


# ---------------------------------------------------------------------------
# UI Endpoints (Dashboard -> Server)
# ---------------------------------------------------------------------------

@router.get("/status/{device_id}", response_model=AgentStatusResponse)
async def get_agent_status(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> AgentStatusResponse:
    """Get the current status and latest metrics for a specific agent."""
    # Check Token
    token_res = await db.execute(select(AgentToken).where(AgentToken.device_id == device_id))
    token = token_res.scalar_one_or_none()
    
    if not token:
        return AgentStatusResponse(
            device_id=device_id,
            is_active=False,
            message="No agent linked"
        )

    # Get latest metrics
    metrics_res = await db.execute(
        select(DeviceMetrics)
        .where(DeviceMetrics.device_id == device_id)
        .order_by(desc(DeviceMetrics.timestamp))
        .limit(1)
    )
    last_metrics = metrics_res.scalar_one_or_none()
    
    # Calculate health (Healthy if seen within last 5 minutes)
    is_healthy = False
    last_seen = ensure_utc(token.last_seen)
    if last_seen:
        is_healthy = (datetime.now(timezone.utc) - last_seen).total_seconds() < 300

    return AgentStatusResponse(
        device_id=device_id,
        is_installed=True,
        is_active=token.is_active and is_healthy,
        is_healthy=is_healthy,
        last_seen=token.last_seen,
        agent_version=normalize_version(token.agent_version),
        latest_version=normalize_version(LATEST_AGENT_VERSION),
        latest_metrics=last_metrics.to_dict() if last_metrics else None
    )


@router.get("/metrics/{device_id}", response_model=MetricsHistoryResponse)
async def get_metrics_history(
    device_id: int, 
    limit: int = 60, 
    range: str | None = None,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> MetricsHistoryResponse:
    """Get the recent metrics history for a specific device, supporting dynamic ranges and downsampling."""
    if range is not None:
        valid_ranges = {"6h", "24h", "7d", "30d"}
        if range not in valid_ranges:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid range '{range}'. Valid ranges are: 6h, 24h, 7d, 30d."
            )
        
        now = datetime.now(timezone.utc)
        if range == "6h":
            cutoff = now - timedelta(hours=6)
        elif range == "24h":
            cutoff = now - timedelta(hours=24)
        elif range == "7d":
            cutoff = now - timedelta(days=7)
        else: # 30d
            cutoff = now - timedelta(days=30)
            
        result = await db.execute(
            select(DeviceMetrics)
            .where(
                DeviceMetrics.device_id == device_id,
                DeviceMetrics.timestamp >= cutoff.replace(tzinfo=None)
            )
            .order_by(DeviceMetrics.timestamp.asc())
        )
        metrics = result.scalars().all()
        snapshots = downsample_metrics(list(metrics), range)
    else:
        # Legacy fallback logic: latest limit metrics in chronological order
        result = await db.execute(
            select(DeviceMetrics)
            .where(DeviceMetrics.device_id == device_id)
            .order_by(desc(DeviceMetrics.timestamp))
            .limit(limit)
        )
        metrics = result.scalars().all()
        snapshots = [m.to_dict() for m in reversed(list(metrics))]
        
    from app.models.setting import Setting
    result_setting = await db.execute(select(Setting).where(Setting.key == "history_retention_days"))
    setting_record = result_setting.scalar_one_or_none()
    
    try:
        retention_days = int(setting_record.value) if setting_record and setting_record.value is not None else settings.history_retention_days
    except (TypeError, ValueError):
        retention_days = settings.history_retention_days
    
    available_ranges = ["6h"]
    if retention_days >= 1:
        available_ranges.append("24h")
    if retention_days >= 7:
        available_ranges.append("7d")
    if retention_days >= 30:
        available_ranges.append("30d")
        
    return MetricsHistoryResponse(
        device_id=device_id,
        snapshots=snapshots,
        retention_days=retention_days,
        available_ranges=available_ranges
    )


@router.get("/download/agent")
async def download_agent_file():
    from app.services.agent_deployer import AGENT_SCRIPT_PATH
    agent_path = AGENT_SCRIPT_PATH
    
    if not agent_path.exists():
        raise HTTPException(status_code=404, detail="Agent script not found on server")
        
    return FileResponse(
        path=str(agent_path), 
        media_type="text/x-python",
        filename="gravitylan-agent.py"
    )


@router.post("/enroll/{device_id}", response_model=AgentEnrollmentResponse)
async def create_enrollment_code(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin),
) -> AgentEnrollmentResponse:
    """Issue a single-use code that authorises the manual install script for one device."""
    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    code = enrollment_store.issue(device_id)
    return AgentEnrollmentResponse(code=code, expires_in=int(enrollment_store.ttl_seconds))


@router.get("/download/config/{device_id}")
async def download_agent_config(
    device_id: int,
    request: Request,
    code: str | None = None,
    authorization: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
):
    """Generate and download the agent.conf for a specific device.

    The config carries the agent token, so it needs admin auth or a single-use
    enrollment code (redeemed by the manual install script).
    """
    if code is not None:
        if not enrollment_store.consume(code, device_id):
            raise HTTPException(status_code=403, detail="Invalid, expired or already used enrollment code")
    else:
        caller = await get_current_admin(conn=request, authorization=authorization, token=None, db=db)
        if caller.startswith("api_token:"):
            raise HTTPException(status_code=403, detail="Read-only API tokens cannot export agent configurations")

    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
        
    # Only the hash is stored, so the plaintext token exists once: every
    # download issues a fresh token and invalidates the previous one.
    raw_token, stored_token = new_agent_token()
    token_res = await db.execute(select(AgentToken).where(AgentToken.device_id == device_id))
    token_obj = token_res.scalar_one_or_none()

    if not token_obj:
        db.add(AgentToken(device_id=device_id, token=stored_token, is_active=True))
    else:
        token_obj.token = stored_token
        token_obj.is_active = True
        token_obj.last_seen = None
        token_obj.pending_token = None
        token_obj.pending_at = None
    await db.commit()

    # Detect Server URL (same logic as in deploy)
    server_url = await _detect_server_url(db)

    # Generate JSON config via service builder
    return PlainTextResponse(build_agent_config_json(server_url, raw_token, device_id))


@router.get("/download/install-sh/{device_id}")
async def download_install_script(device_id: int, code: str | None = None, db: AsyncSession = Depends(get_db)):
    """Generate a shell script for easy 'curl | bash' installation.

    ``code`` is a single-use enrollment code from ``POST /enroll/{device_id}``.
    It is only checked here (not used up) and embedded into the script, which
    redeems it when downloading the agent config.
    """
    if not enrollment_store.is_valid(code, device_id):
        # Served as a script so `curl ... | sudo bash` prints a readable error instead of feeding JSON to bash.
        return PlainTextResponse(_INSTALL_CODE_REJECTED_SCRIPT, status_code=403)

    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    # Detect Server URL
    server_url = await _detect_server_url(db)

    return PlainTextResponse(build_install_script(server_url, device_id, code))


async def _ssh_login(db: AsyncSession, device: Device, req: AgentInstallRequest, http_request: Request) -> dict:
    """SSH arguments for deploy/uninstall: the typed-in credentials, or a saved key connection of the device.

    Saved connections follow the SSH terminal's rules (ADR-002): browser sessions
    only, never API or master tokens, and only to a host whose key the user has
    already confirmed there.
    """
    if req.profile_id is None:
        if not req.ssh_user:
            raise HTTPException(status_code=400, detail="Enter an SSH user or choose a saved connection.")
        stmt = select(SshKnownHost).where(SshKnownHost.host == device.ip, SshKnownHost.port == req.ssh_port)
        known = (await db.execute(stmt)).scalar_one_or_none()
        pinned = PinnedHostKey(key_type=known.key_type, fingerprint=known.fingerprint) if known else None

        ssh_key = req.ssh_key
        ssh_passphrase = req.key_passphrase
        if req.key_id is not None:
            if not has_browser_session(http_request):
                raise HTTPException(status_code=403, detail="Saved SSH keys can only be used from a logged-in browser session.")
            try:
                ssh_key, ssh_passphrase = await resolve_stored_key(db, req.key_id, req.key_passphrase)
            except StoredLoginError as exc:
                raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
            await db.commit()

        return dict(
            host_ip=device.ip, ssh_user=req.ssh_user, ssh_password=req.ssh_password,
            ssh_key=ssh_key, ssh_key_passphrase=ssh_passphrase, ssh_port=req.ssh_port, pinned_host_key=pinned,
        )

    if not has_browser_session(http_request):
        raise HTTPException(status_code=403, detail="Saved SSH connections can only be used from a logged-in browser session.")
    try:
        login = await resolve_key_profile(db, req.profile_id, device)
    except StoredLoginError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    await db.commit()  # the key's last use
    logger.info(
        "Agent SSH login for device %d via saved connection '%s' (%s@%s:%d, key %s)",
        device.id, login.profile_name, login.username, login.host, login.port, login.key_fingerprint,
    )
    return dict(
        host_ip=login.host, ssh_user=login.username, ssh_password=req.sudo_password,
        ssh_key=login.private_key, ssh_key_passphrase=login.passphrase, ssh_port=login.port,
        pinned_host_key=login.pinned,
    )


@router.post("/deploy/{device_id}", response_model=AgentDeployResponse)
async def deploy_agent_endpoint(
    device_id: int,
    request: AgentInstallRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> AgentDeployResponse:
    """
    Deploy the GravityLAN Agent to a remote device via SSH.

    Typed-in credentials are used exclusively for this request and are never
    stored; a saved key connection (``profile_id``) is decrypted on the server
    and never leaves it.
    """
    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    login = await _ssh_login(db, device, request, http_request)

    # 1. Determine Server URL
    # Strategy: Check settings first, then fall back to detecting local IP
    server_url = await _detect_server_url(db)

    # 2. Run Deployment
    logger.info("Starting agent deployment for device %d (%s) to server %s",
                device_id, login["host_ip"], server_url)

    success, message, token = await deploy_agent(**login, server_url=server_url, device_id=device_id)

    if success:
        # Save or update the token in the database
        # We delete any old tokens first to ensure a clean start
        await db.execute(delete(AgentToken).where(AgentToken.device_id == device_id))
        
        new_token = AgentToken(
            device_id=device_id,
            token=hash_agent_token(token),
            is_active=True,
            last_seen=None
        )
        db.add(new_token)
        
        # Ensure we have a default config for the agent
        config_res = await db.execute(select(AgentConfig).where(AgentConfig.device_id == device_id))
        if not config_res.scalar_one_or_none():
            db.add(AgentConfig(device_id=device_id))
            
        await db.commit()
        return AgentDeployResponse(status="success", message=message)
    else:
        return AgentDeployResponse(status="failed", message=message)


@router.post("/uninstall/{device_id}")
async def uninstall_agent_endpoint(
    device_id: int,
    request: AgentInstallRequest,
    http_request: Request,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> dict:
    """
    Uninstall the GravityLAN Agent from a remote device.
    """
    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    success, message = await remove_agent(**await _ssh_login(db, device, request, http_request))

    if success:
        # Deactivate token in DB
        await db.execute(
            delete(AgentToken).where(AgentToken.device_id == device_id)
        )
        await db.commit()
        return {"status": "success", "message": message}
    else:
        return {"status": "failed", "message": message}


@router.websocket("/ws/{device_id}")
async def agent_websocket(websocket: WebSocket, device_id: int):
    """WebSocket for real-time metric streaming to the dashboard with authentication."""
    from app.api.auth import authenticate_websocket_authorized

    # Agent websocket is restricted to browser-sessions, legacy master cookie, master token query params, agent-specific tokens, or API tokens
    auth_info = await authenticate_websocket_authorized(
        websocket, endpoint_type="agent", device_id=device_id,
        allowed_levels=("session", "master_legacy", "agent", "master", "api_token"),
    )
    if not auth_info:
        return

    await websocket.accept()
    if device_id not in _ws_subscribers:
        _ws_subscribers[device_id] = set()
    _ws_subscribers[device_id].add(websocket)
    
    try:
        if device_id in _latest_metrics:
            await websocket.send_json({"type": "metrics", "data": _latest_metrics[device_id]})
            
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if device_id in _ws_subscribers:
            _ws_subscribers[device_id].discard(websocket)


@router.get("/download/uninstall-sh/{device_id}")
async def download_uninstall_script(device_id: int, db: AsyncSession = Depends(get_db)):
    """Generate a shell script for easy 'curl | bash' uninstallation."""
    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    return PlainTextResponse(build_uninstall_script())
    
@router.post("/adopt/{device_id}")
async def adopt_agent_token(device_id: int, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_admin)):
    """Manually adopt a pending token for a device."""
    token_res = await db.execute(select(AgentToken).where(AgentToken.device_id == device_id))
    token_obj = token_res.scalar_one_or_none()
    
    if not token_obj or not token_obj.pending_token:
        raise HTTPException(status_code=400, detail="No pending token found for this device")
    
    # Move pending token to active token (pending tokens from before 0.3.25 are plaintext)
    token_obj.token = pending_storage_form(token_obj.pending_token)
    token_obj.pending_token = None
    token_obj.pending_at = None
    token_obj.is_active = True

    await db.commit()
    logger.info("Device %d adopted its pending agent token", device_id)
    
    return {"status": "ok", "message": "Token adopted successfully"}


# ---------------------------------------------------------------------------
# Linux Package Patching Endpoints (Delegated to app.api.agent_patches)
# ---------------------------------------------------------------------------

from app.api.agent_patches import (
    patch_router,
    _temp_patch_tokens,
    PATCH_TOKEN_TTL_SECONDS,
    query_device_patches,
    prepare_patch_action,
    _send_ws_text,
    _consume_patch_session,
    _build_update_command,
    _push_metrics_to_subscribers,
    _clear_device_patch_state,
    run_patches_websocket,
)
from app.services.patch_service import list_device_updates, run_ssh_command_stream

router.include_router(patch_router)
