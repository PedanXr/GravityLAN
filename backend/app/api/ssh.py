"""SSH terminal API: key store, connection profiles, known hosts and the terminal WebSocket.

HTTP routes live on `router` (registered with the admin dependency in main.py);
the WebSocket lives on `ws_router` and authenticates itself, browser sessions only.
Opening a terminal is two steps, like the patch runner: POST /sessions/prepare
resolves and decrypts the credentials into a one-shot ticket (30 s), then the
WebSocket consumes that ticket, so no secret ever travels in a URL.

The ticket remembers whether a browser session requested it and from which
client address. Some setups (reverse proxies, browser cookie policies) deliver
the session cookie on HTTP requests but not on the WebSocket upgrade; then the
WebSocket is accepted only with a session-issued ticket from the same address,
so API and master tokens still cannot open shells (ADR 002).
"""

from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timezone
from typing import NamedTuple, Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.device import Device
from app.models.ssh import SshHistory, SshKey, SshKnownHost, SshProfile
from app.schemas.ssh import (
    SshHistoryOut,
    SshKeyCreate,
    SshKeyGenerate,
    SshKeyOut,
    SshKeyUpdate,
    SshKnownHostOut,
    SshProfileCreate,
    SshProfileOut,
    SshProfileUpdate,
    SshSessionPrepare,
    SshSessionTicket,
    SshStatus,
)
from app.services.secret_vault import VaultError, vault
from app.services.ssh_terminal import ConnectionTarget, active_session_count, run_terminal
from app.services.ppk import PpkError, is_ppk
from app.services.ssh_utils import SSHKeyPassphraseRequired, load_private_key, ppk_as_openssh

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ssh", tags=["ssh"])
ws_router = APIRouter(tags=["ssh"])

MAX_PRIVATE_KEY_LENGTH = 16384
TICKET_TTL_SECONDS = 30

class _Ticket(NamedTuple):
    created: float
    target: ConnectionTarget
    from_session: bool = False   # requested by a browser session (not an API/master token)
    client: Optional[str] = None  # client address of the requesting HTTP call


_tickets: dict[str, _Ticket] = {}


# --- helpers -----------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _key_out(key: SshKey) -> SshKeyOut:
    return SshKeyOut(
        id=key.id, name=key.name, key_type=key.key_type, fingerprint=key.fingerprint,
        public_key=key.public_key, has_passphrase=bool(key.encrypted_passphrase),
        created_at=key.created_at, last_used_at=key.last_used_at,
    )


def _device_label(device: Device) -> str:
    return device.display_name or device.hostname or device.ip


async def _load_refs(db: AsyncSession, items) -> tuple[dict[int, Device], dict[int, SshKey]]:
    """Batch-load the devices and keys a list of profiles/history entries point to (two queries)."""
    device_ids = {i.device_id for i in items if i.device_id}
    key_ids = {i.key_id for i in items if i.key_id}
    devices: dict[int, Device] = {}
    keys: dict[int, SshKey] = {}
    if device_ids:
        res = await db.execute(select(Device).where(Device.id.in_(device_ids)))
        devices = {d.id: d for d in res.scalars().all()}
    if key_ids:
        res = await db.execute(select(SshKey).where(SshKey.id.in_(key_ids)))
        keys = {k.id: k for k in res.scalars().all()}
    return devices, keys


async def _profile_out(db: AsyncSession, profile: SshProfile, refs=None) -> SshProfileOut:
    devices, keys = refs if refs is not None else await _load_refs(db, [profile])
    device = devices.get(profile.device_id) if profile.device_id else None
    key = keys.get(profile.key_id) if profile.key_id else None
    return SshProfileOut(
        id=profile.id, name=profile.name, device_id=profile.device_id,
        device_name=_device_label(device) if device else None,
        host=profile.host, target_host=profile.host or (device.ip if device else None),
        port=profile.port, username=profile.username, auth_method=profile.auth_method,
        key_id=profile.key_id, key_name=key.name if key else None,
        has_password=bool(profile.encrypted_password),
        created_at=profile.created_at, last_connected_at=profile.last_connected_at,
    )


