import hmac
from pydantic import RootModel
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import delete, select, text
from app.database import get_db
from app.models.device import Device, Service, DeviceGroup
from app.models.setting import Setting
import logging

logger = logging.getLogger(__name__)
from app.api.auth import get_current_admin

router = APIRouter(prefix="/api/settings", tags=["settings"])

@router.get("", dependencies=[Depends(get_current_admin)])
async def get_all_settings(db: AsyncSession = Depends(get_db)):
    """Fetch all system settings as a key-value dictionary, excluding secrets."""
    result = await db.execute(select(Setting))
    settings = result.scalars().all()
    # Filter out sensitive keys to prevent credentials leakage (P0 security fix)
    sensitive_keys = {"api.master_token", "api.admin_password"}
    return {s.key: s.value for s in settings if s.key not in sensitive_keys}

SettingsUpdate = RootModel[dict[str, str]]


def _validate_server_url(value: str) -> None:
    """Reject server URLs that are not valid HTTP(S) URLs without spaces."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError()
        if " " in value:
            raise ValueError()
    except Exception:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid server URL: '{value}'. Must be a valid HTTP or HTTPS URL (e.g. http://192.168.1.100:8000)."
        )


def _validate_scan_subnets(value: str) -> None:
    """Reject subnet lists containing invalid CIDR entries."""
    import ipaddress
    invalid_subnets = []
    for sub in value.split(","):
        sub = sub.strip()
        if not sub:
            continue
        try:
            ipaddress.ip_network(sub, strict=False)
        except ValueError:
            invalid_subnets.append(sub)

    if invalid_subnets:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid subnets: {', '.join(invalid_subnets)}. Please use a format like 192.168.1.0/24."
        )


def _validate_offline_threshold(value: str) -> None:
    """Reject offline thresholds that are not whole numbers between 1 and 20."""
    if not value.strip().isdigit() or not 1 <= int(value.strip()) <= 20:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid offline threshold: '{value}'. Must be a whole number between 1 and 20."
        )


_VALIDATORS = {
    "server.url": _validate_server_url,
    "scan_subnets": _validate_scan_subnets,
    "scanner.offline_threshold": _validate_offline_threshold,
}


@router.post("", dependencies=[Depends(get_current_admin)])
async def update_settings(settings: SettingsUpdate, db: AsyncSession = Depends(get_db)):
    """Update or create system settings."""
    for key, value in settings.root.items():
        # Validate known keys before persisting
        validator = _VALIDATORS.get(key)
        if validator and value:
            validator(value)

        result = await db.execute(select(Setting).where(Setting.key == key))
        setting = result.scalar_one_or_none()
        
        if setting:
            setting.value = value
        else:
            db.add(Setting(key=key, value=value))
    
    await db.commit()
    
    # Apply log level if changed
    if "system.log_level" in settings.root:
        from app.services.log_streamer import apply_log_level
        apply_log_level(settings.root["system.log_level"])
        
    return {"status": "success"}


@router.post("/reset-db", status_code=200, dependencies=[Depends(get_current_admin)])
async def reset_database(db: AsyncSession = Depends(get_db)):
    """Wipe all devices, services, and reset setup status for a fresh start."""
    try:
        import asyncio
        from app.scanner.scheduler import scheduler
        
        # Stop scheduler BEFORE deletion to avoid StaleDataError
        logger.info("Stopping scanner scheduler before data wipe...")
        try:
            await asyncio.wait_for(scheduler.stop(), timeout=5.0)
        except Exception as se:
            logger.warning(f"Scheduler stop failed/timed out: {se}")

        from app.models.device import DeviceHistory, DiscoveredHost, Device, Service, DeviceGroup
        from app.models.agent import AgentToken, DeviceMetrics, AgentConfig
        from app.models.topology import TopologyLink, Rack
        
        # 2. Wipe tables (Nuclear Option: sync_wipe with PRAGMA foreign_keys=OFF)
        logger.info("Wiping database tables...")
        
        def sync_wipe(sync_conn):
            """Synchronous wipe executed on the raw connection to bypass FK constraints."""
            sync_conn.execute(text("PRAGMA foreign_keys=OFF"))
            
            # List of tables to clear in order (Leaf to Root)
            # Using raw table names to be independent of model mapping issues
            tables = [
                "topology_links", "device_metrics", "agent_tokens", "agent_configs",
                "device_history", "services", "devices", "racks", "discovered_hosts",
                "subnets", "app_settings"
            ]
            
            for table in tables:
                try:
                    sync_conn.execute(text(f"DELETE FROM {table}"))
                    logger.debug(f"Table {table} wiped.")
                except Exception as te:
                    # Ignore errors for tables that might not exist yet
                    logger.debug(f"Skipping table {table}: {te}")

            # Special resets (where we don't want to delete everything)
            sync_conn.execute(text("DELETE FROM device_groups WHERE is_default = 0"))
            sync_conn.execute(text("DELETE FROM app_settings WHERE key = 'setup.complete'"))
            
            sync_conn.execute(text("PRAGMA foreign_keys=ON"))

        # Run the sync wipe in the async context
        await db.run_sync(sync_wipe)
        await db.commit()
        logger.info("Database objects deleted and changes committed.")
        
        # 3. Restart scheduler
        try:
            await scheduler.start()
            logger.info("Scanner scheduler restarted after database reset.")
        except Exception as se:
            logger.error(f"Failed to restart scheduler: {se}")

        logger.warning("Database reset triggered: All devices and setup status cleared.")
        return {"status": "success", "message": "Database and setup status cleared successfully"}
    except Exception as e:
        await db.rollback()
        logger.error(f"Reset failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
