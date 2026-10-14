import hmac
import re
from urllib.parse import urlparse
from pydantic import RootModel
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import delete, select, text
from app.database import get_db
from app.models.device import Device, Service, DeviceGroup
from app.models.setting import Setting
from app.schemas.network import normalize_dns_server
import logging

logger = logging.getLogger(__name__)
from app.api.auth import get_current_admin

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Credentials: never returned by GET, never written through the generic POST
# (the password has its own endpoint, POST /api/auth/password, which checks the old one)
SENSITIVE_KEYS = {"api.master_token", "api.admin_password"}


@router.get("", dependencies=[Depends(get_current_admin)])
async def get_all_settings(db: AsyncSession = Depends(get_db)):
    """Fetch all system settings as a key-value dictionary, excluding secrets."""
    result = await db.execute(select(Setting))
    settings = result.scalars().all()
    # Filter out sensitive keys to prevent credentials leakage (P0 security fix)
    return {s.key: s.value for s in settings if s.key not in SENSITIVE_KEYS}

SettingsUpdate = RootModel[dict[str, str]]


# server.url is embedded into the generated agent install script (run as root via
# `curl | sudo bash`), so beyond being a URL it must not carry anything a shell
# could interpret. Host part: letters, digits, dots, hyphens and the port colon only.
_SERVER_URL_NETLOC_RE = re.compile(r"^[a-zA-Z0-9.\-:]+$")
_SERVER_URL_PATH_RE = re.compile(r"^[a-zA-Z0-9._~/\-]*$")
_SHELL_SPECIAL_CHARS = frozenset("\"'`$;&|\n\r\t \\<>(){}*?!#")


def check_server_url(value: str) -> None:
    """Raise ValueError unless value is a plain http(s)://host[:port][/path] URL."""
    if any(ch in _SHELL_SPECIAL_CHARS for ch in value):
        raise ValueError("contains whitespace or shell special characters")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("scheme must be http or https")
    if not parsed.netloc or not _SERVER_URL_NETLOC_RE.match(parsed.netloc) or not parsed.hostname:
        raise ValueError("host may only contain letters, digits, dots, hyphens and a port")
    _ = parsed.port  # raises ValueError for a non-numeric or out-of-range port
    if parsed.query or parsed.fragment or parsed.params:
        raise ValueError("query strings and fragments are not allowed")
    if not _SERVER_URL_PATH_RE.match(parsed.path):
        raise ValueError("path contains unsupported characters")


def _validate_server_url(value: str) -> None:
    """Reject server URLs that are not plain HTTP(S) URLs safe to embed in the install script."""
    try:
        check_server_url(value)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid server URL: '{value}'. Must be a plain HTTP or HTTPS URL without query or special characters (e.g. http://192.168.1.100:8000)."
        )


def _validate_dns_server(value: str) -> None:
    """Reject DNS servers that are not a single IP address (the value is passed to nmap)."""
    try:
        normalize_dns_server(value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
    "dns.server": _validate_dns_server,
    "scan_subnets": _validate_scan_subnets,
    "scanner.offline_threshold": _validate_offline_threshold,
}


@router.post("", dependencies=[Depends(get_current_admin)])
async def update_settings(settings: SettingsUpdate, db: AsyncSession = Depends(get_db)):
    """Update or create system settings."""
    protected = SENSITIVE_KEYS.intersection(settings.root)
    if protected:
        raise HTTPException(
            status_code=400,
            detail=f"{', '.join(sorted(protected))} cannot be changed here. Change the password under Settings > Access.",
        )
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
