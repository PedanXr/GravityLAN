"""Shared synchronization logic for both Planner and Dashboard scans."""

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import delete, or_, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm.exc import StaleDataError

from app.database import async_session
from app.models.device import Device, DeviceHistory, DiscoveredHost
from app.scanner.vendor import get_vendor
from app.scanner.hostname import is_ip_like
from app.services.cache_service import discovery_cache, dashboard_cache, topology_cache

logger = logging.getLogger(__name__)

_INVALID_MACS = ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff")
_MULTICAST_MAC_PREFIXES = ("01:00:5e", "33:33")


def _mac_is_valid(mac: str | None) -> bool:
    return bool(
        mac and mac.strip()
        and mac.lower() not in _INVALID_MACS
        and not mac.lower().startswith(_MULTICAST_MAC_PREFIXES)
    )


def _should_apply_custom_name(disc, dev) -> bool:
    """True when a scan-provided custom name may overwrite the device display name."""
    if not disc:
        return False
    if not disc.custom_name:
        return False
    return not dev.display_name or dev.display_name == "Unknown"


async def sync_host_to_db(ip: str, mac: str | None, hostname: str | None = None, vendor: str | None = None, ports: list[int] | None = None, is_planner_scan: bool = True, should_invalidate_cache: bool = True):
    """
    Wrapper for sync_hosts_batch for single host updates.
    """
    host_data = {
        "ip": ip,
        "mac": mac,
        "hostname": hostname,
        "vendor": vendor,
        "ports": ports
    }
    return await sync_hosts_batch([host_data], is_planner_scan, should_invalidate_cache)


async def _commit_with_retry(db):
    """Commit with robust SQLite retry logic."""
    for attempt in range(5):
        outcome = await _commit_attempt(db, attempt)
        if outcome != "retry":
            return
        await asyncio.sleep((attempt + 1) * 0.2)


async def _commit_attempt(db, attempt):
    """Single commit attempt. Returns 'ok', 'stale' or 'retry'."""
    try:
        await db.commit()
        return "ok"
    except StaleDataError:
        await db.rollback()
        logger.debug("Sync: Stale data encountered during batch commit, rolling back.")
        return "stale"
    except OperationalError as e:
        await db.rollback()
        return _commit_error_outcome(e, attempt)


def _commit_error_outcome(e: OperationalError, attempt: int):
    """Classify a DB lock failure; raises when retries are exhausted."""
    error_msg = str(e).lower()
    if ("locked" in error_msg or "busy" in error_msg) and attempt < 4:
        return "retry"
    logger.error(f"Sync: Batch DB lock failure: {e}")
    raise


async def sync_hosts_batch(hosts: list[dict], is_planner_scan: bool = True, should_invalidate_cache: bool = True):
    """
    Synchronizes multiple hosts in a single database transaction.
    Significantly reduces I/O pressure and prevents 'Database is locked' errors.
    """
    if not hosts:
        return []

    results = []
    async with async_session() as db:
        for host in hosts:
            try:
                res = await _sync_host_internal(db, host)
                results.append(res)
            except Exception as e:
                logger.error(f"Sync: Failed to process host {host.get('ip')} ({host.get('mac')}): {e}")

        await _commit_with_retry(db)

    if should_invalidate_cache:
        discovery_cache.invalidate()
        # Only invalidate dashboard/topology if a device was actually updated/matched
        # For performance, we could be more selective, but this is safer for now.
        dashboard_cache.invalidate_all()
        topology_cache.invalidate()

    return results


async def _query_by_mac_and_ip(db, model, mac: str, ip: str):
    res = await db.execute(select(model).where(model.mac == mac, model.ip == ip))
    return res.scalar_one_or_none()


async def _query_by_ip(db, model, ip: str):
    res = await db.execute(select(model).where(model.ip == ip))
    return res.scalar_one_or_none()


async def _query_by_mac_all(db, model, mac: str):
    res = await db.execute(select(model).where(model.mac == mac))
    return res.scalars().all()


async def _query_by_mac_ordered(db, model, mac: str):
    res = await db.execute(
        select(model)
        .where(model.mac == mac)
        .order_by(model.is_monitored.desc(), model.custom_name.desc())
    )
    return res.scalars().all()


async def _query_by_name(db, model, name: str, name_columns):
    clauses = [col.ilike(name) for col in name_columns]
    res = await db.execute(select(model).where(or_(*clauses)))
    return res.scalars().all()


