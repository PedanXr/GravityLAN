"""Pydantic schemas for device-related API requests and responses."""

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.interface import DeviceInterfaceResponse


class ServiceResponse(BaseModel):
    """API response schema for a device service."""

    id: int
    name: str
    protocol: str
    port: int
    url_template: str
    color: str | None = None
    is_auto_detected: bool = True
    sort_order: int = 0
    is_up: bool = True
    last_checked: datetime | None = None
    ignore_ssl: bool = False

    model_config = {"from_attributes": True}


class ServiceCreate(BaseModel):
    """Schema for creating a new service for a device."""

    name: str = Field(..., min_length=1, max_length=50)
    protocol: str = Field("http", max_length=20)
    port: int = Field(..., ge=1, le=65535)
    url_template: str = ""
    color: str | None = None
    sort_order: int = 0
    is_auto_detected: bool = False
    ignore_ssl: bool = False


class ServiceUpdate(BaseModel):
    """Schema for updating an existing service."""

    name: str | None = None
    protocol: str | None = None
    port: int | None = Field(None, ge=1, le=65535)
    url_template: str | None = None
    color: str | None = None
    sort_order: int | None = None
    is_up: bool | None = None
    ignore_ssl: bool | None = None


class DeviceHistoryResponse(BaseModel):
    """API response schema for a device history record."""

    id: int
    device_id: int
    service_id: int | None = None
    status: str
    message: str | None = None
    timestamp: datetime

    model_config = {"from_attributes": True}


class AgentInfo(BaseModel):
    """Simplified agent status for device lists."""
    agent_version: str | None = None
    latest_version: str | None = None
    latest_metrics: dict | None = None


class DeviceResponse(BaseModel):
    """API response schema for a discovered device."""

    id: int
    ip: str
    mac: str | None = None
    hostname: str | None = None
    display_name: str
    device_type: str
    device_subtype: str
    vendor: str | None = None
    group_id: int | None = None
    icon: str | None = None
    sort_order: int = 0
    is_pinned: bool = False
    is_hidden: bool = False
    x: int | None = None
    y: int | None = None
    w: int | None = None
    h: int | None = None
    notes: str | None = None
    first_seen: datetime
    last_seen: datetime
    is_online: bool = True
    alert_offline: bool = True
    is_reserved: bool = False
    virtual_type: str | None = None
    status_changed_at: datetime | None = None
    old_ip: str | None = None
    ip_changed_at: datetime | None = None
    ip_placeholder: bool = False
    has_agent: bool = False
    agent_info: AgentInfo | None = None
    services: list[ServiceResponse] = []
    # Rack placement
    rack_id: int | None = None
    rack_unit: int | None = None
    rack_height: int = 1
    # Topology map position
    topology_x: int | None = None
    topology_y: int | None = None
    max_ports: int | None = None
    topology_config: str | None = None
    is_wlan: bool = False
    is_ap: bool = False
    is_host: bool = False
    # Status string (online/offline/unknown)
    status: str | None = None
    has_pending_token: bool = False
    # Parent host (for VMs)
    parent_id: int | None = None
    parent_name: str | None = None
    # Subnet of the primary ip and the device's further addresses (multi-VLAN gateways)
    subnet_id: int | None = None
    subnet_name: str | None = None
    subnet_vlan_id: int | None = None
    interfaces: list[DeviceInterfaceResponse] = []

    model_config = {"from_attributes": True}


class DeviceUpdate(BaseModel):
    """Schema for updating a device's user-editable fields."""

    display_name: str | None = None
    device_type: str | None = None
    device_subtype: str | None = None
    vendor: str | None = None
    group_id: int | None = None
    icon: str | None = None
    sort_order: int | None = None
    is_pinned: bool | None = None
    is_hidden: bool | None = None
    x: int | None = None
    y: int | None = None
    w: int | None = None
    h: int | None = None
    notes: str | None = None
    virtual_type: str | None = None
    is_reserved: bool | None = None
    alert_offline: bool | None = None
    old_ip: str | None = None
    ip_changed_at: datetime | None = None
    ip_placeholder: bool | None = None
    # Rack placement
    rack_id: int | None = None
    rack_unit: int | None = None
    rack_height: int | None = None
    # Topology map position
    topology_x: int | None = None
    topology_y: int | None = None
    max_ports: int | None = None
    topology_config: str | None = None
    is_wlan: bool | None = None
    is_ap: bool | None = None
    is_host: bool | None = None
    # Parent host (for VMs)
    parent_id: int | None = None


class GroupResponse(BaseModel):
    """API response schema for a device group."""

    id: int
    name: str
    icon: str | None = None
    color: str | None = None
    sort_order: int = 0
    is_default: bool = False
    device_count: int = 0

    model_config = {"from_attributes": True}


class GroupWithDevicesResponse(GroupResponse):
    """API response schema for a device group including its devices."""
    devices: list[DeviceResponse] = []


class GroupCreate(BaseModel):
    """Schema for creating a new device group."""

    name: str = Field(..., min_length=1, max_length=100)
    icon: str | None = None
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    sort_order: int = 0


class GroupUpdate(BaseModel):
    """Schema for updating an existing device group."""

    name: str | None = Field(None, min_length=1, max_length=100)
    icon: str | None = None
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    sort_order: int | None = None


class DiscoveredHostResponse(BaseModel):
    """API response schema for a discovered host in the Network Plan."""

    id: int
    ip: str
    mac: str | None = None
    hostname: str | None = None
    custom_name: str | None = None
    vendor: str | None = None
    is_online: bool = True
    is_monitored: bool = False
    is_reserved: bool = False
    ip_placeholder: bool = False
    first_seen: datetime
    last_seen: datetime

    model_config = {"from_attributes": True}


class DiscoveredHostUpdate(BaseModel):
    """Schema for updating a discovered host's user-editable fields."""

    custom_name: str | None = None
    is_monitored: bool | None = None
    is_reserved: bool | None = None
    old_ip: str | None = None
    ip_changed_at: datetime | None = None
    ip_placeholder: bool | None = None
