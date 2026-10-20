"""Network Planner Scan logic — Fast discovery via ARP/Ping/DNS."""

import logging
import ipaddress
from datetime import datetime, timezone
from sqlalchemy import select
from app.database import async_session
from app.models.device import DiscoveredHost, Device
from app.models.network import Subnet
from app.scanner.discovery import discover_hosts_simple
from app.scanner.arp import resolve_mac_addresses, get_local_arp_table
from app.scanner.presence import (
    DEFAULT_OFFLINE_THRESHOLD,
    get_offline_threshold,
    register_miss,
    register_seen,
    tcp_fallback_alive,
    update_interface_presence,
)
from app.services.cache_service import discovery_cache, dashboard_cache, topology_cache

logger = logging.getLogger(__name__)


def _normalize_subnets(subnets: list[str]) -> list[str]:
    """Ensure unique, sorted, and normalized subnet strings."""
    normalized = []
    for s in set(subnets):
        if not s:
            continue
        if "/" not in s:
            if s.count(".") == 2:
                s = f"{s}.0/24"
            elif s.count(".") == 3:
                s = f"{s}/32"
            else:
                s = f"{s}/24"
        normalized.append(s)
    return sorted(normalized)


def _parse_subnet_list(values) -> list:
    """Parse an iterable of subnet strings, skipping invalid entries."""
    nets = []
    for s in values:
        try:
            nets.append(ipaddress.ip_network(s.strip(), strict=False))
        except ValueError:
            logger.debug(f"Planner: Skipping invalid subnet '{s}'")
    return nets


async def _load_allowed_networks(db):
    """Load the enabled subnets of the Subnet table, falling back to auto-detected local subnets."""
    from app.scanner.subnets import get_scan_subnets
    return _parse_subnet_list(await get_scan_subnets(db))


def _ip_in_any_subnet(ip: str, subnets: list[str]) -> bool:
    """Return True when the IP belongs to any of the given subnets."""
    for s in subnets:
        try:
            if ipaddress.IPv4Address(ip) in ipaddress.IPv4Network(s, strict=False):
                return True
        except (ValueError, OSError):
            continue
    return False


async def _sync_local_docker_containers():
    """Best-effort sync of local Docker containers; failures must not abort the scan."""
    from app.services.docker_service import docker_service
    from app.scanner.sync import sync_docker_containers

    if not docker_service.is_available():
        return
    try:
        local_c = docker_service.get_local_containers()
        if local_c:
            logger.info(f"Planner: Syncing {len(local_c)} local Docker containers...")
            await sync_docker_containers(local_c)
    except Exception as e:
        logger.warning(f"Planner: Docker container sync failed: {e}")


async def _get_subnet_dns_server(subnet: str):
    """Return the configured DNS server for a subnet, if any."""
    dns_server = None
    async with async_session() as db:
        res_sub = await db.execute(select(Subnet).where(Subnet.cidr == subnet))
        sub_obj = res_sub.scalar_one_or_none()
        if sub_obj and sub_obj.dns_server:
            dns_server = sub_obj.dns_server
            logger.info(f"Planner: Using custom DNS {dns_server} for subnet {subnet}")
    return dns_server


async def _scan_subnet_alive_hosts(subnet: str, dns_server):
    """Fast ARP + Ping discovery over one subnet."""
    try:
        net = ipaddress.ip_network(subnet, strict=False)
        target_ips = [str(ip) for ip in net.hosts()]
    except ValueError as e:
        logger.error(f"Planner: Skipping invalid subnet '{subnet}': {e}")
        return []

    # No more immediate per-host callback to DB to prevent locks
    return await discover_hosts_simple(target_ips, dns_server=dns_server)


async def _cleanup_discovered_hosts(db, subnets: list[str], all_alive_ips: set):
    """Delete unmonitored discovered hosts absent from the scan; mark monitored ones offline."""
    from app.services.proxmox import imported_addresses
    proxmox_ips = await imported_addresses(db)
    res_disc = await db.execute(select(DiscoveredHost).where(DiscoveredHost.is_online == True))
    for host in res_disc.scalars().all():
        if not _ip_in_any_subnet(host.ip, subnets) or host.ip in all_alive_ips:
            continue

        # IMPORTANT: Only delete if NOT monitored.
        # Dashboard devices are handled by dashboard scanner.
        if not host.is_monitored and host.ip not in proxmox_ips:
            logger.info(f"Planner: Host {host.ip} GONE, deleting.")
            await db.delete(host)
        else:
            # Just mark as offline for UI consistency until Dashboard scan confirms
            host.is_online = False