async def _match_ip_with_mac_conflict(db, model, mac: str, ip: str, is_valid_mac: bool, unraid_id_guard: bool = False):
    """
    IP-only match that prefers a candidate whose MAC conflicts with the scanned MAC
    only if the MAC owner is an Unraid host (otherwise the candidate is rejected).
    """
    cand = await _query_by_ip(db, model, ip)
    if not cand:
        return None

    if not (is_valid_mac and _mac_is_valid(cand.mac) and cand.mac.lower() != mac.lower()):
        return cand

    mac_owners = [owner for owner in await _query_by_mac_all(db, model, mac) if owner.id != cand.id]
    if not mac_owners:
        return cand
    if len(mac_owners) > 1:
        # Several records behind one MAC is the ipvlan pattern (containers share the
        # host's MAC): the MAC can't tell them apart, so the IP match stands. Asking for
        # a single owner here raised MultipleResultsFound and skipped the host every scan.
        return cand

    mac_owner = mac_owners[0]

    owner_name = (
        getattr(mac_owner, "display_name", None)
        or getattr(mac_owner, "custom_name", None)
        or getattr(mac_owner, "hostname", None)
        or ""
    ).lower()
    if "unraid" in owner_name or (unraid_id_guard and mac_owner.id == 29):
        return cand
    return None


async def _match_by_name(db, model, name: str | None, name_columns):
    if not name or is_ip_like(name):
        return None
    candidates = await _query_by_name(db, model, name, name_columns)
    if not candidates:
        return None
    placeholder = next((c for c in candidates if getattr(c, "ip_placeholder", False)), None)
    return placeholder or candidates[0]


async def _match_dashboard_device(db, ip: str, mac: str | None, hostname: str | None, is_valid_mac: bool):
    """Match a monitored Device. Returns (device, match_type) or (None, None)."""
    if is_valid_mac and ip:
        dev = await _query_by_mac_and_ip(db, Device, mac, ip)
        if dev:
            return dev, "exact"

    if ip:
        cand = await _match_ip_with_mac_conflict(db, Device, mac, ip, is_valid_mac, unraid_id_guard=True)
        if cand:
            return cand, "ip"

    cand = await _match_dashboard_by_mac(db, mac, ip, is_valid_mac)
    if cand:
        return cand, "mac"

    cand = await _match_by_name(db, Device, hostname, (Device.hostname, Device.display_name))
    if cand:
        return cand, "hostname"

    return None, None


async def _match_dashboard_by_mac(db, mac: str, ip: str, is_valid_mac: bool):
    """MAC-only fallback for monitored Devices; guards against Unraid IP hijacking."""
    if not is_valid_mac:
        return None
    matches = await _query_by_mac_all(db, Device, mac)
    if len(matches) == 1:
        cand = matches[0]
        cand_name = (cand.display_name or cand.hostname or "").lower()
        if cand.ip != ip and ("unraid" in cand_name or cand.id == 29):
            logger.debug(f"Sync: Skipping MAC match for host {cand.display_name} ({cand.ip}) on new IP {ip} to prevent host IP hijacking.")
            return None
        return cand
    if len(matches) > 1:
        logger.debug(f"Sync: Multiple devices found for MAC {mac} (ipvlan). Skipping MAC-only fallback matching.")
    return None


async def _match_discovered_host(db, ip: str, mac: str | None, hostname: str | None, is_valid_mac: bool):
    """Match a DiscoveredHost record. Returns the record or None."""
    if is_valid_mac and ip:
        disc = await _query_by_mac_and_ip(db, DiscoveredHost, mac, ip)
        if disc:
            return disc

    if ip:
        disc = await _match_ip_with_mac_conflict(db, DiscoveredHost, mac, ip, is_valid_mac)
        if disc:
            return disc

    disc = await _match_discovered_by_mac(db, mac, is_valid_mac)
    if disc:
        return disc

    return await _match_by_name(db, DiscoveredHost, hostname, (DiscoveredHost.hostname, DiscoveredHost.custom_name))


async def _match_discovered_by_mac(db, mac: str, is_valid_mac: bool):
    """MAC-only fallback for DiscoveredHost records."""
    if not is_valid_mac:
        return None
    matches = await _query_by_mac_ordered(db, DiscoveredHost, mac)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        logger.debug(f"Sync: Multiple DiscoveredHost records found for MAC {mac} (ipvlan). Skipping MAC-only matching.")
    return None


async def _upsert_discovered_host(db, disc, dev, ip: str, mac: str | None, hostname: str | None, vendor: str | None, ports: list[int] | None, is_valid_mac: bool):
    """Update an existing DiscoveredHost or create a new one. Does NOT commit."""
    if disc:
        return await _update_existing_discovered_host(db, disc, dev, ip, mac, hostname, vendor, ports, is_valid_mac)

    inherited_name = dev.display_name if (dev and dev.ip == ip) else None

    disc = DiscoveredHost(
        ip=ip, mac=mac, hostname=hostname,
        custom_name=inherited_name,
        vendor=vendor or (get_vendor(mac) if mac else None),
        is_online=True,
        is_monitored=dev is not None,
        last_seen=datetime.now(timezone.utc),
        first_seen=datetime.now(timezone.utc),
        ports=json.dumps(ports) if ports else None
    )
    db.add(disc)
    return disc


