"""Tests for the browser SSH terminal: secret vault, key loading, SSH API and the terminal bridge."""

import asyncio
import json
import os
import queue

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from sqlalchemy import select

import app.api.ssh as ssh_api
import app.services.ssh_terminal as ssh_terminal
from app.models.device import Device
from app.models.ssh import SshKey, SshProfile
from app.services.secret_vault import SecretVault, VaultError
from app.services.ssh_terminal import ConnectionTarget, HostKeyInfo, TerminalError
from app.services.ssh_utils import SSHKeyPassphraseRequired, load_private_key


def _ed25519_pem(passphrase: bytes | None = None) -> str:
    enc = serialization.BestAvailableEncryption(passphrase) if passphrase else serialization.NoEncryption()
    return ed25519.Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, enc
    ).decode()


def _rsa_pem() -> str:
    return rsa.generate_private_key(65537, 2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
    ).decode()


@pytest.fixture
def test_vault(tmp_path, monkeypatch):
    vault = SecretVault(key_file=tmp_path / "ssh_vault.key", env_key="")
    monkeypatch.setattr(ssh_api, "vault", vault)
    return vault


@pytest.fixture(autouse=True)
def clear_tickets():
    ssh_api._tickets.clear()
    yield
    ssh_api._tickets.clear()


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# --- secret vault --------------------------------------------------------------

def test_vault_roundtrip_creates_key_file(tmp_path):
    key_file = tmp_path / "sub" / "ssh_vault.key"
    vault = SecretVault(key_file=key_file, env_key="")
    token = vault.encrypt("geheim")
    assert token != "geheim"
    assert vault.decrypt(token) == "geheim"
    assert key_file.exists()
    if os.name != "nt":
        assert oct(key_file.stat().st_mode & 0o777) == "0o600"
    # A second instance reads the same key file
    assert SecretVault(key_file=key_file, env_key="").decrypt(token) == "geheim"


def test_vault_wrong_key_raises(tmp_path):
    token = SecretVault(key_file=tmp_path / "a.key", env_key="").encrypt("x")
    with pytest.raises(VaultError):
        SecretVault(key_file=tmp_path / "b.key", env_key="").decrypt(token)


def test_vault_env_key_takes_precedence(tmp_path):
    env_key = Fernet.generate_key().decode()
    vault = SecretVault(key_file=tmp_path / "unused.key", env_key=env_key)
    assert vault.key_source == "env"
    assert vault.decrypt(vault.encrypt("x")) == "x"
    assert not (tmp_path / "unused.key").exists()


def test_vault_invalid_env_key(tmp_path):
    with pytest.raises(VaultError):
        SecretVault(key_file=tmp_path / "k", env_key="not-a-key").encrypt("x")


# --- key loading ---------------------------------------------------------------

def test_load_private_key_supported_types():
    assert load_private_key(_ed25519_pem()).get_name() == "ssh-ed25519"
    assert load_private_key(_rsa_pem()).get_name() == "ssh-rsa"


def test_load_private_key_passphrase():
    pem = _ed25519_pem(b"pw")
    with pytest.raises(SSHKeyPassphraseRequired):
        load_private_key(pem)
    with pytest.raises(SSHKeyPassphraseRequired):
        load_private_key(pem, "wrong")
    assert load_private_key(pem, "pw").get_name() == "ssh-ed25519"


def test_load_private_key_rejects_garbage_and_incomplete_ppk():
    with pytest.raises(ValueError):
        load_private_key("not a key")
    with pytest.raises(ValueError, match="PuTTY"):
        load_private_key("PuTTY-User-Key-File-3: ssh-ed25519\n")


# --- key API -------------------------------------------------------------------

