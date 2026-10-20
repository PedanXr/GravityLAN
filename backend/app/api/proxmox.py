"""Admin settings for the read-only Proxmox integration."""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, SecretStr, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_admin
from app.database import get_db
from app.models.proxmox import ProxmoxIntegration
from app.services.proxmox import ProxmoxError, sync_lock, sync_proxmox
from app.services.secret_vault import vault, VaultError
from app.services.cache_service import discovery_cache

router = APIRouter(prefix="/api/settings/proxmox", tags=["proxmox"], dependencies=[Depends(get_current_admin)])


class ProxmoxSettings(BaseModel):
    enabled: bool = False
    url: str = Field(default="", max_length=500)
    token_id: str = Field(default="", max_length=255)
    token_secret: SecretStr | None = None
    verify_tls: bool = True

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value:
            return ""
        try:
            parsed = urlsplit(value)
            valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                     and not parsed.password and not parsed.query and not parsed.fragment
                     and parsed.path in ("", "/api2/json") and not any(c.isspace() for c in value))
            _ = parsed.port
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("Use an HTTPS Proxmox address such as https://pve.example:8006, without credentials or a query.")
        return f"https://{parsed.netloc}"

    @field_validator("token_id")
    @classmethod
    def validate_token_id(cls, value: str) -> str:
        import re
        value = value.strip()
        if value and not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+", value):
            raise ValueError("Token ID must have the form user@realm!token-name.")
        return value


def public_settings(connection: ProxmoxIntegration | None) -> dict:
    if not connection:
        return {"enabled": False, "url": "", "token_id": "", "verify_tls": True,
                "has_token_secret": False, "last_sync": None, "last_error": None}
    return {"enabled": connection.enabled, "url": connection.url, "token_id": connection.token_id,
            "verify_tls": connection.verify_tls, "has_token_secret": bool(connection.encrypted_secret),
            "last_sync": connection.last_sync, "last_error": connection.last_error}


@router.get("")
async def get_settings(db: AsyncSession = Depends(get_db)):
    return public_settings(await db.get(ProxmoxIntegration, 1))


@router.put("")
async def save_settings(request: ProxmoxSettings, db: AsyncSession = Depends(get_db)):
    async with sync_lock:
        connection = await db.get(ProxmoxIntegration, 1)
        secret = request.token_secret.get_secret_value() if request.token_secret else ""
        if secret and (len(secret) > 4096 or any(not 33 <= ord(c) <= 126 for c in secret)):
            raise HTTPException(400, "Invalid API token secret.")
        if request.enabled and (not request.url or not request.token_id or not (secret or (connection and connection.encrypted_secret))):
            raise HTTPException(400, "An enabled connection needs an API address, token ID and token secret.")
        if connection and connection.encrypted_secret and not secret and (
            request.url != connection.url or request.token_id != connection.token_id
        ):
            raise HTTPException(400, "Enter the token secret again when changing the server or token ID.")
        if not connection:
            connection = ProxmoxIntegration(id=1)
            db.add(connection)
        if secret:
            try:
                connection.encrypted_secret = vault.encrypt(secret)
            except VaultError:
                raise HTTPException(500, "Cannot encrypt the Proxmox token. Check the secret vault key.")
        connection.enabled = request.enabled
        connection.url = request.url
        connection.token_id = request.token_id
        connection.verify_tls = request.verify_tls
        connection.last_error = None
        await db.commit()
        discovery_cache.invalidate()
        return public_settings(connection)


@router.delete("", status_code=204)
async def disconnect(db: AsyncSession = Depends(get_db)):
    async with sync_lock:
        connection = await db.get(ProxmoxIntegration, 1)
        if connection:
            await db.delete(connection)
            await db.commit()
            discovery_cache.invalidate()


@router.post("/sync")
async def synchronize(db: AsyncSession = Depends(get_db)):
    if sync_lock.locked():
        raise HTTPException(409, "A Proxmox operation is already running. Try again shortly.")
    async with sync_lock:
        try:
            return await sync_proxmox(db)
        except ProxmoxError as exc:
            raise HTTPException(502, str(exc))