async def _update_existing_discovered_host(db, disc, dev, ip: str, mac: str | None, hostname: str | None, vendor: str | None, ports: list[int] | None, is_valid_mac: bool):
    """Apply scan results to an existing DiscoveredHost. Does NOT commit."""
    if disc.ip != ip:
        await db.execute(delete(DiscoveredHost).where(DiscoveredHost.ip == ip).where(DiscoveredHost.id != disc.id))
        disc.ip = ip
        if hasattr(disc, "ip_changed_at"):
            disc.ip_changed_at = datetime.now(timezone.utc)

    disc.is_online = True
    disc.last_seen = datetime.now(timezone.utc)
    if getattr(disc, "ip_placeholder", False):
        disc.ip_placeholder = False
    if hostname:
        disc.hostname = hostname

    if is_valid_mac and not _mac_is_valid(disc.mac):
        disc.mac = mac

    if vendor:
        disc.vendor = vendor
    if ports:
        disc.ports = json.dumps(ports)

    if not disc.custom_name and dev and dev.ip == ip:
        disc.custom_name = dev.display_name

    disc.is_monitored = dev is not None
    return disc


def _is_reusable_old_ip(old_ip: str | None) -> bool:
    if not old_ip:
        return False
    if old_ip.startswith("offline-"):
        return False
    return is_ip_like(old_ip)


async def _find_safe_placeholder_ip(db, conflict_dev):
    old_ip = getattr(conflict_dev, "old_ip", None)
    if _is_reusable_old_ip(old_ip):
        res_taken = await db.execute(select(Device).where(Device.ip == old_ip).where(Device.id != conflict_dev.id))
        if not res_taken.scalar_one_or_none():
            return old_ip

    counter = 0
    while True:
        candidate = f"0.0.0.{counter}"
        res_taken = await db.execute(select(Device).where(Device.ip == candidate).where(Device.id != conflict_dev.id))
        if not res_taken.scalar_one_or_none():
            return candidate
        counter += 1


async def _resolve_ip_conflict(db, ip: str, dev):
    """Move any other device holding `ip` to a safe placeholder IP. Does NOT commit."""
    res_conflict = await db.execute(select(Device).where(Device.ip == ip).where(Device.id != dev.id))
    conflict_dev = res_conflict.scalar_one_or_none()
    if not conflict_dev:
        return

    conflict_dev.is_online = False
    conflict_dev.ip_placeholder = True
    safe_ip = await _find_safe_placeholder_ip(db, conflict_dev)
    conflict_dev.ip = safe_ip
    await db.flush()
    logger.warning(f"Sync: Resolved IP conflict. Moved conflicting device {conflict_dev.id} to placeholder IP {conflict_dev.ip}")


async def _update_dashboard_device(db, dev, disc, ip: str, mac: str | None, is_valid_mac: bool, dev_match_type: str | None):
    """Apply cross-sync updates to a monitored Device. Does NOT commit."""
    if not dev:
        return

    dev.is_online = True
    dev.missed_scans = 0
    dev.last_seen = datetime.now(timezone.utc)
    if getattr(dev, "ip_placeholder", False):
        dev.ip_placeholder = False

    if is_valid_mac and not _mac_is_valid(dev.mac):
        dev.mac = mac

    if _should_apply_custom_name(disc, dev):
        dev.display_name = disc.custom_name

    if dev.ip == ip:
        return

    same_mac = bool(mac and dev.mac and dev.mac.lower() == mac.lower())
    is_verified_change = bool(is_valid_mac and same_mac and dev_match_type in ("exact", "mac"))

    # To prevent UNIQUE constraint error on devices.ip:
    # check if another device already has the new IP.
    await _resolve_ip_conflict(db, ip, dev)

    dev.old_ip = dev.ip
    dev.ip = ip
    dev.ip_changed_at = datetime.now(timezone.utc)

    # ONLY emit DeviceHistory event if IP change is VERIFIED
    if is_verified_change:
        db.add(DeviceHistory(
            device_id=dev.id,
            status="info",
            message=f"IP changed from {dev.old_ip} to {ip}"
        ))
    else:
        logger.info(f"Sync: Updated IP of device {dev.id} to {ip} without DeviceHistory notification (unverified match).")


