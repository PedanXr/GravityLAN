"""Pydantic schemas for network subnet management."""

import ipaddress

from pydantic import BaseModel, Field, field_validator, model_validator


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


# Largest network a scan subnet may cover: a /16 already means 65 534 addresses per sweep
MIN_SCAN_PREFIX = 16


def normalize_cidr(value: str) -> str:
    """Return a subnet in canonical IPv4 CIDR form.

    Three octets mean a /24 ('192.168.110' -> '192.168.110.0/24'), host bits are
    cleared ('192.168.110.5/24' -> '192.168.110.0/24') and a bare address becomes
    a /32. Raises ValueError for anything that is not an IPv4 network.
    """
    value = value.strip()
    if "/" not in value and value.count(".") == 2:
        value = f"{value}.0/24"
    try:
        network = ipaddress.ip_network(value, strict=False)
    except ValueError:
        raise ValueError(f"Invalid subnet: '{value}'. Use CIDR notation such as 192.168.1.0/24.") from None
    if network.version != 4:
        raise ValueError(f"Invalid subnet: '{value}'. Only IPv4 subnets can be scanned.")
    return str(network)


def validate_scan_cidr(value: str) -> str:
    """Normalize a subnet entered for scanning and reject networks larger than a /16."""
    cidr = normalize_cidr(value)
    if ipaddress.ip_network(cidr).prefixlen < MIN_SCAN_PREFIX:
        raise ValueError(f"Subnet {cidr} is too large to scan. Use a /{MIN_SCAN_PREFIX} or smaller network.")
    return cidr


def normalize_gateway_ip(value: str | None) -> str | None:
    """Return a gateway as a plain IPv4 address, or None when unset (then it is detected/suggested)."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        raise ValueError(f"Invalid gateway: '{value}'. Must be a single IPv4 address (e.g. 192.168.1.1).") from None


def check_gateway_in_subnet(gateway_ip: str | None, cidr: str) -> None:
    """Raise ValueError when a gateway does not lie inside its subnet."""
    if gateway_ip and ipaddress.IPv4Address(gateway_ip) not in ipaddress.ip_network(cidr, strict=False):
        raise ValueError(f"Gateway {gateway_ip} is not inside {cidr}.")


class SubnetBase(BaseModel):
    cidr: str = Field(..., description="Subnet in CIDR notation (e.g. 192.168.100.0/24)")
    name: str = Field(..., description="Human-readable name for the subnet")
    dns_server: str | None = Field(None, description="Optional specific DNS server to use for this subnet")
    is_enabled: bool = True
    gateway_ip: str | None = Field(None, description="Router address in this subnet; empty means detected or `.1`")
    vlan_id: int | None = Field(None, ge=1, le=4094, description="Optional 802.1Q VLAN tag")


class SubnetCreate(SubnetBase):
    name: str = Field("", description="Human-readable name; defaults to 'Network <cidr>'")

    @field_validator("cidr")
    @classmethod
    def validate_cidr(cls, v: str) -> str:
        return validate_scan_cidr(v)

    @field_validator("dns_server")
    @classmethod
    def validate_dns_server(cls, v: str | None) -> str | None:
        return normalize_dns_server(v)

    @field_validator("gateway_ip")
    @classmethod
    def validate_gateway_ip(cls, v: str | None) -> str | None:
        return normalize_gateway_ip(v)

    @model_validator(mode="after")
    def default_name(self) -> "SubnetCreate":
        self.name = self.name.strip() or f"Network {self.cidr}"
        check_gateway_in_subnet(self.gateway_ip, self.cidr)
        return self


class SubnetUpdate(BaseModel):
    cidr: str | None = None
    name: str | None = None
    dns_server: str | None = None
    is_enabled: bool | None = None
    gateway_ip: str | None = None
    vlan_id: int | None = Field(None, ge=1, le=4094)

    @field_validator("cidr")
    @classmethod
    def validate_cidr(cls, v: str | None) -> str | None:
        return None if v is None else validate_scan_cidr(v)

    @field_validator("dns_server")
    @classmethod
    def validate_dns_server(cls, v: str | None) -> str | None:
        return normalize_dns_server(v)

    @field_validator("gateway_ip")
    @classmethod
    def validate_gateway_ip(cls, v: str | None) -> str | None:
        return normalize_gateway_ip(v)


class SubnetResponse(SubnetBase):
    # No validator here: rows stored before validation existed must still serialize
    id: int
    is_direct_l2: bool = True
    interface_name: str | None = None
    is_agent_probe: bool = False
    probe_device_name: str | None = None
    probe_device_ip: str | None = None
    # The gateway used while gateway_ip is empty: the default route in this network, else `.1`
    gateway_suggestion: str | None = None
    gateway_source: str | None = None

    class Config:
        from_attributes = True


