"""Pydantic schemas for device interfaces, merge suggestions and the gateway list."""

import ipaddress
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


def _plain_ipv4(value: str) -> str:
    try:
        return str(ipaddress.IPv4Address(value.strip()))
    except (ValueError, AttributeError):
        raise ValueError(f"Invalid IPv4 address: '{value}'") from None


class DeviceInterfaceResponse(BaseModel):
    """One further address of a device (e.g. a router's gateway in another VLAN)."""

    id: int
    device_id: int
    ip: str
    mac: str | None = None
    subnet_id: int | None = None
    subnet_name: str | None = None
    subnet_cidr: str | None = None
    vlan_id: int | None = Field(None, validation_alias="effective_vlan_id")
    label: str | None = None
    is_online: bool = True
    last_seen: datetime | None = None
    first_seen: datetime | None = None

    model_config = {"from_attributes": True, "populate_by_name": True}


class InterfaceCreate(BaseModel):
    ip: str
    label: str | None = Field(None, max_length=100)
    vlan_id: int | None = Field(None, ge=1, le=4094)

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v: str) -> str:
        return _plain_ipv4(v)


class InterfaceUpdate(BaseModel):
    label: str | None = Field(None, max_length=100)
    vlan_id: int | None = Field(None, ge=1, le=4094)


class InterfaceMergeRequest(BaseModel):
    """Make a duplicate Device (source_device_id) or a discovered address (ip) an interface."""

    source_device_id: int | None = None
    ip: str | None = None

    @field_validator("ip")
    @classmethod
    def validate_ip(cls, v: str | None) -> str | None:
        return _plain_ipv4(v) if v else None


MergeReason = Literal["same_mac", "same_hostname", "same_host_key", "subnet_gateway"]


class MergeCandidate(BaseModel):
    kind: Literal["device", "discovered"]
    id: int
    ip: str
    name: str | None = None
    mac: str | None = None
    subnet_id: int | None = None
    subnet_name: str | None = None
    is_online: bool = False


class MergeSuggestion(BaseModel):
    target_id: int
    target_name: str
    target_ip: str
    candidate: MergeCandidate
    reasons: list[MergeReason]


class SuggestionDismiss(BaseModel):
    target_id: int
    kind: Literal["device", "discovered"]
    candidate_ip: str

    @field_validator("candidate_ip")
    @classmethod
    def validate_ip(cls, v: str) -> str:
        return _plain_ipv4(v)


class GatewayEntry(BaseModel):
    """The gateway of one configured subnet and who answers on it."""

    subnet_id: int
    subnet_name: str
    cidr: str
    vlan_id: int | None = None
    is_enabled: bool = True
    gateway_ip: str | None = None
    source: Literal["configured", "detected", "suggested"] | None = None
    device_id: int | None = None
    device_name: str | None = None
    interface_id: int | None = None
    is_primary: bool = False
    is_online: bool | None = None
    last_seen: datetime | None = None
    mac: str | None = None
