"""Agent API — Handles incoming metrics from deployed agents and provides real-time status."""

import asyncio
import json
import logging
import secrets
import shlex
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
from app.services.enrollment_service import enrollment_store
from app.services.session_service import has_browser_session
from app.services.ssh_credentials import StoredLoginError, resolve_key_profile

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent", tags=["agent"])

# Global caches for real-time dashboard updates
_latest_metrics: Dict[int, Dict[str, Any]] = {}
_ws_subscribers: Dict[int, set[WebSocket]] = {}
_setting_cache: Dict[str, Any] = {}
_setting_cache_time: datetime = datetime.min.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Server-URL detection (shared by config download, install script, and deploy)
# ---------------------------------------------------------------------------

_PREFERRED_IFACE_KEYWORDS = ["eth", "eno", "ens", "enp", "wlan", "wlp"]
_AVOID_IFACE_KEYWORDS = ["docker", "br-", "veth", "tailscale", "tun"]


def _pick_best_subnet(subnets) -> Any | None:
    """Pick the local subnet most likely to be the server's real interface.

    Prioritizes physical NICs and private 192.168./10. ranges while
    penalizing virtual/Docker bridge interfaces. ``None`` when no subnet
    could be selected.
    """
    if not subnets:
        return None

    def ip_priority(s):
        ip = s.ip_address
        iface = s.interface_name.lower()
        score = 0
        if any(x in iface for x in _PREFERRED_IFACE_KEYWORDS):
            score += 100
        if ip.startswith("192.168."):
            score += 50
        if ip.startswith("10."):
            score += 40
        if any(x in iface for x in _AVOID_IFACE_KEYWORDS):
            score -= 100
        return score

    return max(subnets, key=ip_priority)


def _server_url_from_ip(ip: str) -> str:
    """Build the server URL for a detected IP (port 80 omits the port)."""
    port = settings.port
    return f"http://{ip}:{port}" if port != 80 else f"http://{ip}"


async def _detect_server_url(db: AsyncSession) -> str:
    """Resolve the server URL from settings, falling back to local IP detection."""
    from app.models.setting import Setting
    from app.api.settings import check_server_url
    res = await db.execute(select(Setting).where(Setting.key == "server.url"))
    setting = res.scalar_one_or_none()
    if setting and setting.value:
        # Values stored before the stricter validation existed are re-checked here:
        # the URL ends up in a root install script, so an unsafe one is never used.
        try:
            check_server_url(setting.value)
            return setting.value
        except ValueError as e:
            logger.warning("Ignoring unsafe server.url setting (%s); falling back to auto-detection", e)

    from app.scanner.utils import get_local_subnets
    best = _pick_best_subnet(get_local_subnets())
    if best:
        logger.info("Auto-detected server URL: %s (via %s)", _server_url_from_ip(best.ip_address), best.interface_name)
        return _server_url_from_ip(best.ip_address)

    port = settings.port
    return f"http://localhost:{port}" if port != 80 else "http://localhost"


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

    # 1. Validate token (Read-only phase)
    result = await db.execute(
        select(AgentToken).where(
            AgentToken.token == token, 
            AgentToken.is_active.is_(True)
        )
    )
    agent_token = result.scalar_one_or_none()

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


async def _get_auto_adopt_setting(db: AsyncSession) -> bool:
    """Read the auto-adoption setting with a 5-minute global cache."""
    global _setting_cache_time
    now = datetime.now(timezone.utc)
    if "allow_auto_adopt" not in _setting_cache or (now - _setting_cache_time).total_seconds() > 300:
        from app.models.setting import Setting
        adopt_res = await db.execute(select(Setting).where(Setting.key == "agent.allow_auto_adoption"))
        allow_adopt_setting = adopt_res.scalar_one_or_none()
        _setting_cache["allow_auto_adopt"] = allow_adopt_setting.value.lower() == "true" if allow_adopt_setting else False
        _setting_cache_time = now
    return _setting_cache["allow_auto_adopt"]


def _is_device_stale(now, device, token_obj) -> bool:
    """Return True when a device/token is offline or its heartbeat is stale (> 5 min)."""
    if not token_obj:
        return True
    if not device.is_online:
        return True
    if not token_obj.last_seen:
        return True
    last_seen_aware = ensure_utc(token_obj.last_seen)
    return (now - last_seen_aware).total_seconds() > 300


