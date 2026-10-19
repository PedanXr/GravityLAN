import logging
from collections import defaultdict
from sqlalchemy import inspect, select, or_
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# Define missing columns as (table, column, type) on module level for testability and maintainability
MIGRATIONS = [
    ("devices", "topology_x", "INTEGER"),
    ("devices", "topology_y", "INTEGER"),
    ("devices", "max_ports",  "INTEGER DEFAULT 24"),
    ("devices", "topology_config", "TEXT"),
    ("devices", "parent_id",  "INTEGER"),
    ("devices", "rack_id",    "INTEGER"),
    ("devices", "rack_unit",  "INTEGER"),
    ("devices", "rack_height","INTEGER DEFAULT 1"),
    ("devices", "is_wlan",    "BOOLEAN DEFAULT FALSE"),
    ("devices", "is_ap",      "BOOLEAN DEFAULT FALSE"),
    ("devices", "is_host",    "BOOLEAN DEFAULT FALSE"),
    ("devices", "ip_placeholder", "BOOLEAN DEFAULT FALSE"),
    ("devices", "missed_scans", "INTEGER DEFAULT 0"),
    ("topology_links", "source_handle", "TEXT"),
    ("topology_links", "target_handle", "TEXT"),
    ("discovered_hosts", "is_reserved", "BOOLEAN DEFAULT FALSE"),
    ("discovered_hosts", "ip_placeholder", "BOOLEAN DEFAULT FALSE"),
    ("discovered_hosts", "old_ip", "VARCHAR(45)"),
    ("discovered_hosts", "ip_changed_at", "DATETIME"),
    ("discovered_hosts", "ports", "TEXT"),
    ("agent_tokens", "pending_token", "VARCHAR(64)"),
    ("agent_tokens", "pending_at", "DATETIME"),
    ("agent_tokens", "os_pretty", "VARCHAR(255)"),
    ("agent_tokens", "os_name", "VARCHAR(100)"),
    ("agent_tokens", "os_version", "VARCHAR(100)"),
    ("agent_tokens", "os_codename", "VARCHAR(100)"),
    ("agent_tokens", "os_arch", "VARCHAR(50)"),
    ("agent_tokens", "os_kernel", "VARCHAR(100)"),
    ("api_tokens", "scopes", "TEXT"),
    ("device_metrics", "patch_available", "INTEGER DEFAULT 0"),
    ("device_metrics", "patch_security", "INTEGER DEFAULT 0"),
    ("device_metrics", "patch_manager", "VARCHAR(20)"),
    ("device_metrics", "reboot_required", "BOOLEAN DEFAULT FALSE"),
    ("device_metrics", "major_upgrade_available", "VARCHAR(100)"),
    ("agent_configs", "enable_patch_check", "BOOLEAN DEFAULT TRUE"),
    ("agent_configs", "enable_scanner_relay", "BOOLEAN DEFAULT FALSE"),
    # Multi-VLAN gateways; the device_interfaces table itself comes from init_db's create_all
    ("subnets", "gateway_ip", "VARCHAR(45)"),
    ("subnets", "vlan_id", "INTEGER"),
    # Service health telemetry columns
    ("services", "latency_ms", "FLOAT"),
    ("services", "ssl_expiry_days", "INTEGER"),
    ("services", "ssl_checked_at", "DATETIME"),
    ("services", "ignore_ssl", "BOOLEAN DEFAULT FALSE"),
    ("devices", "alert_offline", "BOOLEAN DEFAULT TRUE"),
]


def _fuzzy_match(n1: str, n2: str) -> bool:
    if not n1 or not n2: return False
    s1 = n1.lower().replace("-", "").replace("_", "").replace(" ", "")
    s2 = n2.lower().replace("-", "").replace("_", "").replace(" ", "")
    return s1 in s2 or s2 in s1


