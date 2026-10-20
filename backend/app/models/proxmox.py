"""Instance-local Proxmox credentials and the last imported name mapping.

Deliberately excluded from JSON backup export/import, like SSH credentials.
"""
from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ProxmoxIntegration(Base):
    __tablename__ = "proxmox_integration"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    url: Mapped[str] = mapped_column(String(500), default="")
    token_id: Mapped[str] = mapped_column(String(255), default="")
    encrypted_secret: Mapped[str] = mapped_column(Text, default="")
    verify_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    inventory: Mapped[str] = mapped_column(Text, default="{}")
    last_sync: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(255), nullable=True)
