"""Setup wizard API — checks setup state and provides initial configuration."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.device import Device
from app.models.setting import Setting
from app.version import VERSION

import logging
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/setup", tags=["setup"])


@router.get("/status")
async def get_setup_status(db: AsyncSession = Depends(get_db)) -> dict:
    """Check if the initial setup has been completed.

    Returns:
        Dict with 'is_setup_complete' boolean and device count.
    """
    # Check if setup_complete flag is set in settings
    result = await db.execute(
        select(Setting).where(Setting.key == "setup.complete")
    )
    setting = result.scalar_one_or_none()

    device_count_result = await db.execute(select(func.count(Device.id)))
    device_count = device_count_result.scalar() or 0

    is_complete = setting is not None and setting.value == "true"
    device_count_val = device_count

    res = {
        "is_setup_complete": is_complete,
        "device_count": device_count_val,
        "version": VERSION
    }
    return res


import ipaddress

from pydantic import BaseModel, Field, field_validator

from app.schemas.network import normalize_dns_server

MAX_SETUP_SUBNETS = 64


class SetupCompleteRequest(BaseModel):
    dns_server: str | None = None
    admin_password: str | None = None
    # Subnets the wizard scanned. Their hosts are adopted even when the subnet is routed
    # (another VLAN) and therefore not bound to a local interface.
    subnets: list[str] | None = Field(default=None, max_length=MAX_SETUP_SUBNETS)

    @field_validator("dns_server")
    @classmethod
    def validate_dns_server(cls, v: str | None) -> str | None:
        # Goes to nmap --dns-servers and dnspython; empty means "no custom DNS"
        return normalize_dns_server(v)

    @field_validator("subnets")
    @classmethod
    def validate_subnets(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        return [str(ipaddress.ip_network(cidr.strip(), strict=False)) for cidr in v]


def _adoption_networks(requested: list[str] | None, local_subnets) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """Networks whose hosts the wizard may adopt: the scanned subnets, else the detected local ones.

    get_local_subnets() already prefers physical interfaces and only falls back to virtual
    ones when nothing else exists (Docker bridge mode), so that list is used unfiltered.
    """
    cidrs = requested or [s.subnet for s in local_subnets]
    return [ipaddress.ip_network(cidr, strict=False) for cidr in cidrs]


def _in_adoption_networks(host, networks) -> bool:
    """Return True when the host IP belongs to one of the allowed adoption networks."""
    try:
        ip_obj = ipaddress.ip_address(host.ip)
    except ValueError:
        return False
    return any(ip_obj in net for net in networks)


async def _process_discovered_host(host, group_map, existing_ips, adoption_networks, dns_server):
    """Classify and package one discovered host into a (device, services, host) tuple or None."""
    from app.models.device import Device, Service
    from app.scanner.classifier import classify_device
    from app.scanner.hostname import resolve_hostname, is_ip_like
    from app.scanner.port_scanner import scan_ports, DEFAULT_SCAN_PORTS
    from app.scanner.utils import GROUP_TYPE_MAP

    if not _in_adoption_networks(host, adoption_networks):
        logger.debug(f"Setup: Skipping {host.ip} - outside the scanned networks.")
        return None

    if host.ip in existing_ips:
        return None

    # Full discovery of key ports for better classification
    found_ports = await scan_ports(host.ip, ports=DEFAULT_SCAN_PORTS, timeout=0.4)

    # Try hostname resolution again if missing or just an IP
    current_hostname = host.hostname
    if is_ip_like(current_hostname):
        new_hname = await resolve_hostname(host.ip, timeout=1.5, dns_server=dns_server)
        if new_hname:
            current_hostname = new_hname
            host.hostname = new_hname

    classified = classify_device({
        "ip": host.ip,
        "hostname": current_hostname,
        "mac": host.mac,
        "ports": found_ports
    }) or {"device_type": "unknown", "device_subtype": "Unknown", "services": []}

    device_type = classified.get("device_type", "unknown")
    group_name = GROUP_TYPE_MAP.get(device_type, "Newly discovered")
    group_id = group_map.get(group_name, group_map.get("Newly discovered"))

    # Format display name (strip domain)
    display_name = host.ip
    if current_hostname and not is_ip_like(current_hostname):
        display_name = current_hostname.split('.')[0]
    elif host.custom_name:
        display_name = host.custom_name

    device = Device(
        ip=host.ip, mac=host.mac, hostname=current_hostname, display_name=display_name,
        device_type=device_type, device_subtype=classified.get("device_subtype", "Unknown"),
        vendor=host.vendor, group_id=group_id, is_online=True
    )

    services = []
    if "services" in classified:
        for svc_data in classified["services"]:
            services.append(Service(
                name=svc_data["name"], protocol=svc_data["protocol"], port=svc_data["port"],
                url_template=svc_data["url_template"], color=svc_data.get("color"),
                is_auto_detected=True, is_up=True
            ))

    # CRITICAL: Only add device if it has at least one service
    if not services:
        logger.info(f"Setup: Skipping auto-adoption for {host.ip} (No services found)")
        return None

    return (device, services, host)


async def _register_physical_subnets(db, local_subnets) -> None:
    """Add physical subnets to the Network Planner if not already registered."""
    from app.models.network import Subnet
    for net in local_subnets:
        if net.is_virtual:
            continue
        res_sub = await db.execute(select(Subnet).where(Subnet.cidr == net.subnet))
        if not res_sub.scalar_one_or_none():
            logger.info(f"Setup: Registering physical subnet {net.subnet} in Planner.")
            db.add(Subnet(
                name=net.interface_name,
                cidr=net.subnet,
                is_enabled=True
            ))
    await db.flush()


async def _adopt_discovered_hosts(db, dns_server: str | None, subnets: list[str] | None) -> int:
    """Add the discovered online hosts of the scanned networks to the dashboard; returns the count."""
    import asyncio
    from app.models.device import DiscoveredHost, Device
    from app.scanner.utils import ensure_default_groups, get_local_subnets

    host_result = await db.execute(select(DiscoveredHost).where(DiscoveredHost.is_online == True))
    discovered_hosts = host_result.scalars().all()
    if not discovered_hosts:
        return 0

    group_map = await ensure_default_groups(db, commit=False)
    local_subnets = get_local_subnets()
    adoption_networks = _adoption_networks(subnets, local_subnets)

    # Avoid IP duplicates
    existing_res = await db.execute(select(Device.ip))
    existing_ips = set(existing_res.scalars().all())

    # Process all hosts in parallel
    tasks = [_process_discovered_host(h, group_map, existing_ips, adoption_networks, dns_server) for h in discovered_hosts]
    results = [res for res in await asyncio.gather(*tasks) if res]

    # 2b. Add physical subnets to Network Planner
    await _register_physical_subnets(db, local_subnets)

    # 3. Process hosts
    for device, services, host in results:
        db.add(device)
        await db.flush()
        for svc in services:
            svc.device_id = device.id
            db.add(svc)

        # Update discovered host status
        host.is_monitored = True
        db.add(host)

    return len(results)


@router.post("/complete")
async def mark_setup_complete(
    request: SetupCompleteRequest,
    http_request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark the initial setup as completed, sign the admin in and adopt discovered hosts."""
    logger.info(f"mark_setup_complete called: has_password={request.admin_password is not None}")
    
    from app.models.setting import Setting
    from app.services.auth_service import hash_password
    
    # 0. Idempotency check: don't allow setup to run again if already complete
    res_setup = await db.execute(select(Setting).where(Setting.key == "setup.complete"))
    setting_complete = res_setup.scalar_one_or_none()
    if setting_complete and setting_complete.value == "true":
        raise HTTPException(status_code=400, detail="Setup already completed. Use Settings UI to change configuration.")

    # 0a. Save DNS server if provided
    if request.dns_server:
        dns_res = await db.execute(select(Setting).where(Setting.key == "dns.server"))
        dns_s = dns_res.scalar_one_or_none()
        if dns_s:
            dns_s.value = request.dns_server
        else:
            db.add(Setting(key="dns.server", value=request.dns_server, category="scan", description="Custom DNS server for hostname resolution"))
        await db.flush()

    # 0b. Save Admin Password if provided (hashed!)
    if request.admin_password:
        hashed_password = hash_password(request.admin_password)
        pass_res = await db.execute(select(Setting).where(Setting.key == "api.admin_password"))
        pass_s = pass_res.scalar_one_or_none()
        if pass_s:
            pass_s.value = hashed_password
        else:
            db.add(Setting(key="api.admin_password", value=hashed_password, category="system", description="Administrator password for dashboard login"))
        await db.flush()

    # 1. Prepare setup complete flag
    if setting_complete:
        setting_complete.value = "true"
    else:
        db.add(Setting(key="setup.complete", value="true", category="system"))

    # 1b. Initialize Master API Token if missing (ATOMIC WITH SETUP COMPLETE)
    import secrets
    res_token = await db.execute(select(Setting).where(Setting.key == "api.master_token"))
    if not res_token.scalar_one_or_none():
        master_token = secrets.token_hex(32)
        logger.info("Setup: Initializing secure Master API Token (masked for security).")
        db.add(Setting(key="api.master_token", value=master_token))

    # 2. Commit basic settings and token now so the user can login even if migration takes long
    await db.commit()

    # Sign the admin in right away: the wizard ends in the dashboard without a second login request
    if request.admin_password:
        from app.api.auth import issue_session_cookie
        issue_session_cookie(response, http_request.headers.get("user-agent"))

    # 3. Automatically add the discovered online hosts to the dashboard.
    # Best-effort: settings are already committed, so a failure here must not turn into a 500
    # (the session cookie would be lost and a retry ends in "Setup already completed").
    try:
        adopted = await _adopt_discovered_hosts(db, request.dns_server, request.subnets)
        await db.commit()
    except Exception:
        logger.exception("Setup: adopting discovered hosts failed; settings are saved, devices can be added later")
        await db.rollback()
        adopted = 0

    return {"status": "ok", "devices_adopted": adopted}