def _build_docker_container_map() -> dict:
    """Map running local Docker container names (lowercase) to their first IP."""
    from app.services.docker_service import docker_service

    docker_container_map = {}
    if not docker_service.is_available():
        return docker_container_map
    try:
        for c in docker_service.get_local_containers():
            c_name = c.get("name")
            c_ips = c.get("ips", [])
            if c_name and c_ips and c.get("status") == "running":
                docker_container_map[c_name.lower()] = c_ips[0]
        if docker_container_map:
            logger.info(f"Migration: Docker socket active. Found {len(docker_container_map)} running containers: {list(docker_container_map.keys())}")
    except Exception as e:
        logger.warning(f"Migration: Could not fetch local docker containers: {e}")
    return docker_container_map


def _is_free(candidate: str, used_ips: set, old_corrupted_ip: str) -> bool:
    """A candidate IP is usable if unused or if it is the record's own current IP."""
    return candidate not in used_ips or candidate == old_corrupted_ip


def _next_free_placeholder_ip(used_ips: set) -> str:
    counter = 0
    while True:
        candidate = f"0.0.0.{counter}"
        if candidate not in used_ips:
            return candidate
        counter += 1


def _ip_from_docker_fuzzy(dev_name: str, docker_map: dict, used_ips: set, old_corrupted_ip: str):
    """1a. Fuzzy match against running Docker container names."""
    for c_name, c_ip in docker_map.items():
        if _fuzzy_match(dev_name, c_name) and _is_free(c_ip, used_ips, old_corrupted_ip):
            return c_ip
    return None


def _restorable_old_ip(dev, used_ips: set):
    """1b. Restore old_ip if it is a valid, free IP."""
    from app.scanner.hostname import is_ip_like

    old_ip = dev.old_ip
    if not old_ip or old_ip.startswith("offline-") or not is_ip_like(old_ip):
        return None
    if old_ip in used_ips:
        return None
    return old_ip


def _resolve_device_repair(dev, used_ips: set, docker_map: dict):
    """Find a safe replacement for a corrupted Device.

    Returns (safe_ip, is_online, ip_placeholder) or None when only the
    unique-placeholder fallback applies. Only installation-independent sources
    are used (live Docker containers, the device's own old_ip): no hardcoded
    IPs or names, which would overwrite data on other people's networks.
    """
    dev_name = (dev.display_name or dev.hostname or "").lower()

    docker_ip = _ip_from_docker_fuzzy(dev_name, docker_map, used_ips, dev.ip)
    if docker_ip:
        return docker_ip, True, False

    old_ip = _restorable_old_ip(dev, used_ips)
    if old_ip:
        return old_ip, False, True
    return None


def _apply_repair(record, safe_ip: str, used_ips: set, old_corrupted_ip: str):
    """Swap the corrupted IP for the safe one and keep the used-set consistent."""
    used_ips.discard(old_corrupted_ip)
    used_ips.add(safe_ip)
    record.ip = safe_ip


async def _repair_corrupted_devices(db: AsyncSession, docker_map: dict):
    from app.models.device import Device

    res_devs = await db.execute(select(Device).where(or_(Device.ip.like("offline-%"), Device.ip_placeholder == True)))
    corrupted_devs = res_devs.scalars().all()
    if not corrupted_devs:
        return

    logger.info(f"Migration: Cleaning {len(corrupted_devs)} corrupted/placeholder Device records...")
    res_all_ips = await db.execute(select(Device.ip))
    used_ips = set(res_all_ips.scalars().all())

    for dev in corrupted_devs:
        old_corrupted_ip = dev.ip
        repair = _resolve_device_repair(dev, used_ips, docker_map)
        if repair:
            safe_ip, dev.is_online, dev.ip_placeholder = repair
        else:
            safe_ip = _next_free_placeholder_ip(used_ips)
            dev.is_online = False
            dev.ip_placeholder = True

        _apply_repair(dev, safe_ip, used_ips, old_corrupted_ip)
        logger.info(f"Migration: Repaired Device id={dev.id} ({dev.display_name}) IP to {dev.ip} (online={dev.is_online})")


