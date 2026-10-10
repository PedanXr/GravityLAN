"""SQLAlchemy models for the browser SSH terminal: key store, connection profiles, known hosts.

Private keys, passphrases and passwords are only ever stored encrypted
(see app.services.secret_vault); the encrypted_* columns never leave the backend.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SshKey(Base):
    """A private key the admin uploaded or generated."""

    __tablename__ = "ssh_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    key_type: Mapped[str] = mapped_column(String(50), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(100), nullable=False)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_private_key: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_passphrase: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SshProfile(Base):
    """A saved connection: target (device or host), user and how to authenticate.

    auth_method is 'key' (key_id), 'password' (encrypted_password) or
    'ask' (password is typed for every connection and never stored).
    """

    __tablename__ = "ssh_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    device_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), nullable=True, index=True)
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    port: Mapped[int] = mapped_column(Integer, default=22, nullable=False)
    username: Mapped[str] = mapped_column(String(100), nullable=False)
    auth_method: Mapped[str] = mapped_column(String(20), default="key", nullable=False)
    key_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("ssh_keys.id", ondelete="SET NULL"), nullable=True)
    encrypted_password: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_connected_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SshKnownHost(Base):
    """Trust-on-first-use host key record, one per host:port."""

    __tablename__ = "ssh_known_hosts"
    __table_args__ = (UniqueConstraint("host", "port", name="uq_ssh_known_hosts_host_port"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    key_type: Mapped[str] = mapped_column(String(50), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(100), nullable=False)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    first_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
