"""Agent Telemetry Service — Time-series metrics processing, persistence, and WebSocket broadcasting."""

import asyncio
import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from fastapi import HTTPException, WebSocket
from sqlalchemy import desc, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from app.models.agent import AgentConfig, AgentToken, DeviceMetrics
from app.models.device import Device
from app.models.setting import Setting
from app.scanner.utils import ensure_utc
from app.schemas.agent import AgentSummary, GlobalMetricPoint

logger = logging.getLogger(__name__)

# Global caches for real-time dashboard updates
_latest_metrics: Dict[int, Dict[str, Any]] = {}
_ws_subscribers: Dict[int, set[WebSocket]] = {}
_setting_cache: Dict[str, Any] = {}
_setting_cache_time: datetime = datetime.min.replace(tzinfo=timezone.utc)


def _hash_agent_token(raw_token: str) -> str:
    """Compute SHA-256 hex digest for an agent bearer token."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


async def _find_and_migrate_agent_token(
    session: AsyncSession,
    raw_token: str,
    device_id: int | None = None,
) -> AgentToken | None:
    """Look up AgentToken by SHA-256 hash or legacy plaintext UUID; auto-upgrade plaintext to hash."""
    token_hash = _hash_agent_token(raw_token)
    stmt = select(AgentToken).where(
        AgentToken.token.in_([token_hash, raw_token]),
        AgentToken.is_active.is_(True),
    )
    if device_id is not None:
        stmt = stmt.where(AgentToken.device_id == device_id)
    res = await session.execute(stmt)
    agent_token = res.scalars().first()
    if agent_token and agent_token.token == raw_token and len(raw_token) != 64:
        logger.info(f"Auto-migrating legacy agent token to SHA-256 hash for device {agent_token.device_id}")
        agent_token.token = token_hash
        await session.commit()
    return agent_token


async def _get_auto_adopt_setting(db: AsyncSession) -> bool:
    """Read the auto-adoption setting with a 5-minute global cache."""
    global _setting_cache_time
    now = datetime.now(timezone.utc)
    if "allow_auto_adopt" not in _setting_cache or (now - _setting_cache_time).total_seconds() > 300:
        adopt_res = await db.execute(select(Setting).where(Setting.key == "agent.allow_auto_adoption"))
        allow_adopt_setting = adopt_res.scalar_one_or_none()
        _setting_cache["allow_auto_adopt"] = allow_adopt_setting.value.lower() == "true" if allow_adopt_setting else False
        _setting_cache_time = now
    return _setting_cache["allow_auto_adopt"]


def _is_device_stale(now: datetime, device: Device, token_obj: AgentToken | None) -> bool:
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
    agent_token: AgentToken | None,
    token: str,
    client_ip: str | None,
    device_id: int,
    allow_auto_adopt: bool,
) -> AgentToken:
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


def _persist_device_metadata(db_token: AgentToken, device: Device, payload: Any) -> None:
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


def _build_metrics_row(db: AsyncSession, effective_device_id: int, payload: Any) -> DeviceMetrics:
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


def _build_config_payload(agent_config: AgentConfig) -> dict:
    """Serialize the remote agent config dict."""
    return {
        "version": agent_config.version,
        "interval": agent_config.interval,
        "disk_paths": agent_config.disk_paths,
        "enable_temp": agent_config.enable_temp,
        "enable_patch_check": agent_config.enable_patch_check,
        "enable_scanner_relay": getattr(agent_config, "enable_scanner_relay", False),
    }


async def _persist_agent_report(db: AsyncSession, agent_token: AgentToken, payload: Any, client_ip: str | None) -> dict:
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
                    if db_token:
                        db_token.device_id = device.id
                    effective_device_id = device.id
                else:
                    raise HTTPException(status_code=404, detail="Device mapping lost")

            if db_token and device:
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


def _build_metrics_snapshot(payload: Any, device_id: int) -> dict:
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


async def _broadcast_metrics(payload: Any, device_id: int) -> None:
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

    buckets: dict[int, dict[str, Any]] = {}
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


def _is_agent_active(token: AgentToken, now: datetime) -> bool:
    """Active = last heartbeat within 5 minutes."""
    last_seen = ensure_utc(token.last_seen)
    return bool(last_seen and (now - last_seen).total_seconds() < 300)


def _compute_uptime_pct(token: AgentToken, now: datetime, cutoff_24h: datetime, device_metrics_24h: list) -> float:
    """Uptime % for the last 24h based on expected heartbeat count."""
    created_at = ensure_utc(token.created_at)
    time_known = now - (created_at or cutoff_24h)
    relevant_window = min(timedelta(hours=24), time_known)
    window_seconds = max(60, relevant_window.total_seconds())
    expected = window_seconds / 30.0
    day_count = len(device_metrics_24h)
    return min(100.0, (day_count / expected) * 100.0) if expected > 0 else 100.0


def _compute_uptime_history(token: AgentToken, now: datetime, cutoff_24h: datetime, device_metrics_24h: list) -> list[float]:
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


def _build_agent_summary(device: Device, token: AgentToken, last_m: DeviceMetrics | None, m_count: int, is_active: bool, uptime_pct: float, uptime_history: list[float]) -> AgentSummary:
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


def assemble_agents_overview_data(
    device_ids: list[int],
    device_map: dict[int, Device],
    token_map: dict[int, AgentToken],
    all_24h_metrics: list[DeviceMetrics],
    total_count_map: dict[int, int],
    now: datetime,
    cutoff_24h: datetime,
) -> tuple[list[AgentSummary], int, int, int, float, float]:
    """Aggregate metrics and calculate averages for all agent devices in one pass."""
    from collections import defaultdict
    metrics_by_device: dict[int, list[DeviceMetrics]] = defaultdict(list)
    for m in all_24h_metrics:
        metrics_by_device[m.device_id].append(m)

    agents_list: list[AgentSummary] = []
    total_metrics_count = 0
    total_cpu = 0.0
    total_ram = 0.0
    active_count = 0

    for device_id in device_ids:
        device = device_map[device_id]
        token = token_map[device_id]
        device_metrics_24h = metrics_by_device[device_id]
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
    avg_cpu = total_cpu / n if n else 0.0
    avg_ram = total_ram / n if n else 0.0
    return agents_list, n, active_count, total_metrics_count, avg_cpu, avg_ram


def aggregate_global_metrics_buckets(all_metrics: list) -> list[GlobalMetricPoint]:
    """Group 24h metrics into sorted 15-minute average buckets."""
    buckets: dict[datetime, dict[str, Any]] = {}
    for ts, cpu, ram in all_metrics:
        bucket_ts = ts.replace(minute=(ts.minute // 15) * 15, second=0, microsecond=0)
        if bucket_ts not in buckets:
            buckets[bucket_ts] = {"cpu": [], "ram": [], "count": 0}
        buckets[bucket_ts]["cpu"].append(cpu)
        buckets[bucket_ts]["ram"].append(ram)
        buckets[bucket_ts]["count"] += 1

    history_list: list[GlobalMetricPoint] = []
    for b_ts in sorted(buckets.keys()):
        b_data = buckets[b_ts]
        history_list.append(GlobalMetricPoint(
            timestamp=b_ts,
            avg_cpu=sum(b_data["cpu"]) / len(b_data["cpu"]) if b_data["cpu"] else 0.0,
            avg_ram=sum(b_data["ram"]) / len(b_data["ram"]) if b_data["ram"] else 0.0,
            data_points=b_data["count"]
        ))
    return history_list
