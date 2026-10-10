"""Interactive SSH terminal sessions bridged to a browser WebSocket.

Flow per session (driven by run_terminal):
1. TCP + SSH handshake via paramiko.Transport, so the server host key is
   known *before* any credential is sent.
2. Host key check against ssh_known_hosts (trust on first use): unknown keys
   are shown to the user for confirmation, changed keys block the connection.
3. Authentication (key or password, keyboard-interactive as password fallback).
4. PTY shell; a reader thread pushes output into the event loop, input and
   resize events come back over the same WebSocket.

WebSocket protocol: terminal data travels as binary frames in both
directions, control messages as JSON text frames:
  client -> server: {"type": "resize", "cols", "rows"}, {"type": "hostkey_accept"}, {"type": "hostkey_reject"}
  server -> client: {"type": "status", "stage"}, {"type": "hostkey", ...}, {"type": "error", "message"},
                    {"type": "closed", "reason"}
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional, Protocol

import paramiko
from fastapi import WebSocket, WebSocketDisconnect

from app.config import settings
from app.services.ssh_utils import SSHKeyPassphraseRequired, load_private_key

logger = logging.getLogger(__name__)

READ_CHUNK = 32768
CONNECT_TIMEOUT = 10
HANDSHAKE_TIMEOUT = 15
HOSTKEY_PROMPT_TIMEOUT = 120
MIN_SIZE, MAX_COLS, MAX_ROWS = 2, 500, 200


class TerminalError(Exception):
    """A connection problem whose message is safe to show to the user."""
    pass


@dataclass
class ConnectionTarget:
    """Everything needed to open one session; secrets are already decrypted."""

    host: str
    port: int
    username: str
    label: str
    private_key: Optional[str] = None
    passphrase: Optional[str] = None
    password: Optional[str] = None
    device_id: Optional[int] = None
    profile_id: Optional[int] = None


@dataclass(frozen=True)
class HostKeyInfo:
    key_type: str
    fingerprint: str
    public_key: str


def clamp_size(cols: int, rows: int) -> tuple[int, int]:
    """Keep terminal dimensions in a sane range."""
    return max(MIN_SIZE, min(int(cols), MAX_COLS)), max(MIN_SIZE, min(int(rows), MAX_ROWS))


def _open_socket(host: str, port: int) -> socket.socket:
    """Open the TCP connection, with the Docker bridge-gateway fallback used elsewhere for SSH."""
    try:
        return socket.create_connection((host, port), timeout=CONNECT_TIMEOUT)
    except OSError as exc:
        first_error = exc

    from app.services.docker_service import docker_service
    gateway = docker_service.get_bridge_gateway()
    if gateway and gateway != host:
        logger.info("SSH terminal: direct connection to %s failed, trying bridge gateway %s", host, gateway)
        try:
            return socket.create_connection((gateway, port), timeout=CONNECT_TIMEOUT)
        except OSError:
            pass
    raise TerminalError(f"Cannot reach {host}:{port} ({first_error.strerror or first_error})")


class TerminalSession:
    """One SSH shell. Every method blocks and is meant to run in a worker thread."""

    def __init__(self, target: ConnectionTarget):
        self.target = target
        self._transport: Optional[paramiko.Transport] = None
        self._channel: Optional[paramiko.Channel] = None

    def connect(self) -> HostKeyInfo:
        sock = _open_socket(self.target.host, self.target.port)
        transport = paramiko.Transport(sock)
        try:
            transport.start_client(timeout=HANDSHAKE_TIMEOUT)
        except (paramiko.SSHException, EOFError, OSError) as exc:
            transport.close()
            raise TerminalError(f"SSH handshake failed: {exc}") from exc
        self._transport = transport
        key = transport.get_remote_server_key()
        return HostKeyInfo(key.get_name(), key.fingerprint, f"{key.get_name()} {key.get_base64()}")

    def authenticate(self) -> None:
        transport = self._require_transport()
        target = self.target
        try:
            if target.private_key:
                pkey = load_private_key(target.private_key, target.passphrase)
                transport.auth_publickey(target.username, pkey)
            elif target.password is not None:
                transport.auth_password(target.username, target.password, fallback=True)
            else:
                raise TerminalError("No key or password configured for this connection.")
        except SSHKeyPassphraseRequired as exc:
            raise TerminalError("The stored key needs a passphrase (missing or wrong).") from exc
        except ValueError as exc:
            raise TerminalError(f"The private key could not be loaded: {exc}") from exc
        except paramiko.BadAuthenticationType as exc:
            raise TerminalError(f"Server does not accept this login method (allowed: {', '.join(exc.allowed_types)}).") from exc
        except paramiko.AuthenticationException as exc:
            raise TerminalError(f"Authentication failed for user '{target.username}'.") from exc
        except paramiko.SSHException as exc:
            raise TerminalError(f"SSH error during login: {exc}") from exc

        if not transport.is_authenticated():
            raise TerminalError("The server requires additional authentication steps (e.g. 2FA), which are not supported yet.")
        transport.set_keepalive(30)

    def open_shell(self, cols: int, rows: int) -> None:
        transport = self._require_transport()
        try:
            channel = transport.open_session(timeout=HANDSHAKE_TIMEOUT)
            channel.get_pty(term="xterm-256color", width=cols, height=rows)
            channel.invoke_shell()
        except paramiko.SSHException as exc:
            raise TerminalError(f"Could not start a shell: {exc}") from exc
        self._channel = channel

    def recv(self) -> bytes:
        return self._require_channel().recv(READ_CHUNK)

    def send(self, data: bytes) -> None:
        self._require_channel().sendall(data)

    def resize(self, cols: int, rows: int) -> None:
        self._require_channel().resize_pty(width=cols, height=rows)

    def close(self) -> None:
        for closable in (self._channel, self._transport):
            if closable is not None:
                try:
                    closable.close()
                except Exception:
                    pass

    def _require_transport(self) -> paramiko.Transport:
        if self._transport is None:
            raise TerminalError("Not connected.")
        return self._transport

    def _require_channel(self) -> paramiko.Channel:
        if self._channel is None:
            raise TerminalError("Shell not open.")
        return self._channel


class KnownHostStore(Protocol):
    async def check(self, host: str, port: int, info: HostKeyInfo) -> tuple[str, Optional[str]]:
        """Return ('known' | 'unknown' | 'changed', stored_fingerprint)."""
        ...

    async def remember(self, host: str, port: int, info: HostKeyInfo) -> None:
        ...


class DbKnownHostStore:
    """ssh_known_hosts-backed store (one trusted key per host:port)."""

    async def check(self, host: str, port: int, info: HostKeyInfo) -> tuple[str, Optional[str]]:
        from sqlalchemy import select
        from app.database import async_session
        from app.models.ssh import SshKnownHost

        async with async_session() as db:
            res = await db.execute(select(SshKnownHost).where(SshKnownHost.host == host, SshKnownHost.port == port))
            entry = res.scalar_one_or_none()
            if entry is None:
                return "unknown", None
            if entry.key_type == info.key_type and entry.fingerprint == info.fingerprint:
                entry.last_seen = datetime.now(timezone.utc)
                await db.commit()
                return "known", entry.fingerprint
            return "changed", entry.fingerprint

    async def remember(self, host: str, port: int, info: HostKeyInfo) -> None:
        from sqlalchemy import select
        from app.database import async_session
        from app.models.ssh import SshKnownHost

        async with async_session() as db:
            res = await db.execute(select(SshKnownHost).where(SshKnownHost.host == host, SshKnownHost.port == port))
            entry = res.scalar_one_or_none()
            if entry is None:
                db.add(SshKnownHost(
                    host=host, port=port, key_type=info.key_type,
                    fingerprint=info.fingerprint, public_key=info.public_key,
                ))
            else:
                entry.key_type, entry.fingerprint, entry.public_key = info.key_type, info.fingerprint, info.public_key
                entry.last_seen = datetime.now(timezone.utc)
            await db.commit()


_active_sessions: set[TerminalSession] = set()


def active_session_count() -> int:
    return len(_active_sessions)


async def _send_control(websocket: WebSocket, payload: dict) -> None:
    try:
        await websocket.send_text(json.dumps(payload))
    except Exception:
        pass


async def _receive_control(websocket: WebSocket, expected: set[str], size: dict) -> dict:
    """Wait for a control message of an expected type.

    Keystrokes typed meanwhile are dropped; resize events (the browser refits
    while the prompt is shown) are remembered in `size` for the shell start.
    """
    while True:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            raise WebSocketDisconnect(message.get("code", 1000))
        text = message.get("text")
        if not text:
            continue
        try:
            control = json.loads(text)
        except json.JSONDecodeError:
            continue
        if control.get("type") == "resize":
            size["cols"], size["rows"] = clamp_size(control.get("cols", 80), control.get("rows", 24))
        elif control.get("type") in expected:
            return control


async def _verify_host_key(
    websocket: WebSocket, store: KnownHostStore, target: ConnectionTarget, info: HostKeyInfo, size: dict,
) -> bool:
    status, known_fingerprint = await store.check(target.host, target.port, info)
    if status == "known":
        return True

    prompt = {"type": "hostkey", "status": status, "host": target.host, "port": target.port,
              "key_type": info.key_type, "fingerprint": info.fingerprint}
    if status == "changed":
        prompt["known_fingerprint"] = known_fingerprint
        await _send_control(websocket, prompt)
        logger.warning("SSH terminal: host key for %s:%s changed - connection blocked", target.host, target.port)
        await _send_control(websocket, {
            "type": "error",
            "message": "The host key of this server has changed. If that is expected (e.g. reinstall), "
                       "remove the old entry under 'Known hosts' and connect again.",
        })
        return False

    await _send_control(websocket, prompt)
    try:
        reply = await asyncio.wait_for(
            _receive_control(websocket, {"hostkey_accept", "hostkey_reject"}, size), timeout=HOSTKEY_PROMPT_TIMEOUT,
        )
    except asyncio.TimeoutError:
        await _send_control(websocket, {"type": "error", "message": "No answer to the host key prompt."})
        return False
    if reply.get("type") != "hostkey_accept":
        await _send_control(websocket, {"type": "closed", "reason": "hostkey_rejected"})
        return False
    await store.remember(target.host, target.port, info)
    logger.info("SSH terminal: trusted new host key %s for %s:%s", info.fingerprint, target.host, target.port)
    return True


async def _pump(websocket: WebSocket, session: TerminalSession) -> str:
    """Bridge shell output and user input until one side ends; returns the reason."""
    loop = asyncio.get_running_loop()
    output: asyncio.Queue[Optional[bytes]] = asyncio.Queue()

    def reader() -> None:
        try:
            while True:
                data = session.recv()
                if not data:
                    break
                loop.call_soon_threadsafe(output.put_nowait, data)
        except Exception:
            pass
        finally:
            loop.call_soon_threadsafe(output.put_nowait, None)

    threading.Thread(target=reader, name="ssh-terminal-reader", daemon=True).start()

    async def forward_output() -> str:
        while True:
            data = await output.get()
            if data is None:
                return "remote"
            try:
                await websocket.send_bytes(data)
            except Exception:
                return "client"

    async def forward_input() -> str:
        idle_timeout = settings.ssh_idle_timeout_minutes * 60 or None
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=idle_timeout)
            except asyncio.TimeoutError:
                return "idle"
            if message.get("type") == "websocket.disconnect":
                return "client"
            if message.get("bytes"):
                await asyncio.to_thread(session.send, message["bytes"])
            elif message.get("text"):
                try:
                    control = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue
                if control.get("type") == "resize":
                    cols, rows = clamp_size(control.get("cols", 80), control.get("rows", 24))
                    await asyncio.to_thread(session.resize, cols, rows)

    tasks = {asyncio.create_task(forward_output()), asyncio.create_task(forward_input())}
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    finished = done.pop()
    if finished.exception() is not None:
        if isinstance(finished.exception(), WebSocketDisconnect):
            return "client"
        raise finished.exception()
    return finished.result()


async def run_terminal(
    websocket: WebSocket,
    target: ConnectionTarget,
    cols: int = 80,
    rows: int = 24,
    *,
    session_factory: Callable[[ConnectionTarget], TerminalSession] = TerminalSession,
    known_hosts: Optional[KnownHostStore] = None,
) -> None:
    """Run one browser terminal session on an already accepted WebSocket."""
    if len(_active_sessions) >= settings.ssh_max_sessions:
        await _send_control(websocket, {"type": "error", "message": f"Too many open SSH sessions (max {settings.ssh_max_sessions})."})
        await websocket.close(code=1013)
        return

    known_hosts = known_hosts or DbKnownHostStore()
    cols, rows = clamp_size(cols, rows)
    size = {"cols": cols, "rows": rows}
    session = session_factory(target)
    _active_sessions.add(session)
    started_at: Optional[float] = None
    try:
        await _send_control(websocket, {"type": "status", "stage": "connecting"})
        info = await asyncio.to_thread(session.connect)
        if not await _verify_host_key(websocket, known_hosts, target, info, size):
            return
        await _send_control(websocket, {"type": "status", "stage": "authenticating"})
        await asyncio.to_thread(session.authenticate)
        await asyncio.to_thread(session.open_shell, size["cols"], size["rows"])

        started_at = time.monotonic()
        logger.info("SSH terminal opened: %s@%s:%s (%s)", target.username, target.host, target.port, target.label)
        await _send_control(websocket, {"type": "status", "stage": "connected", "fingerprint": info.fingerprint})

        reason = await _pump(websocket, session)
        if reason in ("remote", "idle"):
            await _send_control(websocket, {"type": "closed", "reason": reason})
    except TerminalError as exc:
        await _send_control(websocket, {"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("SSH terminal: unexpected error for %s:%s", target.host, target.port)
        await _send_control(websocket, {"type": "error", "message": "Unexpected server error, see the GravityLAN log."})
    finally:
        _active_sessions.discard(session)
        await asyncio.to_thread(session.close)
        if started_at is not None:
            logger.info("SSH terminal closed: %s@%s:%s after %ds", target.username, target.host, target.port,
                        int(time.monotonic() - started_at))
        try:
            await websocket.close()
        except Exception:
            pass
