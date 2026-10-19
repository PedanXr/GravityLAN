"""Online/offline hysteresis shared by the planner and dashboard scanners.

A single missed ping/ARP reply is not proof that a device is gone: ipvlan
containers on Unraid, busy switch management CPUs and Wi-Fi clients in power
save all drop probes occasionally. A device is therefore only flipped offline
(with history entry and ``device.offline`` webhook) after ``offline_threshold``
consecutive failed checks. Any successful check resets the counter.
"""

import asyncio
import ipaddress
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.scanner.port_scanner import scan_ports

logger = logging.getLogger(__name__)

OFFLINE_THRESHOLD_KEY = "scanner.offline_threshold"
DEFAULT_OFFLINE_THRESHOLD = 3

# TCP ports probed before counting a miss for devices without configured services
FALLBACK_PROBE_PORTS = [22, 80, 443, 8080, 8443]


async def get_offline_threshold(db) -> int:
    """Read the offline threshold setting; invalid or missing values fall back to the default."""
    from app.models.setting import Setting

    res = await db.execute(select(Setting).where(Setting.key == OFFLINE_THRESHOLD_KEY))
    setting = res.scalar_one_or_none()
    if setting and setting.value and setting.value.strip().isdigit():
        return max(1, int(setting.value.strip()))
    return DEFAULT_OFFLINE_THRESHOLD


def register_seen(dev) -> None:
    """Mark a device as reachable and reset its missed-check counter."""
    dev.is_online = True
    dev.missed_scans = 0


async def register_miss(dev, db, offline_threshold: int) -> bool:
    """Count one failed check; flip the device offline once the threshold is reached.

    Returns True when the device was marked offline by this call.
    """
    if not dev.is_online:
        return False

    dev.missed_scans = (dev.missed_scans or 0) + 1
    if dev.missed_scans < offline_threshold:
        logger.info(
            f"Presence: {dev.display_name or dev.hostname or dev.ip} missed check "
            f"{dev.missed_scans}/{offline_threshold}, keeping online"
        )
        return False

    dev.is_online = False
    dev.status_changed_at = datetime.now(timezone.utc)
    await mark_device_offline(dev, db)
    return True


def _parse_networks(subnets: list[str]) -> list:
    nets = []
    for cidr in subnets:
        try:
            nets.append(ipaddress.ip_network(cidr, strict=False))
        except (ValueError, TypeError):
            continue
    return nets


def _in_networks(ip: str, nets: list) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in nets)


async def update_interface_presence(
    db, subnets: list[str], alive_ips: set[str], offline_threshold: int = DEFAULT_OFFLINE_THRESHOLD
) -> None:
    """Same hysteresis for device interfaces in the scanned subnets, but silent.

    An interface is one more address of a device that already has its own
    offline history and webhook, so a router reports once, not once per VLAN.
    Interfaces outside the scanned subnets are left as they are.
    """
    from app.models.device import DeviceInterface

    nets = _parse_networks(subnets)
    if not nets:
        return
    for iface in (await db.execute(select(DeviceInterface))).scalars().all():
        if not _in_networks(iface.ip, nets):
            continue
        if iface.ip in alive_ips:
            iface.is_online = True
            iface.missed_scans = 0
            iface.last_seen = datetime.now(timezone.utc)
        elif iface.is_online:
            iface.missed_scans = (iface.missed_scans or 0) + 1
            if iface.missed_scans >= offline_threshold:
                iface.is_online = False


async def tcp_fallback_alive(ips: list[str], timeout: float = 1.0) -> set[str]:
    """Return the IPs that accept a TCP handshake on any fallback port."""
    if not ips:
        return set()
    results = await asyncio.gather(
        *(scan_ports(ip, ports=FALLBACK_PROBE_PORTS, timeout=timeout) for ip in ips)
    )
    return {ip for ip, open_ports in zip(ips, results) if open_ports}


async def mark_device_offline(dev, db):
    """Log the offline transition to the device history and trigger the webhook."""
    if not getattr(dev, "alert_offline", True):
        # Client / Non-24/7 devices (e.g. PC, TV) should not generate outage events or alarms
        return

    from app.models.device import DeviceHistory

    db.add(DeviceHistory(
        device_id=dev.id,
        status="offline",
        message=f"Device {dev.display_name or dev.hostname or dev.ip} went offline"
    ))

    from app.services.webhook_service import trigger_webhooks
    await trigger_webhooks(
        event_type="device.offline",
        data={
            "device_id": dev.id,
            "ip": dev.ip,
            "mac": dev.mac,
            "display_name": dev.display_name,
            "hostname": dev.hostname,
            "last_seen": dev.last_seen.isoformat() if dev.last_seen else None
        }
    )