@pytest.mark.asyncio
async def test_key_upload_is_encrypted_and_never_returned(client, db, admin_token, test_vault):
    pem = _ed25519_pem()
    res = await client.post("/api/ssh/keys", json={"name": "Homelab", "private_key": pem}, headers=_auth(admin_token))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["key_type"] == "ssh-ed25519"
    assert body["fingerprint"].startswith("SHA256:")
    assert body["public_key"].startswith("ssh-ed25519 ")
    assert "PRIVATE" not in res.text

    stored = (await db.execute(select(SshKey))).scalar_one()
    assert "PRIVATE KEY" not in stored.encrypted_private_key
    assert test_vault.decrypt(stored.encrypted_private_key).strip() == pem.strip()

    listing = await client.get("/api/ssh/keys", headers=_auth(admin_token))
    assert listing.status_code == 200
    assert "PRIVATE" not in listing.text
    assert "encrypted" not in listing.text


@pytest.mark.asyncio
async def test_key_upload_validation(client, admin_token, test_vault):
    res = await client.post("/api/ssh/keys", json={"name": "x", "private_key": "garbage"}, headers=_auth(admin_token))
    assert res.status_code == 400
    assert "garbage" not in res.text

    res = await client.post("/api/ssh/keys", json={"name": "x", "private_key": _ed25519_pem(b"pw")}, headers=_auth(admin_token))
    assert res.status_code == 400
    assert "passphrase" in res.json()["detail"]

    res = await client.post(
        "/api/ssh/keys", json={"name": "x", "private_key": _ed25519_pem(b"pw"), "passphrase": "pw"}, headers=_auth(admin_token)
    )
    assert res.status_code == 200
    assert res.json()["has_passphrase"] is True

    # A missing field must not echo the request body (and with it the key) back
    secret = _ed25519_pem()
    res = await client.post("/api/ssh/keys", json={"private_key": secret}, headers=_auth(admin_token))
    assert res.status_code == 400
    assert "PRIVATE" not in res.text


@pytest.mark.asyncio
async def test_generate_key(client, admin_token, test_vault):
    res = await client.post("/api/ssh/keys/generate", json={"name": "GravityLAN"}, headers=_auth(admin_token))
    assert res.status_code == 200
    assert res.json()["public_key"].startswith("ssh-ed25519 ")
    assert "PRIVATE" not in res.text


@pytest.mark.asyncio
async def test_readonly_token_cannot_use_ssh_api(client, admin_token, test_vault):
    created = await client.post("/api/auth/tokens", json={"name": "ro"}, headers=_auth(admin_token))
    ro_token = created.json()["token"]
    assert (await client.get("/api/ssh/keys", headers=_auth(ro_token))).status_code == 403
    assert (await client.post("/api/ssh/sessions/prepare", json={"host": "10.0.0.1", "username": "root", "password": "x"},
                              headers=_auth(ro_token))).status_code == 403


@pytest.mark.asyncio
async def test_ssh_api_requires_auth(client, admin_token):
    assert (await client.get("/api/ssh/keys")).status_code == 401


# --- profiles & sessions -------------------------------------------------------

async def _make_device(db) -> Device:
    device = Device(ip="192.168.1.10", display_name="nas")
    db.add(device)
    await db.commit()
    await db.refresh(device)
    return device


