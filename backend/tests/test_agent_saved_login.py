"""Agent deploy/uninstall with a saved SSH connection (ADR-002, decision 9).

Only key connections of the device qualify, only from a browser session, and
only to a host whose key was confirmed in the SSH terminal; the SSH boundary
(``deploy_agent`` / ``remove_agent``) is mocked.
"""

from types import SimpleNamespace

import paramiko
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from sqlalchemy import select

import app.services.ssh_credentials as ssh_credentials
from app.models.agent import AgentToken
from app.services.agent_tokens import hash_agent_token
from app.models.device import Device
from app.models.setting import Setting
from app.models.ssh import SshKey, SshKnownHost, SshProfile
from app.services.agent_deployer import _map_ssh_error
from app.services.secret_vault import SecretVault
from app.services.session_service import session_store
from app.services.ssh_utils import HostKeyNotTrusted, PinnedHostKey, PinnedHostKeyPolicy, build_pinned_ssh_client

PEM = ed25519.Ed25519PrivateKey.generate().private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption()
).decode()
PINNED = PinnedHostKey(key_type="ssh-ed25519", fingerprint="SHA256:confirmed")


@pytest.fixture
def test_vault(tmp_path, monkeypatch):
    vault = SecretVault(key_file=tmp_path / "ssh_vault.key", env_key="")
    monkeypatch.setattr(ssh_credentials, "vault", vault)
    return vault


@pytest.fixture
def browser_session(client, admin_token):
    # admin_token also completes the initial setup
    client.cookies.set("gravitylan_token", session_store.create_session(user_agent=None))
    yield
    client.cookies.clear()


@pytest.fixture
def ssh_calls(monkeypatch):
    calls = {}

    async def fake_deploy(**kwargs):
        calls["deploy"] = kwargs
        return True, "Agent started successfully", "deployed-token"

    async def fake_remove(**kwargs):
        calls["remove"] = kwargs
        return True, "Agent removed"

    monkeypatch.setattr("app.api.agent.deploy_agent", fake_deploy)
    monkeypatch.setattr("app.api.agent.remove_agent", fake_remove)
    return calls


async def _seed(db, vault, *, auth_method="key", known=True, profile_device=None, profile_host=None):
    device = Device(ip="192.168.1.60", display_name="Pi", is_online=True)
    other = Device(ip="192.168.1.61", display_name="Other", is_online=True)
    db.add_all([device, other, Setting(key="server.url", value="http://gravity.example:9000")])
    await db.flush()
    key = SshKey(name="Homelab", key_type="ssh-ed25519", fingerprint="SHA256:userkey", public_key="ssh-ed25519 AAAA",
                 encrypted_private_key=vault.encrypt(PEM))
    db.add(key)
    await db.flush()
    profile = SshProfile(
        name="Pi admin", device_id=device.id if profile_device is None else profile_device(device, other),
        host=profile_host, port=2222, username="pi", auth_method=auth_method,
        key_id=key.id if auth_method == "key" else None,
        encrypted_password=vault.encrypt("pw") if auth_method == "password" else None,
    )
    db.add(profile)
    if known:
        db.add(SshKnownHost(host=profile_host or device.ip, port=2222, key_type=PINNED.key_type,
                            fingerprint=PINNED.fingerprint, public_key="ssh-ed25519 AAAA"))
    await db.commit()
    return device, profile, key


# --- endpoints -------------------------------------------------------------------

@pytest.mark.asyncio
async def test_deploy_with_saved_key_connection(client, db, test_vault, browser_session, ssh_calls):
    device, profile, key = await _seed(db, test_vault)

    res = await client.post(f"/api/agent/deploy/{device.id}", json={"profile_id": profile.id, "sudo_password": "sudo-pw"})

    assert res.status_code == 200, res.text
    assert res.json()["status"] == "success"
    assert "PRIVATE KEY" not in res.text
    sent = ssh_calls["deploy"]
    assert sent["host_ip"] == "192.168.1.60"
    assert (sent["ssh_user"], sent["ssh_port"]) == ("pi", 2222)
    assert sent["ssh_key"] == PEM
    assert sent["ssh_key_passphrase"] is None
    assert sent["ssh_password"] == "sudo-pw"  # only for sudo, never stored
    assert sent["pinned_host_key"] == PINNED
    token = (await db.execute(select(AgentToken).where(AgentToken.device_id == device.id))).scalar_one()
    assert token.token == hash_agent_token("deployed-token")
    await db.refresh(key)
    assert key.last_used_at is not None


@pytest.mark.asyncio
async def test_uninstall_with_saved_key_connection(client, db, test_vault, browser_session, ssh_calls):
    device, profile, _ = await _seed(db, test_vault)

    res = await client.post(f"/api/agent/uninstall/{device.id}", json={"profile_id": profile.id})

    assert res.json()["status"] == "success"
    assert ssh_calls["remove"]["pinned_host_key"] == PINNED
    assert ssh_calls["remove"]["ssh_key"] == PEM