async def _repair_corrupted_discovered_hosts(db: AsyncSession, docker_map: dict):
    from app.models.device import DiscoveredHost

    res_disc = await db.execute(select(DiscoveredHost).where(or_(DiscoveredHost.ip.like("offline-%"), DiscoveredHost.ip_placeholder == True)))
    corrupted_disc = res_disc.scalars().all()
    if not corrupted_disc:
        return

    logger.info(f"Migration: Cleaning {len(corrupted_disc)} corrupted/placeholder DiscoveredHost records...")
    res_all_disc_ips = await db.execute(select(DiscoveredHost.ip))
    used_disc_ips = set(res_all_disc_ips.scalars().all())

    for disc in corrupted_disc:
        old_corrupted_ip = disc.ip
        disc_name = (disc.custom_name or disc.hostname or "").lower()

        docker_ip = docker_map.get(disc_name) if disc_name else None
        if docker_ip and _is_free(docker_ip, used_disc_ips, old_corrupted_ip):
            safe_ip = docker_ip
            disc.is_online = True
            disc.ip_placeholder = False
        else:
            safe_ip = _next_free_placeholder_ip(used_disc_ips)
            disc.is_online = False
            disc.ip_placeholder = True

        _apply_repair(disc, safe_ip, used_disc_ips, old_corrupted_ip)
        logger.info(f"Migration: Repaired DiscoveredHost id={disc.id} IP to {disc.ip}")


async def _clean_corrupted_ip_placeholders(db: AsyncSession):
    """Repair existing production database records corrupted with 'offline-<MAC>' or placeholder IPs."""
    docker_map = _build_docker_container_map()
    await _repair_corrupted_devices(db, docker_map)
    await _repair_corrupted_discovered_hosts(db, docker_map)


def _migrations_by_table() -> dict:
    migrations_by_table = defaultdict(list)
    for table, column, col_type in MIGRATIONS:
        migrations_by_table[table].append((column, col_type))
    return migrations_by_table


async def _get_existing_columns(raw_conn, table: str):
    """Column names of a table, or None if the table does not exist yet."""
    def check_table_and_columns(sync_conn):
        inspector = inspect(sync_conn)
        if not inspector.has_table(table):
            return None
        return {col["name"] for col in inspector.get_columns(table)}

    return await raw_conn.run_sync(check_table_and_columns)


async def _apply_table_migrations(raw_conn, table: str, cols: list):
    existing_columns = await _get_existing_columns(raw_conn, table)
    if existing_columns is None:
        logger.info(f"Migration: Table '{table}' does not exist yet. It will be created by init_db. Skipping migrations for it.")
        return

    for column, col_type in cols:
        if column not in existing_columns:
            logger.info(f"Migration: Adding column '{column}' to '{table}'...")
            await raw_conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
            logger.info(f"Migration: Column '{column}' added successfully to '{table}'.")


async def run_migrations(db: AsyncSession):
    """Run schema migrations for SQLite or any alternative database.

    This handles adding missing columns to existing tables without breaking
    compatibility for users with older database versions. Uses a dialect-agnostic
    SQLAlchemy Inspector approach.
    """
    raw_conn = await db.connection()

    for table, cols in _migrations_by_table().items():
        try:
            await _apply_table_migrations(raw_conn, table, cols)
        except Exception as e:
            logger.error(f"Migration error on table '{table}': {e}")

    await _clean_corrupted_ip_placeholders(db)
    await db.commit()

    # Tag stored agent token hashes (sha256:) and hash leftover plaintext tokens
    from app.services.agent_tokens import normalize_agent_tokens
    try:
        await normalize_agent_tokens(db)
    except Exception as e:
        await db.rollback()
        logger.error(f"Migration error while upgrading agent tokens: {e}")
    logger.info("Schema migration complete.")
