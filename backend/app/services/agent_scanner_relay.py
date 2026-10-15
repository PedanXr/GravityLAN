"""Service for ingesting Layer-2 ARP neighbors relayed by deployed agents."""

from __future__ import annotations

import ipaddress
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device import Device, DiscoveredHost
from app.scanner.vendor import get_vendor

logger = logging.getLogger(__name__)


def is_valid_mac_address(mac: str | None) -> bool:
    """Validate standard colon-separated MAC address format."""
    if not mac or len(mac) != 17:
        return False
    parts = mac.split(":")
    if len(parts) != 6:
        return False
    if mac.lower() in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
        return False
    try:
        for p in parts:
            int(p, 16)
        return True
    except ValueError:
        return False


async def ingest_agent_arp_table(
    db: AsyncSession,
    reporting_device_id: int,
    arp_entries: list[Any],
) -> int:
    """Ingest ARP table reported by an agent probe.

    Updates MAC addresses on existing devices and adds new discovered hosts.
    Returns the number of ingested/updated hosts.
    """
    if not arp_entries:
        return 0

    now = datetime.now(timezone.utc)
    updated_count = 0

    # Cache existing devices by IP
    dev_res = await db.execute(select(Device))
    devices_by_ip = {d.ip: d for d in dev_res.scalars().all()}

    # Cache existing discovered hosts by IP
    disc_res = await db.execute(select(DiscoveredHost))
    disc_by_ip = {h.ip: h for h in disc_res.scalars().all()}

    for entry in arp_entries:
        raw_ip = entry.get("ip") if isinstance(entry, dict) else getattr(entry, "ip", None)
        raw_mac = entry.get("mac") if isinstance(entry, dict) else getattr(entry, "mac", None)

        if not raw_ip or not raw_mac:
            continue

        raw_ip = str(raw_ip).strip()
        raw_mac = str(raw_mac).strip().upper()

        try:
            ipaddress.ip_address(raw_ip)
        except ValueError:
            continue

        if not is_valid_mac_address(raw_mac):
            continue

        # 1. If device exists on dashboard, enrich MAC and online status
        if raw_ip in devices_by_ip:
            dev = devices_by_ip[raw_ip]
            changed = False
            if not dev.mac or dev.mac != raw_mac:
                dev.mac = raw_mac
                changed = True
            if not dev.vendor:
                dev.vendor = get_vendor(raw_mac)
                changed = True
            if not dev.is_online:
                dev.is_online = True
                dev.last_seen = now
                changed = True
            if changed:
                updated_count += 1
            continue

        # 2. Update or insert DiscoveredHost
        if raw_ip in disc_by_ip:
            disc = disc_by_ip[raw_ip]
            disc.mac = raw_mac
            if not disc.vendor:
                disc.vendor = get_vendor(raw_mac)
            disc.is_online = True
            disc.last_seen = now
            updated_count += 1
        else:
            new_disc = DiscoveredHost(
                ip=raw_ip,
                mac=raw_mac,
                vendor=get_vendor(raw_mac),
                is_online=True,
                first_seen=now,
                last_seen=now,
            )
            db.add(new_disc)
            disc_by_ip[raw_ip] = new_disc
            updated_count += 1

    if updated_count > 0:
        await db.commit()
        logger.info(f"Agent probe {reporting_device_id} updated {updated_count} L2 neighbors.")
        try:
            from app.api.scanner import state as scan_state
            from app.schemas.scan import ScanProgress, ScanStatus
            await scan_state.broadcast(ScanProgress(
                status=ScanStatus.COMPLETED,
                current_subnet="",
                hosts_scanned=updated_count,
                hosts_total=updated_count,
                devices_found=updated_count,
                message=f"Agent probe {reporting_device_id} updated {updated_count} L2 neighbors",
                timestamp=now,
            ))
        except Exception as e:
            logger.debug(f"Could not broadcast scan progress from agent relay: {e}")

    return updated_count
