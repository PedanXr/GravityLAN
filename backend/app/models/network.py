"""SQLAlchemy ORM models for network subnets and topology."""

from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Subnet(Base):
    """A network subnet configured for scanning.

    Attributes:
        id: Primary key.
        cidr: Subnet in CIDR notation (e.g. 192.168.100.0/24).
        name: Human-readable name for the subnet.
        dns_server: Optional specific DNS server to use for this subnet.
        is_enabled: Whether this subnet should be scanned.
        gateway_ip: Optional gateway (router address) of this subnet.
        vlan_id: Optional 802.1Q VLAN tag, informational.
    """

    __tablename__ = "subnets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cidr: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    dns_server: Mapped[str | None] = mapped_column(String(45), nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    gateway_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    vlan_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
