"""Health summary endpoint for GravityLAN."""

import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.database import get_db
from app.api.auth import get_current_admin
from app.models.device import Device, DeviceHistory
from app.models.agent import AgentToken, DeviceMetrics
from app.schemas.health import HealthSummaryResponse
from app.api.summary import get_summary
from app.version import VERSION
from app.scanner.utils import ensure_utc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/health", tags=["health"])

@router.get("/summary", response_model=HealthSummaryResponse)
async def get_health_summary(
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
) -> HealthSummaryResponse:
    """Fetch a single aggregated status summary representing the network's health."""
    now = datetime.now(timezone.utc)
    
    # 1. Device counts
    devices_res = await db.execute(select(Device.id, Device.is_online))
    devices = devices_res.all()
    total_devices = len(devices)
    online_devices = sum(1 for d in devices if d.is_online)
    offline_devices = total_devices - online_devices
    
    # 2. Agent counts
    agents_res = await db.execute(select(AgentToken))
    agents = agents_res.scalars().all()
    total_agents = len(agents)
    
    offline_agents = 0
    active_device_ids = []
    for agent in agents:
        last_seen = ensure_utc(agent.last_seen)
        is_active = bool(agent.is_active and last_seen and (now - last_seen).total_seconds() < 300)
        if not is_active:
            offline_agents += 1
        else:
            active_device_ids.append(agent.device_id)
            
    # Calculate high CPU (> 90%) and high temperature (> 75°C) active agents
    high_cpu = 0
    high_temp = 0
    if active_device_ids:
        metrics_res = await db.execute(
            select(DeviceMetrics).where(DeviceMetrics.id.in_(
                select(func.max(DeviceMetrics.id)).group_by(DeviceMetrics.device_id)
            ))
        )
        latest_metrics = metrics_res.scalars().all()
        for m in latest_metrics:
            if m.device_id in active_device_ids:
                if m.cpu_percent > 90.0:
                    high_cpu += 1
                if m.temperature is not None and m.temperature > 75.0:
                    high_temp += 1
                    
    # 3. Active issues by type
    summary = await get_summary(token, db)
    active_issues_count = len(summary.active_issues)
    issues_by_type = {"agent_offline": 0, "service_down": 0}
    for issue in summary.active_issues:
        issues_by_type[issue.type] = issues_by_type.get(issue.type, 0) + 1
        
    # 4. Notifications
    unread_res = await db.execute(select(func.count(DeviceHistory.id)))
    unread_count = unread_res.scalar_one()
    
    # DeviceHistory.timestamp is naive UTC (SQLite CURRENT_TIMESTAMP); local server time
    # shifted the window by the UTC offset
    cutoff_30min = now.replace(tzinfo=None) - timedelta(minutes=30)
    fresh_res = await db.execute(select(func.count(DeviceHistory.id)).where(DeviceHistory.timestamp >= cutoff_30min))
    fresh_count = fresh_res.scalar_one()
    
    # 5. Scanner
    scanner_status = summary.scanner.status
    is_scanner_running = scanner_status in ("running", "discovering", "identifying")
    last_scan = summary.scanner.last_scan
    stale_hours = None
    if last_scan:
        stale_hours = round((now - last_scan).total_seconds() / 3600.0, 1)
        
    return HealthSummaryResponse(
        api_version=VERSION,
        devices={
            "total": total_devices,
            "online": online_devices,
            "offline": offline_devices
        },
        agents={
            "total": total_agents,
            "high_cpu": high_cpu,
            "high_temp": high_temp,
            "offline_agents": offline_agents
        },
        issues={
            "active": active_issues_count,
            "by_type": issues_by_type
        },
        notifications={
            "unread": unread_count,
            "fresh_30min": fresh_count
        },
        scanner={
            "running": is_scanner_running,
            "last_run": last_scan,
            "stale_hours": stale_hours
        }
    )