async def _resolve_token_mismatch(
    db: AsyncSession,
    agent_token,
    token: str,
    client_ip: str | None,
    device_id: int,
    allow_auto_adopt: bool,
):
    """Recover agent sessions after DB resets / device re-discovery via auto-adoption."""
    if agent_token:
        return agent_token

    if not client_ip:
        raise HTTPException(status_code=401, detail="Invalid token.")

    dev_result = await db.execute(select(Device).where(Device.ip == client_ip))
    device = dev_result.scalar_one_or_none()
    if not device or device.id != device_id:
        raise HTTPException(status_code=401, detail="Invalid token.")

    logger.warning(f"Token mismatch for device {device.id} ({client_ip}). Storing pending_token.")
    token_res = await db.execute(select(AgentToken).where(AgentToken.device_id == device.id))
    token_obj = token_res.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if allow_auto_adopt and _is_device_stale(now, device, token_obj):
        logger.info(f"Auto-adopting token for device {device.id} ({client_ip}) because device is offline or stale.")
        if token_obj:
            token_obj.token = token
            token_obj.pending_token = None
            token_obj.pending_at = None
            token_obj.is_active = True
        else:
            token_obj = AgentToken(device_id=device.id, token=token, is_active=True)
            db.add(token_obj)
        await db.commit()
        return token_obj  # Proceed with normal metric persist!

    if token_obj:
        token_obj.pending_token = token
        token_obj.pending_at = datetime.now(timezone.utc)
    else:
        # Placeholder until an admin adopts pending_token: random and inactive, so it
        # can never authenticate and leaks nothing of the submitted token.
        new_token = AgentToken(
            device_id=device.id,
            token=secrets.token_hex(32),
            is_active=False,
            pending_token=token,
            pending_at=datetime.now(timezone.utc),
        )
        db.add(new_token)
    await db.commit()
    raise HTTPException(status_code=401, detail="Invalid token. Manual adoption required.")


def _persist_device_metadata(db_token, device, payload) -> None:
    """Update token/device metadata from the agent payload (throttled online flag)."""
    now = datetime.now(timezone.utc)
    last_seen = ensure_utc(db_token.last_seen)
    if not last_seen or (now - last_seen).total_seconds() > 60:
        db_token.last_seen = now
        device.is_online = True
        device.missed_scans = 0
        device.last_seen = now

    if db_token.agent_version != payload.agent_version:
        db_token.agent_version = payload.agent_version

    # Persist OS metadata reported by the agent (e.g. from /etc/os-release)
    system = payload.system or {}
    if system.get("os"):
        db_token.os_pretty = str(system["os"])[:255]
    if system.get("os_name"):
        db_token.os_name = str(system["os_name"])[:100]
    if system.get("os_version"):
        db_token.os_version = str(system["os_version"])[:100]
    if system.get("os_codename"):
        db_token.os_codename = str(system["os_codename"])[:100]
    if system.get("arch"):
        db_token.os_arch = str(system["arch"])[:50]
    if system.get("kernel"):
        db_token.os_kernel = str(system["kernel"])[:100]
    device.has_agent = True

    # Clear stale pending token flags since we have a successful report with active token
    if db_token.pending_token is not None:
        db_token.pending_token = None
        db_token.pending_at = None


def _build_metrics_row(db, effective_device_id: int, payload) -> DeviceMetrics:
    """Create a DeviceMetrics row from the agent payload."""
    metrics = DeviceMetrics(
        device_id=effective_device_id,
        cpu_percent=payload.cpu_percent,
        ram_used_mb=payload.ram.used_mb,
        ram_total_mb=payload.ram.total_mb,
        ram_percent=payload.ram.percent,
        disk_json=json.dumps([d.model_dump() for d in payload.disk]) if payload.disk else None,
        temperature=payload.temperature,
        net_json=json.dumps(payload.network) if payload.network else None,
        patch_available=payload.patches.patch_available if payload.patches else 0,
        patch_security=payload.patches.patch_security if payload.patches else 0,
        patch_manager=payload.patches.patch_manager if payload.patches else None,
        reboot_required=payload.patches.reboot_required if payload.patches else False,
        major_upgrade_available=payload.patches.major_upgrade_available if payload.patches else None,
    )
    db.add(metrics)
    return metrics


def _build_config_payload(agent_config) -> dict:
    """Serialize the remote agent config dict."""
    return {
        "version": agent_config.version,
        "interval": agent_config.interval,
        "disk_paths": agent_config.disk_paths,
        "enable_temp": agent_config.enable_temp,
        "enable_patch_check": agent_config.enable_patch_check,
        "enable_scanner_relay": getattr(agent_config, "enable_scanner_relay", False),
    }


async def _persist_agent_report(db: AsyncSession, agent_token, payload, client_ip: str | None) -> dict:
    """Persist the agent report with up to 5 retries on stale/operational DB errors."""
    effective_device_id = agent_token.device_id

    for attempt in range(5):
        try:
            # Refresh objects in this transaction
            db_token = await db.get(AgentToken, agent_token.id)
            device = await db.get(Device, effective_device_id)

            if not device:
                # Fallback mapping if device was deleted/recreated
                dev_res = await db.execute(select(Device).where(Device.ip == client_ip))
                device = dev_res.scalar_one_or_none()
                if device:
                    db_token.device_id = device.id
                    effective_device_id = device.id
                else:
                    raise HTTPException(status_code=404, detail="Device mapping lost")

            _persist_device_metadata(db_token, device, payload)
            _build_metrics_row(db, effective_device_id, payload)

            # Fetch Config
            config_res = await db.execute(select(AgentConfig).where(AgentConfig.device_id == effective_device_id))
            agent_config = config_res.scalar_one_or_none()
            if not agent_config:
                agent_config = AgentConfig(device_id=effective_device_id)
                db.add(agent_config)
                await db.flush()

            config_to_send = _build_config_payload(agent_config)

            await db.commit()
            return config_to_send

        except (StaleDataError, OperationalError) as e:
            await db.rollback()
            if attempt < 4:
                wait = (attempt + 1) * 0.3
                await asyncio.sleep(wait)
                continue
            logger.error(f"Agent report persistence failed after 5 attempts: {e}")
            raise

    raise HTTPException(status_code=500, detail="Agent report persistence failed")