def _public_key_line(pkey) -> str:
    return f"{pkey.get_name()} {pkey.get_base64()}"


def _encrypt(value: str) -> str:
    try:
        return vault.encrypt(value)
    except VaultError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _decrypt(value: Optional[str]) -> Optional[str]:
    try:
        return vault.decrypt_optional(value)
    except VaultError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def _validate_profile(db: AsyncSession, profile: SshProfile) -> None:
    """Raise 400 when a profile cannot work as configured."""
    if not profile.name.strip():
        raise HTTPException(status_code=400, detail="Name is required.")
    if not profile.username.strip():
        raise HTTPException(status_code=400, detail="Username is required.")
    if profile.device_id is None and not (profile.host or "").strip():
        raise HTTPException(status_code=400, detail="Choose a device or enter a host.")
    if profile.device_id is not None and await db.get(Device, profile.device_id) is None:
        raise HTTPException(status_code=400, detail="Device not found.")
    if profile.auth_method == "key":
        if profile.key_id is None or await db.get(SshKey, profile.key_id) is None:
            raise HTTPException(status_code=400, detail="Choose a stored key for key authentication.")
    elif profile.auth_method == "password" and not profile.encrypted_password:
        raise HTTPException(status_code=400, detail="Enter a password or choose 'ask every time'.")


def _purge_expired_tickets() -> None:
    now = time.monotonic()
    for token in [t for t, entry in _tickets.items() if now - entry.created > TICKET_TTL_SECONDS]:
        _tickets.pop(token, None)


def _issue_ticket(target: ConnectionTarget, from_session: bool = False, client: Optional[str] = None) -> str:
    _purge_expired_tickets()
    token = secrets.token_urlsafe(32)
    _tickets[token] = _Ticket(time.monotonic(), target, from_session, client)
    return token


def consume_ticket(
    token: Optional[str], *, require_session: bool = False, client: Optional[str] = None
) -> Optional[ConnectionTarget]:
    """Pop a ticket; returns None when it is unknown or expired (one-shot either way).

    require_session: only accept tickets a browser session requested from `client`
    (used when the WebSocket itself carries no session cookie).
    """
    if not token:
        return None
    entry = _tickets.pop(token, None)
    if entry is None:
        return None
    if time.monotonic() - entry.created > TICKET_TTL_SECONDS:
        return None
    if require_session and (not entry.from_session or entry.client != client):
        return None
    return entry.target


async def _load_key_material(db: AsyncSession, key_id: int) -> tuple[str, Optional[str]]:
    key = await db.get(SshKey, key_id)
    if key is None:
        raise HTTPException(status_code=400, detail="The selected SSH key no longer exists.")
    key.last_used_at = _now()
    return _decrypt(key.encrypted_private_key), _decrypt(key.encrypted_passphrase)


async def _target_from_profile(db: AsyncSession, profile: SshProfile, password: Optional[str]) -> ConnectionTarget:
    device = await db.get(Device, profile.device_id) if profile.device_id else None
    host = profile.host or (device.ip if device else None)
    if not host:
        raise HTTPException(status_code=400, detail="The profile has no reachable host.")
    target = ConnectionTarget(
        host=host, port=profile.port, username=profile.username,
        label=profile.name, device_id=profile.device_id, profile_id=profile.id,
    )
    if profile.auth_method == "key":
        if profile.key_id is None:
            raise HTTPException(status_code=400, detail="The profile has no SSH key assigned.")
        target.private_key, target.passphrase = await _load_key_material(db, profile.key_id)
    elif password:
        target.password = password
    elif profile.auth_method == "password" and profile.encrypted_password:
        target.password = _decrypt(profile.encrypted_password)
    else:
        raise HTTPException(status_code=400, detail="Password required.")
    profile.last_connected_at = _now()
    return target


