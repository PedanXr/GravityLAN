"""Dashboard/Full Scan logic — Health checks and Management Port discovery."""

import asyncio
import logging
import ipaddress
import os
from datetime import datetime, timezone
from sqlalchemy import select
from app.database import async_session
from app.models.device import Device
from app.models.network import Subnet
from app.scanner.discovery import discover_hosts_simple
from app.scanner.arp import resolve_mac_addresses
from app.scanner.port_scanner import scan_ports
from app.scanner.presence import (
    DEFAULT_OFFLINE_THRESHOLD,
    FALLBACK_PROBE_PORTS,
    get_offline_threshold,
    register_miss,
    register_seen,
)
from app.services.cache_service import discovery_cache, dashboard_cache, topology_cache

logger = logging.getLogger(__name__)

# Ports that make a device "interesting" for management/dashboard
MANAGEMENT_PORTS = [22, 80, 443, 8000, 8080, 8443, 23, 161, 5000, 5001]


async def _sync_local_docker_containers():
    """Sync local Docker containers into the device registry when available."""
    from app.services.docker_service import docker_service
    from app.scanner.sync import sync_docker_containers

    if not docker_service.is_available():
        return
    try:
        local_c = docker_service.get_local_containers()
        if local_c:
            logger.info(f"Dashboard: Syncing {len(local_c)} local Docker containers...")
            await sync_docker_containers(local_c)
    except Exception as e:
        logger.warning(f"Dashboard: Docker container sync failed: {e}")


async def _discover_subnet_hosts(subnet: str) -> list[dict]:
    """Ping/ARP discovery for one subnet; returns resolved hosts."""
    from app.scanner.sync import sync_hosts_batch

    dns_server = None
    async with async_session() as db:
        res_sub = await db.execute(select(Subnet).where(Subnet.cidr == subnet))
        sub_obj = res_sub.scalar_one_or_none()
        if sub_obj:
            dns_server = sub_obj.dns_server

    net = ipaddress.ip_network(subnet, strict=False)
    target_ips = [str(ip) for ip in net.hosts()]

    # No callback here either to prevent many commits
    alive_hosts = await discover_hosts_simple(target_ips, dns_server=dns_server)
    resolved = await resolve_mac_addresses(alive_hosts)

    if resolved:
        await sync_hosts_batch(resolved, is_planner_scan=False, should_invalidate_cache=False)
    return resolved


def _is_docker_host(ip: str) -> bool:
    from app.services.docker_service import docker_service

    host_ip = os.getenv("DOCKER_HOST_IP")
    return ip == host_ip and docker_service.is_available()


def _mark_device_online(dev, alive_host):
    """Refresh last_seen and backfill MAC/vendor from the alive-map entry."""
    dev.last_seen = datetime.now(timezone.utc)
    if alive_host and not dev.mac:
        dev.mac = alive_host.get("mac")
        if dev.mac:
            dev.vendor = alive_host.get("vendor")


async def _update_device_health(
    dev, alive_map: dict, open_ports: list, db, offline_threshold: int = DEFAULT_OFFLINE_THRESHOLD
):
    """Update online state, MAC/vendor backfill and service status for one device."""
    is_online = dev.ip in alive_map or bool(open_ports) or _is_docker_host(dev.ip)

    if is_online:
        _mark_device_online(dev, alive_map.get(dev.ip))
        register_seen(dev)
    else:
        # Offline only after N consecutive misses (history + webhook shared with planner)
        await register_miss(dev, db, offline_threshold)

    for svc in dev.services:
        svc.is_up = svc.port in open_ports
        svc.last_checked = datetime.now(timezone.utc)


async def _check_health_batch(
    batch, alive_map: dict, db, offline_threshold: int = DEFAULT_OFFLINE_THRESHOLD
):
    """Port-scan one batch of devices and update their health."""
    health_tasks = []
    for dev in batch:
        is_ping_alive = dev.ip in alive_map
        target_ports = [s.port for s in dev.services]
        if not target_ports:
            target_ports = FALLBACK_PROBE_PORTS

        timeout = 0.5 if is_ping_alive else 1.0
        health_tasks.append(scan_ports(dev.ip, ports=target_ports, timeout=timeout))

    batch_results = await asyncio.gather(*health_tasks)
    for dev, open_ports in zip(batch, batch_results):
        await _update_device_health(dev, alive_map, open_ports, db, offline_threshold)