def _build_metrics_snapshot(payload, device_id: int) -> dict:
    """Build the WebSocket snapshot dict from a report payload."""
    return {
        "device_id": device_id,
        "cpu_percent": payload.cpu_percent,
        "ram": payload.ram.model_dump(),
        "disk": [d.model_dump() for d in payload.disk],
        "temperature": payload.temperature,
        "network": payload.network,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "patch_available": payload.patches.patch_available if payload.patches else 0,
        "patch_security": payload.patches.patch_security if payload.patches else 0,
        "patch_manager": payload.patches.patch_manager if payload.patches else None,
        "reboot_required": payload.patches.reboot_required if payload.patches else False,
        "major_upgrade_available": payload.patches.major_upgrade_available if payload.patches else None,
    }


async def _broadcast_metrics(payload, device_id: int) -> None:
    """Push the latest snapshot to all subscribed WebSockets, pruning dead links."""
    snapshot = _build_metrics_snapshot(payload, device_id)
    _latest_metrics[device_id] = snapshot

    if device_id not in _ws_subscribers:
        return

    dead_links = set()
    for ws in _ws_subscribers[device_id]:
        try:
            await ws.send_json({"type": "metrics", "data": snapshot})
        except Exception as e:
            logger.debug(f"Metrics WebSocket error for device {device_id}: {e}")
            dead_links.add(ws)
    _ws_subscribers[device_id] -= dead_links


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

    # Index 24h metrics in Python: {device_id: [metrics...]}
    from collections import defaultdict
    metrics_by_device: dict[int, list] = defaultdict(list)
    for m in all_24h_metrics:
        metrics_by_device[m.device_id].append(m)

    agents_list = []
    total_metrics_count = 0
    total_cpu = 0.0
    total_ram = 0.0
    active_count = 0

    for device_id in device_ids:
        device = device_map[device_id]
        token = token_map[device_id]
        device_metrics_24h = metrics_by_device[device_id]  # already sorted desc
        last_m = device_metrics_24h[0] if device_metrics_24h else None

        m_count = total_count_map.get(device_id, 0)
        total_metrics_count += m_count

        is_active = _is_agent_active(token, now)
        if is_active:
            active_count += 1

        uptime_pct = _compute_uptime_pct(token, now, cutoff_24h, device_metrics_24h)
        uptime_history = _compute_uptime_history(token, now, cutoff_24h, device_metrics_24h)

        if last_m:
            total_cpu += last_m.cpu_percent
            total_ram += last_m.ram_percent

        agents_list.append(_build_agent_summary(device, token, last_m, m_count, is_active, uptime_pct, uptime_history))

    n = len(agents_list)
    return AgentsOverviewResponse(
        agents=agents_list,
        total_agents=n,
        active_agents=active_count,
        total_data_points=total_metrics_count,
        avg_cpu=total_cpu / n if n else 0.0,
        avg_ram=total_ram / n if n else 0.0
    )


def _is_agent_active(token, now: datetime) -> bool:
    """Active = last heartbeat within 5 minutes."""
    last_seen = ensure_utc(token.last_seen)
    return bool(last_seen and (now - last_seen).total_seconds() < 300)


def _compute_uptime_pct(token, now: datetime, cutoff_24h: datetime, device_metrics_24h: list) -> float:
    """Uptime % for the last 24h based on expected heartbeat count."""
    created_at = ensure_utc(token.created_at)
    time_known = now - (created_at or cutoff_24h)
    relevant_window = min(timedelta(hours=24), time_known)
    window_seconds = max(60, relevant_window.total_seconds())
    expected = window_seconds / 30.0
    day_count = len(device_metrics_24h)
    return min(100.0, (day_count / expected) * 100.0) if expected > 0 else 100.0


def _compute_uptime_history(token, now: datetime, cutoff_24h: datetime, device_metrics_24h: list) -> list[float]:
    """Hourly uptime history computed in Python from pre-fetched data (0 extra queries)."""
    created_at = ensure_utc(token.created_at)
    agent_birth = created_at or cutoff_24h
    uptime_history: list[float] = []
    for h in range(24):
        h_start = cutoff_24h + timedelta(hours=h)
        h_end = h_start + timedelta(hours=1)
        if h_start < agent_birth:
            uptime_history.append(100.0)  # unknown period → assume up
            continue
        h_count = sum(1 for m in device_metrics_24h if h_start.replace(tzinfo=None) <= m.timestamp < h_end.replace(tzinfo=None))
        uptime_history.append(min(100.0, (h_count / 120.0) * 100.0))
    return uptime_history