async def _target_ad_hoc(db: AsyncSession, req: SshSessionPrepare) -> ConnectionTarget:
    device = None
    if req.device_id is not None:
        device = await db.get(Device, req.device_id)
        if device is None:
            raise HTTPException(status_code=404, detail="Device not found.")
    host = (req.host or "").strip() or (device.ip if device else "")
    if not host:
        raise HTTPException(status_code=400, detail="Choose a device or enter a host.")
    username = (req.username or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required.")
    label = f"{username}@{_device_label(device) if device else host}"
    target = ConnectionTarget(host=host, port=req.port, username=username, label=label, device_id=req.device_id)
    if req.key_id is not None:
        target.private_key, target.passphrase = await _load_key_material(db, req.key_id)
    elif req.password:
        target.password = req.password
    else:
        raise HTTPException(status_code=400, detail="Choose a key or enter a password.")
    return target


# --- status ------------------------------------------------------------------

@router.get("/status", response_model=SshStatus)
async def ssh_status():
    return SshStatus(
        vault_key_source=vault.key_source,
        active_sessions=active_session_count(),
        max_sessions=settings.ssh_max_sessions,
        idle_timeout_minutes=settings.ssh_idle_timeout_minutes,
    )


# --- keys --------------------------------------------------------------------

@router.get("/keys", response_model=list[SshKeyOut])
async def list_keys(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SshKey).order_by(SshKey.name))
    return [_key_out(k) for k in res.scalars().all()]


@router.post("/keys", response_model=SshKeyOut)
async def create_key(req: SshKeyCreate, db: AsyncSession = Depends(get_db)):
    """Store an uploaded private key (validated, then encrypted)."""
    name = req.name.strip()
    private_key = req.private_key.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if not private_key:
        raise HTTPException(status_code=400, detail="Private key is required.")
    if len(private_key) > MAX_PRIVATE_KEY_LENGTH:
        raise HTTPException(status_code=400, detail="Private key is too large.")
    passphrase = req.passphrase
    try:
        if is_ppk(private_key):
            # Store PuTTY keys as OpenSSH: one format in the vault, no passphrase needed later
            private_key, passphrase = ppk_as_openssh(private_key, passphrase).strip(), None
        pkey = load_private_key(private_key, passphrase)
    except SSHKeyPassphraseRequired:
        raise HTTPException(status_code=400, detail="This key is encrypted: enter the correct passphrase.")
    except PpkError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError:
        raise HTTPException(status_code=400, detail="Not a supported private key (OpenSSH, PEM or PuTTY .ppk: Ed25519, ECDSA or RSA).")

    key = SshKey(
        name=name, key_type=pkey.get_name(), fingerprint=pkey.fingerprint,
        public_key=_public_key_line(pkey),
        encrypted_private_key=_encrypt(private_key + "\n"),
        encrypted_passphrase=_encrypt(passphrase) if passphrase else None,
    )
    db.add(key)
    await db.commit()
    await db.refresh(key)
    logger.info("SSH key stored: '%s' (%s %s)", key.name, key.key_type, key.fingerprint)
    return _key_out(key)


@router.post("/keys/generate", response_model=SshKeyOut)
async def generate_key(req: SshKeyGenerate, db: AsyncSession = Depends(get_db)):
    """Generate a new Ed25519 key pair; only the public half is ever returned."""
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")
    private_key = ed25519.Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption(),
    ).decode("ascii")
    pkey = load_private_key(private_key)
    key = SshKey(
        name=name, key_type=pkey.get_name(), fingerprint=pkey.fingerprint,
        public_key=f"{_public_key_line(pkey)} gravitylan-{name.replace(' ', '-')}",
        encrypted_private_key=_encrypt(private_key),
    )
    db.add(key)
    await db.commit()
    await db.refresh(key)
    logger.info("SSH key generated: '%s' (%s)", key.name, key.fingerprint)
    return _key_out(key)


@router.patch("/keys/{key_id}", response_model=SshKeyOut)
async def rename_key(key_id: int, req: SshKeyUpdate, db: AsyncSession = Depends(get_db)):
    key = await db.get(SshKey, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="Key not found.")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="Name is required.")
    key.name = req.name.strip()
    await db.commit()
    return _key_out(key)


