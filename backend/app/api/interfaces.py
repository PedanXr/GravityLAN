"""API for device interfaces (further addresses of one device), merge suggestions and subnet gateways."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_admin
from app.database import get_db
from app.models.device import Device, DeviceInterface
from app.schemas.interface import (
    DeviceInterfaceResponse,
    GatewayEntry,
    InterfaceCreate,
    InterfaceMergeRequest,
    InterfaceUpdate,
    MergeSuggestion,
    SuggestionDismiss,
)
from app.services import interface_service
from app.services.cache_service import dashboard_cache, discovery_cache, topology_cache

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["interfaces"], dependencies=[Depends(get_current_admin)])


def _invalidate_caches() -> None:
    dashboard_cache.invalidate_all()
    topology_cache.invalidate()
    discovery_cache.invalidate()


async def _get_device(db: AsyncSession, device_id: int) -> Device:
    device = await interface_service.load_device(db, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


async def _get_interface(db: AsyncSession, device_id: int, interface_id: int) -> DeviceInterface:
    iface = await db.get(DeviceInterface, interface_id)
    if not iface or iface.device_id != device_id:
        raise HTTPException(status_code=404, detail="Interface not found")
    return iface


def _raise(err: interface_service.InterfaceError):
    raise HTTPException(status_code=err.status_code, detail=err.detail)


@router.get("/devices/{device_id}/interfaces", response_model=list[DeviceInterfaceResponse])
async def list_interfaces(device_id: int, db: AsyncSession = Depends(get_db)):
    device = await _get_device(db, device_id)
    return device.interfaces


@router.post("/devices/{device_id}/interfaces", response_model=DeviceInterfaceResponse, status_code=201)
async def add_interface(device_id: int, data: InterfaceCreate, db: AsyncSession = Depends(get_db)):
    """Add an address of this device in another subnet (e.g. its gateway address in a VLAN)."""
    device = await _get_device(db, device_id)
    try:
        iface = await interface_service.attach_address(db, device, data.ip, data.label, data.vlan_id)
    except interface_service.InterfaceError as err:
        _raise(err)
    _invalidate_caches()
    return iface


@router.post("/devices/{device_id}/interfaces/merge", response_model=DeviceInterfaceResponse, status_code=201)
async def merge_into_device(device_id: int, data: InterfaceMergeRequest, db: AsyncSession = Depends(get_db)):
    """Make a duplicate device, or a discovered address, an interface of this device."""
    if (data.source_device_id is None) == (data.ip is None):
        raise HTTPException(status_code=400, detail="Give exactly one of source_device_id or ip")
    device = await _get_device(db, device_id)
    try:
        if data.source_device_id is not None:
            source = await _get_device(db, data.source_device_id)
            iface = await interface_service.merge_device_into(db, device, source)
        else:
            iface = await interface_service.attach_address(db, device, data.ip)
    except interface_service.InterfaceError as err:
        _raise(err)
    _invalidate_caches()
    return iface


@router.patch("/devices/{device_id}/interfaces/{interface_id}", response_model=DeviceInterfaceResponse)
async def update_interface(
    device_id: int, interface_id: int, data: InterfaceUpdate, db: AsyncSession = Depends(get_db)
):
    iface = await _get_interface(db, device_id, interface_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(iface, field, value)
    await db.commit()
    await db.refresh(iface)
    _invalidate_caches()
    return iface


@router.delete("/devices/{device_id}/interfaces/{interface_id}", status_code=204)
async def delete_interface(device_id: int, interface_id: int, db: AsyncSession = Depends(get_db)) -> None:
    """Detach an interface. The address stays in the IP overview as a discovered host."""
    iface = await _get_interface(db, device_id, interface_id)
    await interface_service.detach_interface(db, iface)
    _invalidate_caches()


@router.get("/interfaces/suggestions", response_model=list[MergeSuggestion])
async def list_merge_suggestions(db: AsyncSession = Depends(get_db)):
    """Devices and addresses that look like further interfaces of another device."""
    return await interface_service.find_merge_suggestions(db)


@router.post("/interfaces/suggestions/dismiss", status_code=204)
async def dismiss_merge_suggestion(data: SuggestionDismiss, db: AsyncSession = Depends(get_db)) -> None:
    await interface_service.dismiss_suggestion(db, data.target_id, data.kind, data.candidate_ip)


@router.get("/network/gateways", response_model=list[GatewayEntry])
async def list_subnet_gateways(db: AsyncSession = Depends(get_db)):
    """The gateway address of every configured subnet and which device answers there."""
    return await interface_service.list_gateways(db)