async def _run_health_phase(alive_map: dict, progress_callback=None):
    """Verify health of all known dashboard devices; returns the device list."""
    async with async_session() as db:
        from sqlalchemy.orm import selectinload

        res_dev = await db.execute(
            select(Device).options(selectinload(Device.services))
        )
        devices = res_dev.scalars().all()
        offline_threshold = await get_offline_threshold(db)

        logger.info(f"Dashboard: Verifying health for {len(devices)} devices.")
        if progress_callback: await progress_callback(f"Verifying {len(devices)} devices...")

        batch_size = 12  # Increased batch size for efficiency
        for i in range(0, len(devices), batch_size):
            await _check_health_batch(devices[i:i+batch_size], alive_map, db, offline_threshold)
            # One commit per batch
            await db.commit()

        dashboard_cache.invalidate_all()
        topology_cache.invalidate()
    return devices


async def _find_new_management_devices(all_resolved_hosts: list[dict], devices) -> list[dict]:
    """Scan unknown hosts for management ports; returns new-found hosts."""
    from app.scanner.classifier import classify_device

    new_found_hosts = []
    known_ips = {d.ip for d in devices}

    for host in all_resolved_hosts:
        ip = host["ip"]
        if ip in known_ips:
            continue
        # For new hosts, we check management ports
        found_ports = await scan_ports(ip, ports=MANAGEMENT_PORTS, timeout=0.5)
        if found_ports:
            classification = classify_device({"ip": ip, "ports": found_ports})
            hostname = host.get("hostname") or classification.get("hostname")
            new_found_hosts.append({
                "ip": ip,
                "mac": host.get("mac"),
                "hostname": hostname,
                "vendor": host.get("vendor"),
                "ports": found_ports
            })
    return new_found_hosts


async def _discover_subnet_safely(subnet: str, progress_callback=None) -> list[dict]:
    """Discover one subnet; logs and returns [] on failure."""
    try:
        if progress_callback: await progress_callback(f"Ping/ARP discovery on {subnet}...")
        resolved = await _discover_subnet_hosts(subnet)
    except Exception as e:
        logger.error(f"Discovery failed for subnet {subnet}: {e}")
        return []
    if resolved and progress_callback:
        await progress_callback("EVENT:RELOAD_DEVICES")
    return resolved


async def _run_discovery_phase(subnets: list[str], progress_callback=None) -> list[dict]:
    """Ping/ARP discovery across all subnets; returns every resolved host."""
    all_resolved_hosts = []
    for subnet in subnets:
        resolved = await _discover_subnet_safely(subnet, progress_callback)
        all_resolved_hosts.extend(resolved)
    logger.info(f"Dashboard: Discovery phase complete. Found {len(all_resolved_hosts)} potential hosts.")
    return all_resolved_hosts


async def run_dashboard_scan(subnets: list[str], progress_callback=None):
    """
    Executes a deep scan for the Dashboard.
    1. Checks health of all existing Dashboard devices.
    2. Scans subnets for 'relevant' devices (with management ports).
    """
    logger.info("Dashboard: Starting hybrid strongest scan (Ping/ARP + Port Health).")
    if progress_callback: await progress_callback("Dashboard: Starting discovery...")

    # Sync local Docker containers first
    await _sync_local_docker_containers()

    from app.scanner.sync import sync_hosts_batch

    # 1. Faster discovery phase
    all_resolved_hosts = await _run_discovery_phase(subnets, progress_callback)

    # Map for quick lookup
    alive_map = {h["ip"]: h for h in all_resolved_hosts}

    # 2. Deep Health & Service Phase
    devices = await _run_health_phase(alive_map, progress_callback)

    # 3. Intelligent Discovery Phase (New Finds)
    logger.info("Dashboard: Scanning for new management devices.")
    if progress_callback: await progress_callback("Searching for new devices...")

    new_found_hosts = await _find_new_management_devices(all_resolved_hosts, devices)

    if new_found_hosts:
        await sync_hosts_batch(new_found_hosts, is_planner_scan=False)

    logger.info(f"Dashboard scan finished. Discovered {len(new_found_hosts)} new interesting devices.")

    # Trigger scan.complete webhook
    from app.services.webhook_service import trigger_webhooks
    await trigger_webhooks(
        event_type="scan.complete",
        data={
            "scan_type": "dashboard",
            "new_devices_found": len(new_found_hosts),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }
    )

    # Final invalidation
    discovery_cache.invalidate()
    dashboard_cache.invalidate_all()
    topology_cache.invalidate()
    return len(new_found_hosts)