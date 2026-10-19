"""SQLAlchemy ORM models for devices, groups, and services."""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    event,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, object_session, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.network import Subnet
    from app.models.topology import Rack


class DeviceGroup(Base):
    """A logical group for organizing devices (e.g. Firewalls, Server, NAS).

    Attributes:
        id: Primary key.
        name: Human-readable group name.
        icon: Optional icon identifier.
        color: Optional hex color for the group header.
        sort_order: Display order on the dashboard.
        is_default: Whether this is a system-created default group.
        devices: Related devices in this group.
    """

    __tablename__ = "device_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    icon: Mapped[str | None] = mapped_column(String(50), nullable=True)
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)

    devices: Mapped[list["Device"]] = relationship(back_populates="group", lazy="selectin")


class Device(Base):
    """A discovered network device.

    Attributes:
        id: Primary key.
        ip: IPv4 address of the device.
        mac: MAC address (if discovered via ARP).
        hostname: DNS/NetBIOS hostname.
        display_name: User-customizable name shown on dashboard.
        device_type: Classification category (firewall, server, nas, etc.).
        device_subtype: Specific product/role (Sophos, Proxmox, etc.).
        group_id: Foreign key to DeviceGroup.
        icon: Custom icon override.
        sort_order: Position within its group.
        is_pinned: Whether the device is pinned to top.
        is_hidden: Whether the device is hidden from dashboard.
        notes: Optional user notes.
        first_seen: Timestamp of initial discovery.
        last_seen: Timestamp of last successful scan.
    """

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ip: Mapped[str] = mapped_column(String(45), nullable=False, unique=True, index=True)
    mac: Mapped[str | None] = mapped_column(String(17), nullable=True, index=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    device_type: Mapped[str] = mapped_column(String(30), nullable=False, default="unknown")
    device_subtype: Mapped[str] = mapped_column(String(50), nullable=False, default="Unknown")
    vendor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    group_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("device_groups.id", ondelete="SET NULL"), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(50), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    is_hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    # Grid Layout
    x: Mapped[int | None] = mapped_column(Integer, nullable=True)
    y: Mapped[int | None] = mapped_column(Integer, nullable=True)
    w: Mapped[int | None] = mapped_column(Integer, nullable=True)
    h: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    is_online: Mapped[bool] = mapped_column(Boolean, default=True)
    # Whether going offline generates alerts, drops health score, or logs outage incidents (True for 24/7 infra, False for PC/TV)
    alert_offline: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    # Consecutive failed checks; the device only goes offline at the configured threshold
    missed_scans: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_reserved: Mapped[bool] = mapped_column(Boolean, default=False)
    has_agent: Mapped[bool] = mapped_column(Boolean, default=False)
    virtual_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    status_changed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    old_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    ip_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ip_placeholder: Mapped[bool] = mapped_column(Boolean, default=False)
    
    # Topology & Virtualization
    parent_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True)
    rack_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("racks.id", ondelete="SET NULL"), nullable=True)
    rack_unit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rack_height: Mapped[int] = mapped_column(Integer, default=1)
    topology_x: Mapped[int | None] = mapped_column(Integer, nullable=True)
    topology_y: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_ports: Mapped[int] = mapped_column(Integer, default=24)
    topology_config: Mapped[str | None] = mapped_column(Text, nullable=True) # JSON config for handles, etc.
    is_wlan: Mapped[bool] = mapped_column(Boolean, default=False)
    is_ap: Mapped[bool] = mapped_column(Boolean, default=False)
    is_host: Mapped[bool] = mapped_column(Boolean, default=False)
    
    group: Mapped[DeviceGroup | None] = relationship(back_populates="devices")
    services: Mapped[list["Service"]] = relationship(back_populates="device", lazy="selectin", cascade="all, delete-orphan")
    history: Mapped[list["DeviceHistory"]] = relationship(back_populates="device", lazy="select", cascade="all, delete-orphan")
    
    # Self-referential relationship for Host/Guest mapping
    parent: Mapped["Device"] = relationship("Device", remote_side=[id], back_populates="children")
    children: Mapped[list["Device"]] = relationship("Device", back_populates="parent")
    
    # Rack mapping
    rack: Mapped["Rack"] = relationship("Rack", back_populates="devices")

    # Further addresses of the same box in other subnets (e.g. a router's VLAN gateways)
    interfaces: Mapped[list["DeviceInterface"]] = relationship(
        back_populates="device", lazy="selectin", cascade="all, delete-orphan",
        order_by="DeviceInterface.ip",
    )