@router.delete("/keys/{key_id}")
async def delete_key(key_id: int, db: AsyncSession = Depends(get_db)):
    key = await db.get(SshKey, key_id)
    if key is None:
        raise HTTPException(status_code=404, detail="Key not found.")
    await db.delete(key)
    await db.commit()
    logger.info("SSH key deleted: '%s' (%s)", key.name, key.fingerprint)
    return {"status": "ok"}


# --- profiles ----------------------------------------------------------------

@router.get("/profiles", response_model=list[SshProfileOut])
async def list_profiles(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SshProfile).order_by(SshProfile.name))
    profiles = res.scalars().all()
    refs = await _load_refs(db, profiles)
    return [await _profile_out(db, p, refs) for p in profiles]


@router.post("/profiles", response_model=SshProfileOut)
async def create_profile(req: SshProfileCreate, db: AsyncSession = Depends(get_db)):
    profile = SshProfile(
        name=req.name.strip(), device_id=req.device_id, host=(req.host or "").strip() or None,
        port=req.port, username=req.username.strip(), auth_method=req.auth_method,
        key_id=req.key_id if req.auth_method == "key" else None,
        encrypted_password=_encrypt(req.password) if req.auth_method == "password" and req.password else None,
    )
    await _validate_profile(db, profile)
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return await _profile_out(db, profile)


@router.patch("/profiles/{profile_id}", response_model=SshProfileOut)
async def update_profile(profile_id: int, req: SshProfileUpdate, db: AsyncSession = Depends(get_db)):
    profile = await db.get(SshProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found.")

    data = req.model_dump(exclude_unset=True)
    password = data.pop("password", None)
    for field in ("name", "username"):
        if data.get(field) is not None:
            setattr(profile, field, data[field].strip())
    if "host" in data:
        profile.host = (data["host"] or "").strip() or None
    for field in ("device_id", "key_id"):
        if field in data:
            setattr(profile, field, data[field])
    if data.get("port") is not None:
        profile.port = data["port"]
    if data.get("auth_method") is not None:
        profile.auth_method = data["auth_method"]

    if password:
        profile.encrypted_password = _encrypt(password)
    if profile.auth_method != "password":
        profile.encrypted_password = None
    if profile.auth_method != "key":
        profile.key_id = None

    await _validate_profile(db, profile)
    await db.commit()
    return await _profile_out(db, profile)


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: int, db: AsyncSession = Depends(get_db)):
    profile = await db.get(SshProfile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found.")
    await db.delete(profile)
    await db.commit()
    return {"status": "ok"}


# --- known hosts -------------------------------------------------------------

@router.get("/known-hosts", response_model=list[SshKnownHostOut])
async def list_known_hosts(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SshKnownHost).order_by(SshKnownHost.host, SshKnownHost.port))
    return res.scalars().all()


@router.delete("/known-hosts/{entry_id}")
async def delete_known_host(entry_id: int, db: AsyncSession = Depends(get_db)):
    entry = await db.get(SshKnownHost, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")
    await db.delete(entry)
    await db.commit()
    logger.info("SSH known host removed: %s:%s (%s)", entry.host, entry.port, entry.fingerprint)
    return {"status": "ok"}


# --- history -----------------------------------------------------------------

HISTORY_LIMIT = 20


async def _history_out(db: AsyncSession, entry: SshHistory, refs=None) -> SshHistoryOut:
    devices, keys = refs if refs is not None else await _load_refs(db, [entry])
    device = devices.get(entry.device_id) if entry.device_id else None
    key = keys.get(entry.key_id) if entry.key_id else None
    target_name = _device_label(device) if device else entry.host
    return SshHistoryOut(
        id=entry.id, label=f"{entry.username}@{target_name}", device_id=entry.device_id,
        device_name=_device_label(device) if device else None,
        host=entry.host, target_host=entry.host or (device.ip if device else None),
        port=entry.port, username=entry.username, auth_method=entry.auth_method,
        key_id=entry.key_id, key_name=key.name if key else None, last_used_at=entry.last_used_at,
    )


async def _record_history(db: AsyncSession, req: SshSessionPrepare, target: ConnectionTarget) -> None:
    """Remember an ad-hoc connection (one entry per target and user); no password is stored."""
    host = None if req.device_id is not None else target.host
    query = select(SshHistory).where(
        SshHistory.port == target.port, SshHistory.username == target.username,
        SshHistory.device_id == req.device_id if req.device_id is not None else SshHistory.host == host,
    )
    entry = (await db.execute(query)).scalars().first()
    if entry is None:
        entry = SshHistory(device_id=req.device_id, host=host, port=target.port, username=target.username)
        db.add(entry)
    entry.auth_method = "key" if req.key_id is not None else "password"
    entry.key_id = req.key_id
    entry.last_used_at = _now()
    await db.flush()

    stale = (await db.execute(
        select(SshHistory).order_by(SshHistory.last_used_at.desc(), SshHistory.id.desc()).offset(HISTORY_LIMIT)
    )).scalars().all()
    for old in stale:
        await db.delete(old)


@router.get("/history", response_model=list[SshHistoryOut])
async def list_history(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SshHistory).order_by(SshHistory.last_used_at.desc(), SshHistory.id.desc()))
    entries = res.scalars().all()
    refs = await _load_refs(db, entries)
    return [await _history_out(db, entry, refs) for entry in entries]