@pytest.mark.asyncio
async def test_profile_crud_and_validation(client, db, admin_token, test_vault):
    device = await _make_device(db)
    key = (await client.post("/api/ssh/keys", json={"name": "k", "private_key": _ed25519_pem()}, headers=_auth(admin_token))).json()

    # key auth without key -> 400
    res = await client.post("/api/ssh/profiles", json={"name": "nas", "device_id": device.id, "username": "root"}, headers=_auth(admin_token))
    assert res.status_code == 400

    res = await client.post(
        "/api/ssh/profiles",
        json={"name": "nas", "device_id": device.id, "username": "root", "auth_method": "key", "key_id": key["id"]},
        headers=_auth(admin_token),
    )
    assert res.status_code == 200, res.text
    profile = res.json()
    assert profile["target_host"] == "192.168.1.10"
    assert profile["device_name"] == "nas"
    assert profile["key_name"] == "k"

    # switch to stored password
    res = await client.patch(f"/api/ssh/profiles/{profile['id']}", json={"auth_method": "password", "password": "pw"}, headers=_auth(admin_token))
    assert res.status_code == 200, res.text
    assert res.json()["has_password"] is True
    assert res.json()["key_id"] is None
    stored = await db.get(SshProfile, profile["id"])
    await db.refresh(stored)
    assert stored.encrypted_password and test_vault.decrypt(stored.encrypted_password) == "pw"

    # switch to ask -> stored password removed
    res = await client.patch(f"/api/ssh/profiles/{profile['id']}", json={"auth_method": "ask"}, headers=_auth(admin_token))
    assert res.json()["has_password"] is False

    assert (await client.delete(f"/api/ssh/profiles/{profile['id']}", headers=_auth(admin_token))).status_code == 200
    assert (await client.get("/api/ssh/profiles", headers=_auth(admin_token))).json() == []


@pytest.mark.asyncio
async def test_prepare_session_from_profile_issues_one_shot_ticket(client, db, admin_token, test_vault):
    device = await _make_device(db)
    pem = _ed25519_pem()
    key = (await client.post("/api/ssh/keys", json={"name": "k", "private_key": pem}, headers=_auth(admin_token))).json()
    profile = (await client.post(
        "/api/ssh/profiles",
        json={"name": "nas", "device_id": device.id, "username": "admin", "port": 2222, "auth_method": "key", "key_id": key["id"]},
        headers=_auth(admin_token),
    )).json()

    res = await client.post("/api/ssh/sessions/prepare", json={"profile_id": profile["id"]}, headers=_auth(admin_token))
    assert res.status_code == 200, res.text
    assert "PRIVATE" not in res.text
    ticket = res.json()["ticket"]

    target = ssh_api.consume_ticket(ticket)
    assert target.host == "192.168.1.10" and target.port == 2222 and target.username == "admin"
    assert target.private_key.strip() == pem.strip()
    assert ssh_api.consume_ticket(ticket) is None  # one-shot


@pytest.mark.asyncio
async def test_prepare_session_ask_profile_requires_password(client, db, admin_token, test_vault):
    device = await _make_device(db)
    profile = (await client.post(
        "/api/ssh/profiles",
        json={"name": "nas", "device_id": device.id, "username": "root", "auth_method": "ask"},
        headers=_auth(admin_token),
    )).json()
    res = await client.post("/api/ssh/sessions/prepare", json={"profile_id": profile["id"]}, headers=_auth(admin_token))
    assert res.status_code == 400
    res = await client.post("/api/ssh/sessions/prepare", json={"profile_id": profile["id"], "password": "pw"}, headers=_auth(admin_token))
    assert res.status_code == 200
    assert ssh_api.consume_ticket(res.json()["ticket"]).password == "pw"


@pytest.mark.asyncio
async def test_prepare_session_ad_hoc(client, db, admin_token, test_vault):
    device = await _make_device(db)
    res = await client.post("/api/ssh/sessions/prepare", json={"device_id": device.id, "username": "root"}, headers=_auth(admin_token))
    assert res.status_code == 400  # no credentials
    res = await client.post("/api/ssh/sessions/prepare", json={"device_id": device.id, "username": "root", "password": "pw"},
                            headers=_auth(admin_token))
    assert res.status_code == 200
    assert res.json()["label"] == "root@nas"


def test_expired_ticket_is_rejected():
    token = ssh_api._issue_ticket(ConnectionTarget(host="h", port=22, username="u", label="l", password="p"))
    created, target = ssh_api._tickets[token]
    ssh_api._tickets[token] = (created - ssh_api.TICKET_TTL_SECONDS - 1, target)
    assert ssh_api.consume_ticket(token) is None


# --- terminal bridge -----------------------------------------------------------

