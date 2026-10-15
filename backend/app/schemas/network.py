"""Pydantic schemas for network subnet management."""

import ipaddress

from pydantic import BaseModel, Field, field_validator


def normalize_dns_server(value: str | None) -> str | None:
    """Return a DNS server as a plain IP address, or None when unset.

    The value ends up as an argument to `nmap --dns-servers` and as a dnspython
    nameserver, so only a single IPv4/IPv6 address is accepted. Empty or
    whitespace-only values mean "no custom DNS server". Raises ValueError otherwise.
    """
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        raise ValueError(
            f"Invalid DNS server: '{value}'. Must be a single IP address (e.g. 192.168.1.1)."
        ) from None


class SubnetBase(BaseModel):
    cidr: str = Field(..., description="Subnet in CIDR notation (e.g. 192.168.100.0/24)")
    name: str = Field(..., description="Human-readable name for the subnet")
    dns_server: str | None = Field(None, description="Optional specific DNS server to use for this subnet")
    is_enabled: bool = True


class SubnetCreate(SubnetBase):
    @field_validator("dns_server")
    @classmethod
    def validate_dns_server(cls, v: str | None) -> str | None:
        return normalize_dns_server(v)


class SubnetUpdate(BaseModel):
    cidr: str | None = None
    name: str | None = None
    dns_server: str | None = None
    is_enabled: bool | None = None

    @field_validator("dns_server")
    @classmethod
    def validate_dns_server(cls, v: str | None) -> str | None:
        return normalize_dns_server(v)


class SubnetResponse(SubnetBase):
    # No validator here: rows stored before validation existed must still serialize
    id: int
    is_direct_l2: bool = True
    interface_name: str | None = None

    class Config:
        from_attributes = True

