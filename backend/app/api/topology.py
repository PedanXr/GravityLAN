from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import List

from app.api.auth import get_current_admin
from app.database import get_db
from app.models.topology import Rack as RackModel, TopologyLink as LinkModel
from app.models.device import Device as DeviceModel
from app.schemas.topology import Rack as RackSchema, RackCreate, TopologyLink as LinkSchema, TopologyLinkCreate, TopologyLinkUpdate
from app.services.cache_service import topology_cache

# Auth on the router itself (defense in depth); main.py adds it again on include.
router = APIRouter(prefix="/api/topology", tags=["topology"], dependencies=[Depends(get_current_admin)])

@router.get("/map")
async def get_topology_map(db: AsyncSession = Depends(get_db)):
    """Unified endpoint for the topology map, backed by in-memory cache."""
    if not topology_cache.is_stale():
        cached = topology_cache.get_all()
        if cached: return cached

    # Cache miss: Fetch everything
    devices_res = await db.execute(select(DeviceModel))
    links_res = await db.execute(select(LinkModel))
    racks_res = await db.execute(select(RackModel))
    
    # Simple conversion to dict for JSON serialization
    # In a real app, we'd use schemas, but for the cache dict is fine
    from app.schemas.device import DeviceResponse as DeviceSchema
    from app.schemas.topology import Rack as RackSchema, TopologyLink as LinkSchema
    
    devices = [DeviceSchema.model_validate(d).model_dump() for d in devices_res.scalars().all()]
    links = [LinkSchema.model_validate(l).model_dump() for l in links_res.scalars().all()]
    racks = [RackSchema.model_validate(r).model_dump() for r in racks_res.scalars().all()]
    
    topology_cache.set_data(devices, links, racks)
    return topology_cache.get_all()

# --- Rack Endpoints ---

@router.get("/racks", response_model=List[RackSchema])
async def get_racks(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(RackModel))
    return result.scalars().all()

@router.post("/racks", response_model=RackSchema)
async def create_rack(rack: RackCreate, db: AsyncSession = Depends(get_db)):
    db_rack = RackModel(**rack.model_dump())
    db.add(db_rack)
    await db.commit()
    topology_cache.invalidate()
    await db.refresh(db_rack)
    return db_rack

@router.delete("/racks/{rack_id}")
async def delete_rack(rack_id: int, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(RackModel).where(RackModel.id == rack_id))
    await db.commit()
    topology_cache.invalidate()
    return {"message": "Rack deleted"}

# --- Link Endpoints ---

@router.get("/links", response_model=List[LinkSchema])
async def get_links(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(LinkModel))
    return result.scalars().all()

@router.post("/links", response_model=LinkSchema)
async def create_link(link: TopologyLinkCreate, db: AsyncSession = Depends(get_db)):
    # Prevent duplicate links between same devices if needed, but for now just allow
    db_link = LinkModel(**link.model_dump())
    db.add(db_link)
    await db.commit()
    topology_cache.invalidate()
    await db.refresh(db_link)
    return db_link

@router.patch("/links/{link_id}", response_model=LinkSchema)
async def update_link(link_id: int, link_update: TopologyLinkUpdate, db: AsyncSession = Depends(get_db)):
    # TopologyLinkUpdate allows partial updates
    db_link = await db.get(LinkModel, link_id)
    if not db_link:
        raise HTTPException(status_code=404, detail="Link not found")
    
    update_data = link_update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(db_link, field, value)
    
    await db.commit()
    topology_cache.invalidate()
    await db.refresh(db_link)
    return db_link

@router.delete("/links/{link_id}")
async def delete_link(link_id: int, db: AsyncSession = Depends(get_db)):
    await db.execute(delete(LinkModel).where(LinkModel.id == link_id))
    await db.commit()
    topology_cache.invalidate()
    return {"message": "Link deleted"}

@router.get("/nodes")
async def get_topology_nodes(db: AsyncSession = Depends(get_db)):
    """Fetch all nodes (devices) from the topology map."""
    map_data = await get_topology_map(db)
    return map_data["devices"]

@router.get("/edges")
async def get_topology_edges(db: AsyncSession = Depends(get_db)):
    """Fetch all edges (links) from the topology map."""
    map_data = await get_topology_map(db)
    return map_data["links"]