class FakeWebSocket:
    def __init__(self, incoming=None, query_params=None):
        self.query_params = query_params or {}
        self._incoming = list(incoming or [])
        self.texts: list[dict] = []
        self.binary: list[bytes] = []
        self.closed_with = None
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def send_text(self, text):
        self.texts.append(json.loads(text))

    async def send_json(self, data):
        self.texts.append(data)

    async def send_bytes(self, data):
        self.binary.append(data)

    async def receive(self):
        if self._incoming:
            return self._incoming.pop(0)
        await asyncio.Event().wait()  # block until cancelled

    async def close(self, code=1000, reason=None):
        if self.closed_with is None:
            self.closed_with = code

    def of_type(self, kind):
        return [m for m in self.texts if m.get("type") == kind]


def _text(payload):
    return {"type": "websocket.receive", "text": json.dumps(payload)}


class FakeSession:
    def __init__(self, target, auth_error=None):
        self.target = target
        self.auth_error = auth_error
        self.output: "queue.Queue[bytes]" = queue.Queue()
        self.output.put(b"welcome\r\n")
        self.sent: list[bytes] = []
        self.resized = []
        self.authenticated = False
        self.closed = False
        self.shell_size = None

    def connect(self):
        return HostKeyInfo("ssh-ed25519", "SHA256:new", "ssh-ed25519 AAAA")

    def authenticate(self):
        if self.auth_error:
            raise TerminalError(self.auth_error)
        self.authenticated = True

    def open_shell(self, cols, rows):
        self.shell_size = (cols, rows)

    def recv(self):
        return self.output.get(timeout=5)

    def send(self, data):
        self.sent.append(data)
        self.output.put(b"")  # the remote shell exits after the first command

    def resize(self, cols, rows):
        self.resized.append((cols, rows))

    def close(self):
        self.closed = True
        self.output.put(b"")


class FakeStore:
    def __init__(self, status="unknown", known=None):
        self.status, self.known = status, known
        self.remembered = []

    async def check(self, host, port, info):
        return self.status, self.known

    async def remember(self, host, port, info):
        self.remembered.append((host, port, info.fingerprint))


TARGET = ConnectionTarget(host="10.0.0.5", port=22, username="root", label="test", password="pw")


def _collecting_factory(sessions, **kwargs):
    def factory(target):
        session = FakeSession(target, **kwargs)
        sessions.append(session)
        return session
    return factory


@pytest.mark.asyncio
async def test_terminal_unknown_host_accepted_and_bridged():
    ws = FakeWebSocket([
        _text({"type": "hostkey_accept"}),
        _text({"type": "resize", "cols": 9999, "rows": 40}),
        {"type": "websocket.receive", "bytes": b"exit\n"},
    ])
    store = FakeStore("unknown")
    sessions = []
    await ssh_terminal.run_terminal(ws, TARGET, 120, 30, session_factory=_collecting_factory(sessions), known_hosts=store)

    session = sessions[0]
    assert ws.of_type("hostkey")[0]["status"] == "unknown"
    assert store.remembered == [("10.0.0.5", 22, "SHA256:new")]
    assert session.authenticated and session.shell_size == (120, 30)
    assert session.resized == [(ssh_terminal.MAX_COLS, 40)]
    assert session.sent == [b"exit\n"]
    assert b"welcome\r\n" in ws.binary
    assert ws.of_type("closed")[0]["reason"] == "remote"
    assert session.closed
    assert ssh_terminal.active_session_count() == 0


@pytest.mark.asyncio
async def test_terminal_resize_during_hostkey_prompt_is_not_a_rejection():
    # The browser refits (and sends resize) while the prompt overlay is shown
    ws = FakeWebSocket([
        {"type": "websocket.receive", "bytes": b"typed too early"},
        _text({"type": "resize", "cols": 50, "rows": 27}),
        _text({"type": "hostkey_accept"}),
        {"type": "websocket.receive", "bytes": b"exit\n"},
    ])
    store = FakeStore("unknown")
    sessions = []
    await ssh_terminal.run_terminal(ws, TARGET, 120, 30, session_factory=_collecting_factory(sessions), known_hosts=store)

    session = sessions[0]
    assert store.remembered, "host key must be trusted after the accept that follows the resize"
    assert session.authenticated
    assert session.shell_size == (50, 27)  # latest size from the prompt phase
    assert session.sent == [b"exit\n"]  # early keystrokes are dropped, not replayed