@pytest.mark.asyncio
async def test_profile_by_host_address_of_the_device(client, db, test_vault, browser_session, ssh_calls):
    device, profile, _ = await _seed(db, test_vault, profile_device=lambda d, o: None, profile_host="192.168.1.60")

    res = await client.post(f"/api/agent/deploy/{device.id}", json={"profile_id": profile.id})

    assert res.json()["status"] == "success"
    assert ssh_calls["deploy"]["host_ip"] == "192.168.1.60"


@pytest.mark.asyncio
async def test_saved_connection_needs_a_browser_session(client, db, admin_token, test_vault, ssh_calls):
    device, profile, _ = await _seed(db, test_vault)

    res = await client.post(
        f"/api/agent/deploy/{device.id}", json={"profile_id": profile.id},
        headers={"Authorization": "Bearer test-admin-token-12345"},
    )

    assert res.status_code == 403
    assert "browser session" in res.json()["detail"]
    assert ssh_calls == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("seed, status, detail", [
    (dict(auth_method="password"), 400, "SSH key"),
    (dict(profile_device=lambda d, o: o.id), 400, "another device"),
    (dict(known=False), 400, "not trusted yet"),
])
async def test_saved_connection_rules(client, db, test_vault, browser_session, ssh_calls, seed, status, detail):
    device, profile, _ = await _seed(db, test_vault, **seed)

    res = await client.post(f"/api/agent/deploy/{device.id}", json={"profile_id": profile.id})

    assert res.status_code == status
    assert detail in res.json()["detail"]
    assert ssh_calls == {}


@pytest.mark.asyncio
async def test_unknown_saved_connection(client, db, test_vault, browser_session, ssh_calls):
    device, _, _ = await _seed(db, test_vault)
    res = await client.post(f"/api/agent/deploy/{device.id}", json={"profile_id": 999})
    assert res.status_code == 404
    assert ssh_calls == {}


@pytest.mark.asyncio
async def test_deploy_needs_a_user_or_a_saved_connection(client, db, admin_token, ssh_calls):
    device = Device(ip="192.168.1.70", display_name="X", is_online=True)
    db.add(device)
    await db.commit()

    res = await client.post(
        f"/api/agent/deploy/{device.id}", json={"ssh_password": "pw"},
        headers={"Authorization": "Bearer test-admin-token-12345"},
    )

    assert res.status_code == 400
    assert "pw" not in res.text
    assert ssh_calls == {}


# --- host key pinning --------------------------------------------------------------

def _server_key(name="ssh-ed25519", fingerprint="SHA256:confirmed"):
    return SimpleNamespace(get_name=lambda: name, fingerprint=fingerprint)


def test_pinned_policy_accepts_only_the_confirmed_key():
    policy = PinnedHostKeyPolicy(PINNED)

    policy.missing_host_key(None, "192.168.1.60", _server_key())  # no exception
    policy.missing_host_key(None, "172.17.0.1", _server_key())  # bridge-gateway fallback, same machine

    with pytest.raises(HostKeyNotTrusted):
        policy.missing_host_key(None, "192.168.1.60", _server_key(fingerprint="SHA256:attacker"))
    with pytest.raises(HostKeyNotTrusted):
        policy.missing_host_key(None, "192.168.1.60", _server_key(name="ssh-rsa"))


def test_pinned_client_trusts_no_other_host_keys():
    client = build_pinned_ssh_client(PINNED)
    assert isinstance(client._policy, PinnedHostKeyPolicy)
    assert len(client.get_host_keys()) == 0 and len(client._system_host_keys) == 0


def test_ssh_error_messages():
    ok, msg = _map_ssh_error(HostKeyNotTrusted("x"), "192.168.1.60")
    assert not ok and "different host key" in msg and "Known hosts" in msg
    # AuthenticationException is an SSHException as well; it must not read as "host unreachable"
    ok, msg = _map_ssh_error(paramiko.AuthenticationException("denied"), "192.168.1.60")
    assert not ok and "authentication failed" in msg


@pytest.mark.asyncio
async def test_deploy_with_stored_key(client, db, test_vault, browser_session, ssh_calls):
    device = Device(ip="192.168.1.75", display_name="Test Box")
    db.add(device)
    await db.commit()

    key = SshKey(
        name="Vault Key",
        key_type="ssh-ed25519",
        fingerprint="SHA256:storedkey",
        public_key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5...",
        encrypted_private_key=test_vault.encrypt(PEM),
    )
    db.add(key)
    await db.commit()

    res = await client.post(
        f"/api/agent/deploy/{device.id}",
        json={"ssh_user": "root", "key_id": key.id, "ssh_port": 22},
    )
    assert res.status_code == 200
    assert ssh_calls["deploy"]["ssh_key"] == PEM
    assert ssh_calls["deploy"]["ssh_user"] == "root"
    assert ssh_calls["deploy"]["host_ip"] == "192.168.1.75"