async def _sync_host_internal(db, host: dict):
    """
    Internal logic for syncing a single host. Does NOT commit.
    """
    ip = host.get("ip")
    mac = host.get("mac")
    hostname = host.get("hostname")
    vendor = host.get("vendor")
    ports = host.get("ports")

    is_valid_mac = _mac_is_valid(mac)

    # 1. Dashboard Check (Is this host already monitored?)
    dev, dev_match_type = await _match_dashboard_device(db, ip, mac, hostname, is_valid_mac)

    # 2. Discovery Table Deduplication & Search
    disc = await _match_discovered_host(db, ip, mac, hostname, is_valid_mac)

    # 3. Apply Updates to DiscoveredHost
    disc = await _upsert_discovered_host(db, disc, dev, ip, mac, hostname, vendor, ports, is_valid_mac)

    # 4. Cross-Sync to Dashboard
    await _update_dashboard_device(db, dev, disc, ip, mac, is_valid_mac, dev_match_type)

    return disc


def _fuzzy_match(n1: str | None, n2: str | None) -> bool:
    if not n1 or not n2:
        return False
    s1 = n1.lower().replace("-", "").replace("_", "").replace(" ", "")
    s2 = n2.lower().replace("-", "").replace("_", "").replace(" ", "")
    return s1 in s2 or s2 in s1


async def _match_disc_for_container(db, ip: str, container_name: str | None):
    disc = await _query_by_ip(db, DiscoveredHost, ip)
    if disc or not container_name:
        return disc
    cand_discs = await _query_by_name(db, DiscoveredHost, container_name, (DiscoveredHost.custom_name, DiscoveredHost.hostname))
    if not cand_discs:
        return None
    placeholder = next((c for c in cand_discs if getattr(c, "ip_placeholder", False)), None)
    return placeholder or cand_discs[0]


async def _match_dev_for_container(db, ip: str, container_name: str | None):
    dev = await _query_by_ip(db, Device, ip)
    if dev or not container_name:
        return dev

    res_all_devs = await db.execute(select(Device))
    all_devices = res_all_devs.scalars().all()

    cand_devs = [
        d for d in all_devices
        if _fuzzy_match(container_name, d.display_name) or _fuzzy_match(container_name, d.hostname)
    ]
    if not cand_devs:
        return None
    placeholder = next((d for d in cand_devs if getattr(d, "ip_placeholder", False)), None)
    return placeholder or cand_devs[0]


async def _relocate_conflicting_device(db, ip: str, used_ips: set[str]):
    """Move any other device holding `ip` to a free placeholder IP. Does NOT commit."""
    conflict_dev = await _query_by_ip(db, Device, ip)
    if not conflict_dev:
        return

    conflict_dev.is_online = False
    conflict_dev.ip_placeholder = True
    counter = 0
    while True:
        cand_ip = f"0.0.0.{counter}"
        if cand_ip not in used_ips:
            conflict_dev.ip = cand_ip
            used_ips.add(cand_ip)
            break
        counter += 1
    await db.flush()


async def _sync_container_ip(db, ip: str, container_name: str | None, used_ips: set[str]):
    """Sync one container IP against DiscoveredHost and Device tables."""
    # 1. Update discovered hosts
    disc = await _match_disc_for_container(db, ip, container_name)

    if disc:
        if disc.ip != ip:
            await db.execute(delete(DiscoveredHost).where(DiscoveredHost.ip == ip).where(DiscoveredHost.id != disc.id))
            disc.ip = ip
        disc.is_online = True
        disc.last_seen = datetime.now(timezone.utc)
        if getattr(disc, "ip_placeholder", False):
            disc.ip_placeholder = False
        if not disc.custom_name or disc.custom_name == "Unknown":
            disc.custom_name = container_name

    # 2. Update dashboard devices
    dev = await _match_dev_for_container(db, ip, container_name)
    if not dev:
        return

    if dev.ip != ip:
        # Clear conflict on target IP if held by another device
        await _relocate_conflicting_device(db, ip, used_ips)

        if dev.ip in used_ips:
            used_ips.remove(dev.ip)
        dev.old_ip = dev.ip
        dev.ip = ip
        used_ips.add(ip)
        dev.ip_changed_at = datetime.now(timezone.utc)

    dev.is_online = True
    dev.missed_scans = 0
    dev.last_seen = datetime.now(timezone.utc)
    if getattr(dev, "ip_placeholder", False):
        dev.ip_placeholder = False
    logger.info(f"Docker Sync: Marked container {container_name} ({ip}) as ONLINE")


async def sync_docker_containers(containers: list[dict]):
    """
    Syncs local Docker container statuses to the database.
    If a container is 'running', it overrides the offline status in the DB
    and updates device IP by matching either by IP or by container name.
    """
    if not containers:
        return

    async with async_session() as db:
        res_all_ips = await db.execute(select(Device.ip))
        used_ips = set(res_all_ips.scalars().all())

        for container in containers:
            ips = container.get("ips", [])
            is_running = container.get("status") == "running"
            container_name = container.get("name")

            if not ips or not is_running:
                continue

            for ip in ips:
                await _sync_container_ip(db, ip, container_name, used_ips)

        await db.commit()
        discovery_cache.invalidate()
        dashboard_cache.invalidate_all()
        topology_cache.invalidate()
