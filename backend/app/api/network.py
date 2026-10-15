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


def _enrich_subnet(subnet: Subnet, parsed_locals: list[tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, str]]) -> SubnetResponse:
    """Enrich Subnet model with L2 direct attachment and interface name."""
    is_direct = False
    ifname = None
    try:
        s_net = ipaddress.ip_network(subnet.cidr, strict=False)
        for l_net, name in parsed_locals:
            if s_net.overlaps(l_net):
                is_direct = True
                ifname = name
                break
    except ValueError:
        pass

    return SubnetResponse(
        id=subnet.id,
        cidr=subnet.cidr,
        name=subnet.name,
        dns_server=subnet.dns_server,
        is_enabled=subnet.is_enabled,
        is_direct_l2=is_direct,
        interface_name=ifname,
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
    return [_enrich_subnet(s, parsed_locals) for s in subnets]


@router.post("/subnets", response_model=SubnetResponse, dependencies=[Depends(get_current_admin)])
async def create_subnet(subnet_in: SubnetCreate, db: AsyncSession = Depends(get_db)):
    """Create a new subnet configuration."""
    subnet = Subnet(**subnet_in.model_dump())
    db.add(subnet)
    await db.commit()
    await db.refresh(subnet)
    parsed_locals = _get_parsed_local_subnets()
    return _enrich_subnet(subnet, parsed_locals)


@router.patch("/subnets/{subnet_id}", response_model=SubnetResponse, dependencies=[Depends(get_current_admin)])
async def update_subnet(subnet_id: int, subnet_in: SubnetUpdate, db: AsyncSession = Depends(get_db)):
    """Update a subnet configuration."""
    subnet = await db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    
    update_data = subnet_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(subnet, field, value)
    
    await db.commit()
    await db.refresh(subnet)
    parsed_locals = _get_parsed_local_subnets()
    return _enrich_subnet(subnet, parsed_locals)


@router.delete("/subnets/{subnet_id}", dependencies=[Depends(get_current_admin)])
async def delete_subnet(subnet_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a subnet configuration."""
    subnet = await db.get(Subnet, subnet_id)
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")
    
    await db.delete(subnet)
    await db.commit()
    return {"status": "ok"}