async def _cleanup_devices(
    db, subnets: list[str], all_alive_ips: set, offline_threshold: int = DEFAULT_OFFLINE_THRESHOLD
):
    """Count a miss for devices absent from the scan; they go offline only at the threshold."""
    res_dev = await db.execute(select(Device).where(Device.is_online == True))
    missing = []
    for dev in res_dev.scalars().all():
        if not _ip_in_any_subnet(dev.ip, subnets):
            continue
        if dev.ip in all_alive_ips:
            register_seen(dev)
            continue

        # Skipping: Devices with configured services are handled by the
        # Dashboard scanner (TCP port + ICMP hybrid check). Marking them
        # offline here based on a single missed ping causes false positives
        # on devices with a busy management CPU (e.g. UniFi switches).
        if dev.services:
            continue
        missing.append(dev)

    # ICMP/ARP silence alone is no proof of absence (e.g. ipvlan containers
    # on Unraid), so try a TCP handshake before counting the miss.
    tcp_alive = await tcp_fallback_alive([dev.ip for dev in missing])
    for dev in missing:
        if dev.ip in tcp_alive:
            register_seen(dev)
        else:
            await register_miss(dev, db, offline_threshold)


async def _cleanup_planner_offline(
    db, subnets: list[str], all_alive_ips: set, offline_threshold: int = DEFAULT_OFFLINE_THRESHOLD
):
    """
    Delete unmonitored discovered hosts and count misses for devices that
    were absent from the planner scan (exclusive to the planner scanner).
    """
    await _cleanup_discovered_hosts(db, subnets, all_alive_ips)
    await _cleanup_devices(db, subnets, all_alive_ips, offline_threshold)
    await update_interface_presence(db, subnets, all_alive_ips, offline_threshold)


async def run_arp_only_scan():
    """
    Extremely fast scan that only looks at the local ARP table.
    Used for the Turbo mode. Filters results by the enabled scan subnets.
    """
    async with async_session() as db:
        allowed_nets = await _load_allowed_networks(db)

    arp_hosts = get_local_arp_table()
    hosts_to_sync = []

    for ip, mac in arp_hosts.items():
        if not mac or mac == "00:00:00:00:00:00":
            continue

        try:
            ip_obj = ipaddress.IPv4Address(ip)
            if any(ip_obj in net for net in allowed_nets):
                hosts_to_sync.append({"ip": ip, "mac": mac})
        except (ValueError, OSError):
            logger.debug(f"Planner: Skipping invalid ARP entry {ip}")

    if hosts_to_sync:
        from app.scanner.sync import sync_hosts_batch
        await sync_hosts_batch(hosts_to_sync, is_planner_scan=True)

    return len(hosts_to_sync)


async def run_planner_scan(subnets: list[str], progress_callback=None):
    """
    Executes a lightweight discovery scan for the Network Planner.
    Uses ARP + Ping + DNS.
    """
    subnets = _normalize_subnets(subnets)
    logger.info(f"Planner: Starting discovery on {subnets}")

    # Sync local Docker containers first
    await _sync_local_docker_containers()

    total_found = 0
    all_alive_ips = set()
    from app.scanner.sync import sync_hosts_batch

    for subnet in subnets:
        if subnet.startswith("169.254."):
            continue

        dns_server = await _get_subnet_dns_server(subnet)

        if progress_callback:
            await progress_callback(f"Scanner: Scanning {subnet} (ARP + Ping)...")

        # 1. Fast Discovery (Nmap -sn -PR -PE)
        alive_hosts = await _scan_subnet_alive_hosts(subnet, dns_server)

        if progress_callback:
            await progress_callback(f"Scanner: Found {len(alive_hosts)} active hosts. Resolving MACs...")

        # 2. MAC Resolution & Batch Sync
        resolved_hosts = await resolve_mac_addresses(alive_hosts)

        if resolved_hosts:
            await sync_hosts_batch(resolved_hosts, is_planner_scan=True)
            for h in resolved_hosts:
                all_alive_ips.add(h["ip"])
                total_found += 1

            if progress_callback:
                await progress_callback("EVENT:RELOAD_DEVICES")

    # 4. Offline Cleanup (Exclusive to Planner)
    # Delete hosts in scanned subnets that were not found
    async with async_session() as db:
        offline_threshold = await get_offline_threshold(db)
        await _cleanup_planner_offline(db, subnets, all_alive_ips, offline_threshold)
        await db.commit()
        # Consolidated cache invalidation
        discovery_cache.invalidate()
        dashboard_cache.invalidate_all()
        topology_cache.invalidate()

    logger.info(f"Planner: Scan complete. Found {total_found} hosts.")

    # Trigger scan.complete webhook
    from app.services.webhook_service import trigger_webhooks
    await trigger_webhooks(
        event_type="scan.complete",
        data={
            "scan_type": "planner",
            "hosts_found": total_found,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    )

    return total_found
