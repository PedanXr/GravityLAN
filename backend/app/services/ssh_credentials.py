"""Saved SSH connections as the login for agent deploy and removal (ADR-002, decision 9).

Only connections that log in with a stored key qualify, and only for the
device they belong to. The key is decrypted here, on the server, and goes
straight to paramiko; it never leaves the backend. The host must already be
trusted in the SSH terminal (``ssh_known_hosts``): the connection is pinned
to that key and refused before authentication if the server shows another
one, and an unknown host is not contacted at all.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device import Device
from app.models.ssh import SshKey, SshKnownHost, SshProfile
from app.services.secret_vault import VaultError, vault
from app.services.ssh_utils import PinnedHostKey

logger = logging.getLogger(__name__)


class StoredLoginError(Exception):
    """The saved connection cannot be used; the message is safe to show to the user."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class StoredKeyLogin:
    """Everything needed to connect with a saved key connection; the key is already decrypted."""

    host: str
    port: int
    username: str
    private_key: str
    passphrase: Optional[str]
    pinned: PinnedHostKey
    profile_name: str
    key_fingerprint: str


def _belongs_to(profile: SshProfile, device: Device) -> bool:
    if profile.device_id is not None:
        return profile.device_id == device.id
    return profile.host == device.ip


async def resolve_key_profile(db: AsyncSession, profile_id: int, device: Device) -> StoredKeyLogin:
    """Turn a saved key connection of ``device`` into a login, or raise :class:`StoredLoginError`."""
    profile = await db.get(SshProfile, profile_id)
    if profile is None:
        raise StoredLoginError("The saved connection no longer exists.", status_code=404)
    if not _belongs_to(profile, device):
        raise StoredLoginError("The saved connection belongs to another device.")
    if profile.auth_method != "key" or profile.key_id is None:
        raise StoredLoginError("Only saved connections that log in with an SSH key can be used for the agent.")
    key = await db.get(SshKey, profile.key_id)
    if key is None:
        raise StoredLoginError("The SSH key of this saved connection no longer exists.")

    host = profile.host or device.ip
    res = await db.execute(select(SshKnownHost).where(SshKnownHost.host == host, SshKnownHost.port == profile.port))
    known = res.scalar_one_or_none()
    if known is None:
        raise StoredLoginError(
            f"The host key of {host}:{profile.port} is not trusted yet. Connect once in the SSH terminal, "
            "check and confirm the key, then try again."
        )

    try:
        private_key = vault.decrypt(key.encrypted_private_key)
        passphrase = vault.decrypt_optional(key.encrypted_passphrase)
    except VaultError as exc:
        logger.error("Stored SSH key '%s' could not be decrypted: %s", key.name, exc)
        raise StoredLoginError("The stored SSH key could not be decrypted (was the vault key changed?).", 500) from exc

    key.last_used_at = datetime.now(timezone.utc)
    return StoredKeyLogin(
        host=host,
        port=profile.port,
        username=profile.username,
        private_key=private_key,
        passphrase=passphrase,
        pinned=PinnedHostKey(key_type=known.key_type, fingerprint=known.fingerprint),
        profile_name=profile.name,
        key_fingerprint=key.fingerprint,
    )


async def resolve_stored_key(
    db: AsyncSession, key_id: int, user_passphrase: str | None = None
) -> tuple[str, str | None]:
    """Retrieve and decrypt an SshKey by id.

    Returns (private_key_text, passphrase).
    """
    key = await db.get(SshKey, key_id)
    if key is None:
        raise StoredLoginError("The chosen SSH key no longer exists.", status_code=404)

    try:
        private_key = vault.decrypt(key.encrypted_private_key)
        passphrase = user_passphrase or vault.decrypt_optional(key.encrypted_passphrase)
    except VaultError as exc:
        logger.error("Stored SSH key '%s' could not be decrypted: %s", key.name, exc)
        raise StoredLoginError(
            "The stored SSH key could not be decrypted (was the vault key changed?).",
            status_code=500,
        ) from exc

    key.last_used_at = datetime.now(timezone.utc)
    return private_key, passphrase