def _build_agent_summary(device, token, last_m, m_count: int, is_active: bool, uptime_pct: float, uptime_history: list[float]) -> AgentSummary:
    """Assemble a single AgentSummary entry from prefetched data."""
    return AgentSummary(
        device_id=device.id,
        hostname=device.hostname or device.display_name,
        ip=device.ip,
        is_online=is_active,
        agent_version=token.agent_version,
        os_pretty=token.os_pretty,
        os_name=token.os_name,
        os_version=token.os_version,
        os_codename=token.os_codename,
        os_arch=token.os_arch,
        os_kernel=token.os_kernel,
        last_seen=token.last_seen,
        cpu_usage=last_m.cpu_percent if last_m else 0.0,
        ram_usage=last_m.ram_percent if last_m else 0.0,
        temp=last_m.temperature if last_m else None,
        uptime_pct=uptime_pct,
        uptime_history=uptime_history,
        metrics_count=m_count,
        has_pending_token=bool(token.pending_token),
        pending_at=token.pending_at,
        patch_available=last_m.patch_available if last_m else 0,
        patch_security=last_m.patch_security if last_m else 0,
        patch_manager=last_m.patch_manager if last_m else None,
        reboot_required=last_m.reboot_required if last_m else False,
        major_upgrade_available=last_m.major_upgrade_available if last_m else None
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
    
    # Group by 15-minute intervals in Python
    buckets = {}
    
    for ts, cpu, ram in all_metrics:
        # Bucket: Round down to the nearest 15 minutes
        bucket_ts = ts.replace(minute=(ts.minute // 15) * 15, second=0, microsecond=0)
        if bucket_ts not in buckets:
            buckets[bucket_ts] = {"cpu": [], "ram": [], "count": 0}
        
        buckets[bucket_ts]["cpu"].append(cpu)
        buckets[bucket_ts]["ram"].append(ram)
        buckets[bucket_ts]["count"] += 1
        
    history_list = []
    # Ensure we have a sorted list of buckets
    for b_ts in sorted(buckets.keys()):
        b_data = buckets[b_ts]
        history_list.append(GlobalMetricPoint(
            timestamp=b_ts,
            avg_cpu=sum(b_data["cpu"]) / len(b_data["cpu"]) if b_data["cpu"] else 0.0,
            avg_ram=sum(b_data["ram"]) / len(b_data["ram"]) if b_data["ram"] else 0.0,
            data_points=b_data["count"]
        ))
        
    return GlobalMetricsResponse(history=history_list)


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


def downsample_metrics(metrics: list[DeviceMetrics], range_str: str) -> list[dict]:
    """Aggregates and downsamples metrics into buckets to optimize transmission and chart performance."""
    if not metrics:
        return []

    # Map range to bucket size in seconds
    bucket_seconds = {
        "6h": 300,       # 5 minutes
        "24h": 900,      # 15 minutes
        "7d": 7200,      # 2 hours
        "30d": 21600     # 6 hours
    }.get(range_str, 900)

    buckets = {}
    for m in metrics:
        ts = ensure_utc(m.timestamp)
        if not ts:
            continue
        ts_epoch = int(ts.timestamp())
        bucket_epoch = (ts_epoch // bucket_seconds) * bucket_seconds

        if bucket_epoch not in buckets:
            buckets[bucket_epoch] = {
                "cpu_percent": [],
                "ram_percent": [],
                "ram_used_mb": [],
                "ram_total_mb": [],
                "temperature": [],
                "disk_json": None,
                "net_json": None
            }

        b = buckets[bucket_epoch]
        b["cpu_percent"].append(m.cpu_percent)
        b["ram_percent"].append(m.ram_percent)
        b["ram_used_mb"].append(m.ram_used_mb)
        b["ram_total_mb"].append(m.ram_total_mb)
        if m.temperature is not None:
            b["temperature"].append(m.temperature)

        if m.disk_json:
            b["disk_json"] = m.disk_json
        if m.net_json:
            b["net_json"] = m.net_json

    snapshots = []
    import json
    for epoch in sorted(buckets.keys()):
        b = buckets[epoch]

        avg_cpu = sum(b["cpu_percent"]) / len(b["cpu_percent"]) if b["cpu_percent"] else 0.0
        avg_ram = sum(b["ram_percent"]) / len(b["ram_percent"]) if b["ram_percent"] else 0.0
        avg_ram_used = int(sum(b["ram_used_mb"]) / len(b["ram_used_mb"])) if b["ram_used_mb"] else 0
        avg_ram_total = int(sum(b["ram_total_mb"]) / len(b["ram_total_mb"])) if b["ram_total_mb"] else 0

        avg_temp = None
        if b["temperature"]:
            avg_temp = sum(b["temperature"]) / len(b["temperature"])

        disk = json.loads(b["disk_json"]) if b["disk_json"] else []
        network = json.loads(b["net_json"]) if b["net_json"] else {}

        snapshots.append({
            "cpu_percent": avg_cpu,
            "ram": {
                "used_mb": avg_ram_used,
                "total_mb": avg_ram_total,
                "percent": avg_ram
            },
            "disk": disk,
            "temperature": avg_temp,
            "network": network,
            "timestamp": datetime.fromtimestamp(epoch, tz=timezone.utc)
        })

    return snapshots


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
        await get_current_admin(conn=request, authorization=authorization, token=None, db=db)

    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
        
    # Get or create token
    token_res = await db.execute(select(AgentToken).where(AgentToken.device_id == device_id))
    token_obj = token_res.scalar_one_or_none()
    if not token_obj:
        import secrets
        token = secrets.token_hex(32)
        token_obj = AgentToken(device_id=device_id, token=token, is_active=True)
        db.add(token_obj)
        await db.commit()
    else:
        token = token_obj.token

    # Detect Server URL (same logic as in deploy)
    server_url = await _detect_server_url(db)

    # Generate JSON config
    config_data = {
        "server_url": server_url,
        "token": token,
        "device_id": device_id,
        "interval": 30
    }
    return PlainTextResponse(json.dumps(config_data, indent=2))


_INSTALL_CODE_REJECTED_SCRIPT = """#!/bin/bash
echo "Error: this GravityLAN install command is invalid, expired or was already used." >&2
echo "Copy a fresh install command from the device's Agent tab in the GravityLAN UI." >&2
exit 1
"""


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

    script = f"""#!/bin/bash
set -e
echo "--- GravityLAN Agent Installer ---"

INSTALL_DIR="/opt/gravitylan-agent"
SERVER_URL={shlex.quote(server_url)}
DEVICE_ID={shlex.quote(str(device_id))}
ENROLL_CODE={shlex.quote(code)}

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root to install the agent."
  echo "Please run the command with sudo bash:"
  echo "curl -sSL '$SERVER_URL/api/agent/download/install-sh/$DEVICE_ID?code=$ENROLL_CODE' | sudo bash"
  exit 1
fi

# Check prerequisites before anything of the current installation is touched.
PYTHON_BIN="$(command -v python3 || command -v python || true)"
if [ -z "$PYTHON_BIN" ]; then
  echo "Error: Python 3 was not found on this host. Install it first (on Unraid e.g. via a Python 3 plugin) and run the command again." >&2
  exit 1
fi
if [ -d /run/systemd/system ]; then
  START_MODE="systemd"
elif [ -f /etc/synoinfo.conf ] && [ -d /usr/local/etc/rc.d ]; then
  START_MODE="synology"
else
  # e.g. Unraid (Slackware, no systemd) or OpenRC distributions
  START_MODE="background"
fi

# Download first, so an expired install code never leaves the host without its current agent.
echo "1. Downloading agent and config..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL "$SERVER_URL/api/agent/download/agent" -o "$TMP_DIR/gravitylan-agent.py" || {{
  echo "Error: could not download the agent from $SERVER_URL - is the GravityLAN server reachable from this host?" >&2
  exit 1
}}
curl -fsSL "$SERVER_URL/api/agent/download/config/$DEVICE_ID?code=$ENROLL_CODE" -o "$TMP_DIR/agent.conf" || {{
  echo "Error: the install code is invalid, expired or was already used." >&2
  echo "Copy a fresh install command from the device's Agent tab in the GravityLAN UI." >&2
  exit 1
}}

echo "2. Cleaning up old versions..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop gravitylan-agent.service 2>/dev/null || true
fi
pkill -9 -f '[g]ravitylan-agent\\.py' 2>/dev/null || true
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mv "$TMP_DIR/gravitylan-agent.py" "$TMP_DIR/agent.conf" "$INSTALL_DIR/"

echo "3. Starting the agent ($START_MODE)..."
if [ "$START_MODE" = "systemd" ]; then
cat > /etc/systemd/system/gravitylan-agent.service <<EOF
[Unit]
Description=GravityLAN System Monitor Agent
After=network-online.target

[Service]
Type=simple
ExecStart=$PYTHON_BIN $INSTALL_DIR/gravitylan-agent.py
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=10
PrivateTmp=true
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable gravitylan-agent
  systemctl restart gravitylan-agent
elif [ "$START_MODE" = "synology" ]; then
  cat > /usr/local/etc/rc.d/S99gravitylan-agent.sh <<EOF
#!/bin/sh
# GravityLAN Agent start script for Synology
case "\\$1" in
  start) cd $INSTALL_DIR && $PYTHON_BIN $INSTALL_DIR/gravitylan-agent.py > $INSTALL_DIR/gravitylan-agent.log 2>&1 < /dev/null & ;;
  stop) pkill -f '[g]ravitylan-agent\\.py' ;;
  restart) "\\$0" stop; sleep 2; "\\$0" start ;;
esac
exit 0
EOF
  chmod +x /usr/local/etc/rc.d/S99gravitylan-agent.sh
  /usr/local/etc/rc.d/S99gravitylan-agent.sh start
else
  # stdin from /dev/null: under `curl ... | bash` stdin is the script itself. No subshell,
  # so nothing keeps waiting on the agent or holding the terminal/pipe open.
  cd "$INSTALL_DIR"
  nohup "$PYTHON_BIN" "$INSTALL_DIR/gravitylan-agent.py" > "$INSTALL_DIR/gravitylan-agent.log" 2>&1 < /dev/null &
  cd - > /dev/null
fi

if [ -f /etc/unraid-version ]; then
  # Unraid runs from RAM (/opt is empty after a reboot): keep a copy on the flash drive
  # and start it from /boot/config/go. The marked block is replaced on every install.
  PERSIST_DIR="/boot/config/gravitylan-agent"
  mkdir -p "$PERSIST_DIR"
  cp "$INSTALL_DIR/gravitylan-agent.py" "$INSTALL_DIR/agent.conf" "$PERSIST_DIR/"
  touch /boot/config/go
  sed -i '/^# >>> gravitylan-agent/,/^# <<< gravitylan-agent/d' /boot/config/go
  cat >> /boot/config/go <<'GOEOF'
# >>> gravitylan-agent (added by the GravityLAN installer; delete this block to disable)
( for i in $(seq 1 60); do command -v python3 >/dev/null 2>&1 && break; sleep 5; done
  mkdir -p /opt/gravitylan-agent && cp /boot/config/gravitylan-agent/* /opt/gravitylan-agent/
  cd /opt/gravitylan-agent && exec nohup python3 gravitylan-agent.py > gravitylan-agent.log 2>&1 ) < /dev/null > /dev/null 2>&1 &
# <<< gravitylan-agent
GOEOF
  echo "   Unraid: a copy is kept on the flash drive and starts from /boot/config/go after a reboot."
elif [ "$START_MODE" = "background" ]; then
  echo "   Note: no systemd found - the agent runs in the background but will not start again by itself after a reboot."
fi

sleep 2
if pgrep -f '[g]ravitylan-agent\\.py' >/dev/null 2>&1; then
  echo "--- Installation Complete: the agent is running ---"
else
  echo "Warning: the agent does not seem to be running. See $INSTALL_DIR/gravitylan-agent.log or the service status." >&2
fi
if [ "$START_MODE" = "systemd" ]; then
  systemctl status gravitylan-agent --no-pager || true
fi
"""
    return PlainTextResponse(script)


async def _ssh_login(db: AsyncSession, device: Device, req: AgentInstallRequest, http_request: Request) -> dict:
    """SSH arguments for deploy/uninstall: the typed-in credentials, or a saved key connection of the device.

    Saved connections follow the SSH terminal's rules (ADR-002): browser sessions
    only, never API or master tokens, and only to a host whose key the user has
    already confirmed there.
    """
    if req.profile_id is None:
        if not req.ssh_user:
            raise HTTPException(status_code=400, detail="Enter an SSH user or choose a saved connection.")
        return dict(
            host_ip=device.ip, ssh_user=req.ssh_user, ssh_password=req.ssh_password,
            ssh_key=req.ssh_key, ssh_port=req.ssh_port,
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
            token=token,
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

    script = f"""#!/bin/bash
echo "--- GravityLAN Agent Uninstaller ---"

INSTALL_DIR="/opt/gravitylan-agent"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root to uninstall the agent."
  echo "Please run the command with sudo bash (e.g. curl -sSL ... | sudo bash)"
  exit 1
fi

echo "1. Stopping the agent..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop gravitylan-agent.service 2>/dev/null || true
  systemctl disable gravitylan-agent.service 2>/dev/null || true
fi
if [ -x /usr/local/etc/rc.d/S99gravitylan-agent.sh ]; then
  /usr/local/etc/rc.d/S99gravitylan-agent.sh stop 2>/dev/null || true
fi
pkill -9 -f '[g]ravitylan-agent\\.py' 2>/dev/null || true

echo "2. Removing files..."
rm -f /etc/systemd/system/gravitylan-agent.service /usr/local/etc/rc.d/S99gravitylan-agent.sh
rm -rf "$INSTALL_DIR"
# Unraid: the boot hook in /boot/config/go and the copy on the flash drive
if [ -f /boot/config/go ]; then
  sed -i '/^# >>> gravitylan-agent/,/^# <<< gravitylan-agent/d' /boot/config/go
fi
rm -rf /boot/config/gravitylan-agent

if command -v systemctl >/dev/null 2>&1; then
  echo "3. Reloading systemd..."
  systemctl daemon-reload 2>/dev/null || true
fi

echo "--- Uninstallation Complete ---"
"""
    return PlainTextResponse(script)
    
@router.post("/adopt/{device_id}")
async def adopt_agent_token(device_id: int, db: AsyncSession = Depends(get_db), current_user: str = Depends(get_current_admin)):
    """Manually adopt a pending token for a device."""
    token_res = await db.execute(select(AgentToken).where(AgentToken.device_id == device_id))
    token_obj = token_res.scalar_one_or_none()
    
    if not token_obj or not token_obj.pending_token:
        raise HTTPException(status_code=400, detail="No pending token found for this device")
    
    # Move pending token to active token
    old_token = token_obj.token
    token_obj.token = token_obj.pending_token
    token_obj.pending_token = None
    token_obj.pending_at = None
    token_obj.is_active = True
    
    await db.commit()
    logger.info("Device %d adopted new token (Replaced %s... with %s...)", 
                device_id, old_token[:8], token_obj.token[:8])
    
    return {"status": "ok", "message": "Token adopted successfully"}


# ---------------------------------------------------------------------------
# Linux Package Patching Endpoints
# ---------------------------------------------------------------------------

from app.schemas.agent import DevicePatchesResponse, PatchActionRequest, PackageUpdateInfo
from app.services.patch_service import list_device_updates, run_ssh_command_stream
import time
import uuid

# Cache for temporary patch session credentials
_temp_patch_tokens: Dict[str, Dict[str, Any]] = {}
PATCH_TOKEN_TTL_SECONDS = 60

@router.post("/patches/{device_id}/query", response_model=DevicePatchesResponse)
async def query_device_patches(
    device_id: int,
    request: AgentDeployRequest,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
) -> DevicePatchesResponse:
    """Query available package updates from the remote host using SSH credentials."""
    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    result = await list_device_updates(
        host_ip=device.ip,
        ssh_user=request.ssh_user,
        ssh_password=request.ssh_password,
        ssh_key=request.ssh_key,
        ssh_port=request.ssh_port
    )

    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])

    packages = [
        PackageUpdateInfo(
            package=p["package"],
            current_version=p["current_version"],
            new_version=p["new_version"],
            repo=p.get("repo")
        ) for p in result["packages"]
    ]

    return DevicePatchesResponse(
        device_id=device_id,
        patch_manager=result["patch_manager"],
        packages=packages,
        major_upgrade_available=result.get("major_upgrade_available")
    )


@router.post("/patches/{device_id}/prepare")
async def prepare_patch_action(
    device_id: int,
    request: PatchActionRequest,
    db: AsyncSession = Depends(get_db),
    current_admin: str = Depends(get_current_admin)
):
    """Generate a temporary token to run updates over WebSocket."""
    device = await db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    # Generate a unique token
    token = f"patch_tok_{uuid.uuid4().hex}"
    
    # Store credentials and parameters temporarily (expires in 60s)
    _temp_patch_tokens[token] = {
        "device_id": device_id,
        "host_ip": device.ip,
        "ssh_user": request.ssh_user,
        "ssh_password": request.ssh_password,
        "ssh_key": request.ssh_key,
        "ssh_port": request.ssh_port,
        "mode": request.mode,
        "created_at": time.time()
    }

    # Clean up expired tokens
    now = time.time()
    expired = [k for k, v in _temp_patch_tokens.items() if now - v["created_at"] > PATCH_TOKEN_TTL_SECONDS]
    for k in expired:
        _temp_patch_tokens.pop(k, None)

    return {"patch_token": token}


async def _send_ws_text(websocket: WebSocket, text: str) -> bool:
    """Send text to the client; False when it has already disconnected."""
    try:
        await websocket.send_text(text)
        return True
    except (WebSocketDisconnect, RuntimeError, OSError):
        return False


async def _consume_patch_session(websocket: WebSocket, device_id: int) -> dict | None:
    """Validate and consume the one-shot patch session token; returns session data or None.

    The error message is awaited (not a fire-and-forget task), so it reaches the
    client before the caller closes the WebSocket.
    """
    patch_token = websocket.query_params.get("patch_token")
    session_data = _temp_patch_tokens.pop(patch_token, None) if patch_token else None
    if session_data is None or time.time() - session_data["created_at"] > PATCH_TOKEN_TTL_SECONDS:
        await _send_ws_text(websocket, "\r\n[Error] Invalid or expired patch session token. Please try again.\r\n")
        return None

    if session_data["device_id"] != device_id:
        await _send_ws_text(websocket, "\r\n[Error] Session token device ID mismatch.\r\n")
        return None
    return session_data


def _build_update_command(pkg_manager: str, mode: str) -> str | None:
    """Build the shell command for the given package manager and update mode."""
    if pkg_manager == "apt":
        if mode == "security-only":
            return "DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" $(apt-get -s upgrade | awk '/^Inst/ { if ($0 ~ /security/ || $0 ~ /Security/) print $2 }')"
        return "DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\""
    if pkg_manager == "dnf":
        return "dnf upgrade --security -y" if mode == "security-only" else "dnf upgrade -y"
    if pkg_manager == "yum":
        return "yum update --security -y" if mode == "security-only" else "yum update -y"
    return None


async def _push_metrics_to_subscribers(device_id: int) -> None:
    """Push the current snapshot to all WebSocket subscribers (best-effort)."""
    if device_id not in _ws_subscribers or device_id not in _latest_metrics:
        return
    for ws in _ws_subscribers[device_id]:
        try:
            await ws.send_json({"type": "metrics", "data": _latest_metrics[device_id]})
        except Exception:
            pass


async def _clear_device_patch_state(device_id: int) -> None:
    """Reset patch counters in DB and push updated metrics to subscribers."""
    try:
        async with async_session() as db:
            metrics_res = await db.execute(
                select(DeviceMetrics)
                .where(DeviceMetrics.device_id == device_id)
                .order_by(DeviceMetrics.timestamp.desc())
            )
            last_metric = metrics_res.scalars().first()
            if not last_metric:
                return
            last_metric.patch_available = 0
            last_metric.patch_security = 0
            await db.commit()

            if device_id in _latest_metrics:
                _latest_metrics[device_id]["patch_available"] = 0
                _latest_metrics[device_id]["patch_security"] = 0
                await _push_metrics_to_subscribers(device_id)
    except Exception as e:
        logger.error("Failed to update database metrics after patch execution: %s", e)


@router.websocket("/patches/{device_id}/run-ws")
async def run_patches_websocket(websocket: WebSocket, device_id: int):
    """WebSocket endpoint to run updates and stream output live to the frontend."""
    # Authenticate websocket first (standard browser-session/API-token check)
    from app.api.auth import authenticate_websocket_authorized
    auth_info = await authenticate_websocket_authorized(
        websocket, endpoint_type="agent", device_id=device_id,
        allowed_levels=("session", "master", "master_legacy", "api_token"),
    )
    if not auth_info:
        return

    # Accept the connection
    await websocket.accept()

    # Validate and consume the one-shot patch session token
    session_data = await _consume_patch_session(websocket, device_id)
    if not session_data:
        await websocket.close(code=4001, reason="Invalid session token")
        return

    mode = session_data["mode"]
    host_ip = session_data["host_ip"]
    ssh_user = session_data["ssh_user"]
    ssh_password = session_data["ssh_password"]
    ssh_key = session_data["ssh_key"]
    ssh_port = session_data["ssh_port"]

    # Detect package manager or construct update commands
    await websocket.send_text("[Info] Starting update session...\r\n")
    await websocket.send_text("[Info] Detecting target system configuration...\r\n")
    
    try:
        probe = await list_device_updates(
            host_ip=host_ip,
            ssh_user=ssh_user,
            ssh_password=ssh_password,
            ssh_key=ssh_key,
            ssh_port=ssh_port
        )
    except Exception as e:
        logger.exception("SSH probe failed for device %s", device_id)
        await websocket.send_text(f"[Error] SSH probe failed: {e}\r\n")
        await websocket.close()
        return
    
    pkg_manager = probe.get("patch_manager")
    if not pkg_manager:
        probe_error = probe.get("error")
        if probe_error:
            await websocket.send_text(f"[Error] {probe_error}\r\n")
        else:
            detected_os = probe.get("detected_os")
            detail = detected_os or "no recognizable package manager found"
            await websocket.send_text("[Error] Unsupported package manager or system type.\r\n")
            await websocket.send_text(f"[Info] Target system reports: {detail}\r\n")
        await websocket.close()
        return

    await websocket.send_text(f"[Info] Detected package manager: {pkg_manager}\r\n")

    cmd = _build_update_command(pkg_manager, mode)
    if cmd is None:
        await websocket.send_text(f"[Error] Package manager {pkg_manager} is not supported.\r\n")
        await websocket.close()
        return

    if mode == "security-only":
        await websocket.send_text("[Info] Running security updates only...\r\n")
    else:
        await websocket.send_text("[Info] Running full system upgrade...\r\n")

    # Awaited per chunk by run_ssh_command_stream: output arrives in order and no
    # send task is left behind. If the browser goes away mid-run, the update keeps
    # running to completion on the host (aborting apt/dnf halfway is worse) and
    # the remaining output is dropped.
    client_connected = True

    async def stream_callback(data: str) -> None:
        nonlocal client_connected
        if client_connected:
            cleaned = data.replace("\r\n", "\n").replace("\n", "\r\n")
            client_connected = await _send_ws_text(websocket, cleaned)
            if not client_connected:
                logger.info("Patch run on device %s: client disconnected, update continues on the host", device_id)

    # Execute and stream
    success, msg = await run_ssh_command_stream(
        host_ip=host_ip,
        ssh_user=ssh_user,
        ssh_password=ssh_password,
        ssh_key=ssh_key,
        ssh_port=ssh_port,
        command=cmd,
        output_callback=stream_callback
    )

    if success:
        await _clear_device_patch_state(device_id)
    if not client_connected:
        return

    if success:
        await _send_ws_text(websocket, "\r\n[Success] Updates completed successfully!\r\n")
    else:
        await _send_ws_text(websocket, f"\r\n[Error] Update failed: {msg}\r\n")

    try:
        await websocket.close()
    except (RuntimeError, OSError):
        pass