@router.delete("/history/{entry_id}")
async def delete_history(entry_id: int, db: AsyncSession = Depends(get_db)):
    entry = await db.get(SshHistory, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found.")
    await db.delete(entry)
    await db.commit()
    return {"status": "ok"}


# --- sessions ----------------------------------------------------------------

@router.post("/sessions/prepare", response_model=SshSessionTicket)
async def prepare_session(req: SshSessionPrepare, request: Request, db: AsyncSession = Depends(get_db)):
    """Resolve credentials into a one-shot ticket for the terminal WebSocket."""
    if req.profile_id is not None:
        profile = await db.get(SshProfile, req.profile_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="Profile not found.")
        target = await _target_from_profile(db, profile, req.password)
    else:
        target = await _target_ad_hoc(db, req)
        await _record_history(db, req, target)
    await db.commit()
    ticket = _issue_ticket(target, from_session=_has_valid_session(request), client=_client_host(request))
    return SshSessionTicket(ticket=ticket, label=target.label, expires_in=TICKET_TTL_SECONDS)


def _client_host(conn: Request | WebSocket) -> Optional[str]:
    return conn.client.host if conn.client else None


def _has_valid_session(conn: Request | WebSocket) -> bool:
    """True when the request carries a live browser session cookie."""
    from app.services.session_service import session_store

    cookie = conn.cookies.get("gravitylan_token")
    return bool(cookie and cookie.startswith("session_") and session_store.get_session(cookie))


@ws_router.websocket("/api/ssh/terminal")
async def ssh_terminal_websocket(websocket: WebSocket):
    """Interactive terminal. Browser sessions only: API and master tokens cannot open shells."""
    from app.api.auth import authenticate_websocket_authorized

    has_cookie = bool(websocket.cookies.get("gravitylan_token"))
    if has_cookie:
        auth_info = await authenticate_websocket_authorized(websocket, endpoint_type="ssh", allowed_levels=("session",))
        if not auth_info:
            return
    else:
        # Cookie missing on the upgrade only (proxy/browser policy): the ticket must come
        # from a browser session at the same address, checked when it is consumed below
        logger.info(
            "SSH terminal: no session cookie on the WebSocket (Cookie header %s, origin %s); "
            "accepting a session-issued ticket only",
            "present" if "cookie" in websocket.headers else "absent",
            websocket.headers.get("origin", "-"),
        )
    await websocket.accept()

    target = consume_ticket(
        websocket.query_params.get("ticket"), require_session=not has_cookie, client=_client_host(websocket),
    )
    if target is None:
        await websocket.send_json({"type": "error", "message": "Invalid or expired session ticket. Please connect again."})
        await websocket.close(code=4001, reason="Invalid ticket")
        return

    try:
        cols = int(websocket.query_params.get("cols", 80))
        rows = int(websocket.query_params.get("rows", 24))
    except ValueError:
        cols, rows = 80, 24
    await run_terminal(websocket, target, cols, rows)
