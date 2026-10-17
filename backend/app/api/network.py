"""API router for network subnet management."""

import logging
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session, get_db
from app.models.network import Subnet
from sqlalchemy import delete
import ipaddress
from app.schemas.network import SubnetCreate, SubnetResponse, SubnetUpdate
from app.scanner.subnets import find_subnet

logger = logging.getLogger(__name__)
from app.api.auth import get_current_admin

router = APIRouter(prefix="/api/network", tags=["network"])


async def cleanup_invalid_subnets():
    """Remove subnets that are not valid IP networks."""
    async with async_session() as session:
        try:
            result = await session.execute(select(Subnet))
            subnets = result.scalars().all()
            invalid_ids = []
            for sub in subnets:
                try:
                    ipaddress.ip_network(sub.cidr, strict=False)
                except ValueError:
                    logger.warning(f"Removing invalid subnet from database: {sub.cidr}")
                    invalid_ids.append(sub.id)
            if invalid_ids:
                await session.execute(delete(Subnet).where(Subnet.id.in_(invalid_ids)))
                await session.commit()
        except Exception as e:
            logger.error(f"Failed to cleanup invalid subnets: {e}")


def _get_parsed_local_subnets() -> list[tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, str]]:
    """Return parsed non-virtual local subnets and their interface names."""
    from app.scanner.utils import get_local_subnets
    parsed = []
    try:
        for ls in get_local_subnets():
            if getattr(ls, "is_virtual", False):
                continue
            try:
                parsed.append((ipaddress.ip_network(ls.subnet, strict=False), ls.interface_name))
            except ValueError:
                continue
    except Exception as e:
        logger.warning(f"Could not retrieve local subnets: {e}")
    return parsed


async def _get_active_agent_probes(db: AsyncSession) -> list[tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, str, str]]:
    """Return list of (ip_addr, device_name, device_ip_str) for devices with active agent and enable_scanner_relay=True."""
    from app.models.agent import AgentConfig, AgentToken
    from app.models.device import Device
    try:
        stmt = (
            select(Device.ip, Device.display_name, Device.hostname)
            .join(AgentConfig, AgentConfig.device_id == Device.id)
            .join(AgentToken, AgentToken.device_id == Device.id)
            .where(
                AgentConfig.enable_scanner_relay == True,
                AgentToken.is_active == True,
            )
        )
        result = await db.execute(stmt)
        probes = []
        for ip_str, display_name, hostname in result.all():
            try:
                name = display_name or hostname or ip_str
                probes.append((ipaddress.ip_address(ip_str), name, ip_str))
            except ValueError:
                continue
        return probes
    except Exception as e:
        logger.warning(f"Could not load agent probes: {e}")
        return []


def _enrich_subnet(
    subnet: Subnet,
    parsed_locals: list[tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, str]],
    probes: list[tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, str, str]],
) -> SubnetResponse:
    """Enrich Subnet model with L2 direct attachment, probe status, and interface name."""
    is_direct = False
    ifname = None
    s_net = None
    try:
        s_net = ipaddress.ip_network(subnet.cidr, strict=False)
        for l_net, name in parsed_locals:
            if s_net.overlaps(l_net):
                is_direct = True
                ifname = name
                break
    except ValueError:
        pass

    is_probe = False
    probe_name = None
    probe_ip = None
    if not is_direct and s_net:
        for p_addr, p_name, p_ip_str in probes:
            if p_addr in s_net:
                is_probe = True
                probe_name = p_name
                probe_ip = p_ip_str
                break

    return SubnetResponse(
        id=subnet.id,
        cidr=subnet.cidr,
        name=subnet.name,
        dns_server=subnet.dns_server,
        is_enabled=subnet.is_enabled,
        is_direct_l2=is_direct,
        interface_name=ifname,
        is_agent_probe=is_probe,
        probe_device_name=probe_name,
        probe_device_ip=probe_ip,
    )


@router.on_event("startup")
async def on_startup():
    await cleanup_invalid_subnets()


@router.get("/subnets", response_model=list[SubnetResponse], dependencies=[Depends(get_current_admin)])
async def get_subnets(db: AsyncSession = Depends(get_db)):
    """Get all configured subnets with L2/L3 reachability details."""
    result = await db.execute(select(Subnet).order_by(Subnet.name))
    subnets = result.scalars().all()
    parsed_locals = _get_parsed_local_subnets()
    probes = await _get_active_agent_probes(db)
    return [_enrich_subnet(s, parsed_locals, probes) for s in subnets]


@router.post("/subnets", response_model=SubnetResponse, dependencies=[Depends(get_current_admin)])
async def create_subnet(subnet_in: SubnetCreate, db: AsyncSession = Depends(get_db)):
    """Create a new subnet configuration; it is scanned and shown as a tab while enabled."""
    if await find_subnet(db, subnet_in.cidr):
        raise HTTPException(status_code=409, detail=f"Subnet {subnet_in.cidr} is already configured")
    subnet = Subnet(**subnet_in.model_dump())
    db.add(subnet)
    await db.commit()
    await db.refresh(subnet)
    parsed_locals = _get_parsed_local_subnets()
    probes = await _get_active_agent_probes(db)
    return _enrich_subnet(subnet, parsed_locals, probes)


@router.patch("/subnets/{subnet_id}", response_model=SubnetResponse, dependencies=[Depends(get_current_admin)])
async def update_subnet(subnet_id: int, subnet_in: SubnetUpdate, db: AsyncSession = Depends(get_db)):
    """Update a subnet configuration."""
    subnet = await db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    
    update_data = subnet_in.model_dump(exclude_unset=True)
    if update_data.get("cidr") and await find_subnet(db, update_data["cidr"], exclude_id=subnet_id):
        raise HTTPException(status_code=409, detail=f"Subnet {update_data['cidr']} is already configured")
    for field, value in update_data.items():
        setattr(subnet, field, value)
    
    await db.commit()
    await db.refresh(subnet)
    parsed_locals = _get_parsed_local_subnets()
    probes = await _get_active_agent_probes(db)
    return _enrich_subnet(subnet, parsed_locals, probes)



@router.delete("/subnets/{subnet_id}", dependencies=[Depends(get_current_admin)])
async def delete_subnet(subnet_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a subnet configuration."""
    subnet = await db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    
    await db.delete(subnet)
    await db.commit()
    return {"status": "ok"}