class DeviceInterface(Base):
    """An additional address of a device, typically one per subnet/VLAN.

    A router that is the gateway of several VLANs keeps one Device (its primary
    ip) and one interface per further VLAN. Scans that see an interface address
    update the interface instead of moving the device's ip. Interface presence
    is tracked silently: offline events and webhooks stay per device.
    """

    __tablename__ = "device_interfaces"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    ip: Mapped[str] = mapped_column(String(45), nullable=False, unique=True, index=True)
    mac: Mapped[str | None] = mapped_column(String(17), nullable=True, index=True)
    subnet_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("subnets.id", ondelete="SET NULL"), nullable=True)
    vlan_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_online: Mapped[bool] = mapped_column(Boolean, default=True)
    missed_scans: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    first_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    device: Mapped[Device] = relationship(back_populates="interfaces")
    subnet: Mapped["Subnet | None"] = relationship("Subnet", lazy="selectin")

    @property
    def subnet_name(self) -> str | None:
        return self.subnet.name if self.subnet else None

    @property
    def subnet_cidr(self) -> str | None:
        return self.subnet.cidr if self.subnet else None

    @property
    def effective_vlan_id(self) -> int | None:
        """The interface's own VLAN tag, else its subnet's."""
        if self.vlan_id is not None:
            return self.vlan_id
        return self.subnet.vlan_id if self.subnet else None


class Service(Base):
    """A network service exposed by a device (e.g. SSH on port 22).

    Attributes:
        id: Primary key.
        device_id: Foreign key to Device.
        name: Display name (e.g. "SSH", "Sophos Admin").
        protocol: Protocol type (ssh, rdp, http, https, smb, scp, vnc).
        port: TCP port number.
        url_template: URL pattern using {ip} and {port} placeholders.
        color: Button color as hex string.
        is_auto_detected: Whether this service was found by the scanner.
        sort_order: Display order of service buttons.
    """

    __tablename__ = "services"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    protocol: Mapped[str] = mapped_column(String(20), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    url_template: Mapped[str] = mapped_column(String(500), default="")
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    is_auto_detected: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_up: Mapped[bool] = mapped_column(Boolean, default=True)
    last_checked: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    # Written by the health probe (app.scanner.health_probe); is_up stays owned by the scanner
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    ssl_expiry_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ssl_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ignore_ssl: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")

    device: Mapped[Device] = relationship(back_populates="services")


class DeviceHistory(Base):
    """Historical record of device status changes."""

    __tablename__ = "device_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    service_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("services.id", ondelete="CASCADE"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # online, offline, up, down
    message: Mapped[str | None] = mapped_column(String(255), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    device: Mapped[Device] = relationship(back_populates="history")
    service: Mapped[Service | None] = relationship()

    __table_args__ = (
        Index("ix_device_history_device_ts", "device_id", "timestamp"),
    )


class DeviceHealthSample(Base):
    """One reachability probe of a device (app.scanner.health_probe).

    Unlike DeviceHistory, which only records state changes, there is one row per
    probe pass, so uptime and latency can be computed for any time window.
    ``is_online`` is the raw probe result; the device's own ``is_online`` keeps the
    scanner's offline hysteresis.

    Attributes:
        latency_ms: ICMP round-trip time, else the fastest TCP connect time (None when unreachable).
        probe_type: "icmp" or "tcp", how latency_ms was measured.
        ports_up / ports_total: Configured services that accepted a TCP connection.
    """

    __tablename__ = "device_health_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    is_online: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    probe_type: Mapped[str | None] = mapped_column(String(8), nullable=True)
    ports_up: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ports_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        Index("ix_device_health_samples_dev_ts", "device_id", "timestamp"),
    )


class DiscoveredHost(Base):
    """A host discovered during a network scan but not yet added to the dashboard.

    Attributes:
        id: Primary key.
        ip: IPv4 address.
        mac: MAC address.
        hostname: DNS/NetBIOS hostname.
        vendor: Device vendor (from MAC).
        first_seen: Initial discovery.
        last_seen: Last time seen online.
        is_online: Current status.
    """

    __tablename__ = "discovered_hosts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ip: Mapped[str] = mapped_column(String(45), nullable=False, unique=True, index=True)
    mac: Mapped[str | None] = mapped_column(String(17), nullable=True, index=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    custom_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    vendor: Mapped[str | None] = mapped_column(String(100), nullable=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
    is_online: Mapped[bool] = mapped_column(Boolean, default=True)
    is_monitored: Mapped[bool] = mapped_column(Boolean, default=False)
    is_reserved: Mapped[bool] = mapped_column(Boolean, default=False)
    ip_placeholder: Mapped[bool] = mapped_column(Boolean, default=False)
    ports: Mapped[str | None] = mapped_column(Text, nullable=True) # JSON list of ports


@event.listens_for(Device.is_online, "set")
def _on_device_is_online_change(target, value, oldvalue, initiator):
    """When a device recovers from offline, log an 'online' entry into history."""
    if oldvalue is False and value is True:
        target.status_changed_at = datetime.now(UTC).replace(tzinfo=None)
        session = object_session(target)
        if session is not None and getattr(target, "id", None):
            session.add(DeviceHistory(
                device_id=target.id,
                status="online",
                message=f"Device {target.display_name or target.hostname or target.ip} is back online"
            ))