@pytest.mark.asyncio
async def test_terminal_changed_host_key_blocks_login():
    ws = FakeWebSocket()
    sessions = []
    await ssh_terminal.run_terminal(ws, TARGET, session_factory=_collecting_factory(sessions),
                                    known_hosts=FakeStore("changed", "SHA256:old"))
    prompt = ws.of_type("hostkey")[0]
    assert prompt["status"] == "changed" and prompt["known_fingerprint"] == "SHA256:old"
    assert ws.of_type("error")
    assert not sessions[0].authenticated
    assert sessions[0].closed


@pytest.mark.asyncio
async def test_terminal_rejected_host_key():
    ws = FakeWebSocket([_text({"type": "hostkey_reject"})])
    store = FakeStore("unknown")
    sessions = []
    await ssh_terminal.run_terminal(ws, TARGET, session_factory=_collecting_factory(sessions), known_hosts=store)
    assert ws.of_type("closed")[0]["reason"] == "hostkey_rejected"
    assert store.remembered == []
    assert not sessions[0].authenticated


@pytest.mark.asyncio
async def test_terminal_auth_error_is_reported():
    ws = FakeWebSocket()
    sessions = []
    await ssh_terminal.run_terminal(
        ws, TARGET,
        session_factory=_collecting_factory(sessions, auth_error="Authentication failed for user 'root'."),
        known_hosts=FakeStore("known", "SHA256:new"),
    )
    assert ws.of_type("error")[0]["message"] == "Authentication failed for user 'root'."
    assert not ws.of_type("hostkey")
    assert sessions[0].closed


@pytest.mark.asyncio
async def test_terminal_session_limit(monkeypatch):
    monkeypatch.setattr(ssh_terminal.settings, "ssh_max_sessions", 0)
    ws = FakeWebSocket()
    await ssh_terminal.run_terminal(ws, TARGET, session_factory=FakeSession, known_hosts=FakeStore())
    assert ws.of_type("error")
    assert ws.closed_with == 1013


@pytest.mark.asyncio
async def test_terminal_websocket_rejects_invalid_ticket(monkeypatch):
    async def auth_ok(websocket, endpoint_type, allowed_levels=(), device_id=None):
        assert allowed_levels == ("session",)
        return {"authenticated": True, "auth_type": "session", "identity": "s"}

    monkeypatch.setattr("app.api.auth.authenticate_websocket_authorized", auth_ok)
    ws = FakeWebSocket(query_params={"ticket": "nope"})
    await ssh_api.ssh_terminal_websocket(ws)
    assert ws.closed_with == 4001
    assert ws.of_type("error")


@pytest.mark.asyncio
async def test_terminal_websocket_passes_target_and_size(monkeypatch):
    async def auth_ok(websocket, endpoint_type, allowed_levels=(), device_id=None):
        return {"authenticated": True, "auth_type": "session", "identity": "s"}

    captured = {}

    async def fake_run(websocket, target, cols, rows):
        captured.update(target=target, cols=cols, rows=rows)

    monkeypatch.setattr("app.api.auth.authenticate_websocket_authorized", auth_ok)
    monkeypatch.setattr(ssh_api, "run_terminal", fake_run)
    ticket = ssh_api._issue_ticket(TARGET)
    ws = FakeWebSocket(query_params={"ticket": ticket, "cols": "100", "rows": "33"})
    await ssh_api.ssh_terminal_websocket(ws)
    assert captured == {"target": TARGET, "cols": 100, "rows": 33}
