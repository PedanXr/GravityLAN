"""PuTTY key (.ppk) support: conversion, key loading and the key-store import."""

import re
from pathlib import Path

import pytest
from sqlalchemy import select

import app.api.ssh as ssh_api
from app.models.ssh import SshKey
from app.services.ppk import PpkError, PpkPassphraseRequired, is_ppk, ppk_to_openssh
from app.services.secret_vault import SecretVault
from app.services.ssh_utils import SSHKeyPassphraseRequired, load_private_key

FIXTURES = Path(__file__).parent / "fixtures" / "ppk"
PASSPHRASE = "test-passphrase"
TYPES = ("ed25519", "rsa", "ecdsa")
VARIANTS = ("v2", "v3", "v2-enc", "v3-enc")


def _ppk(key_type: str, variant: str) -> str:
    return (FIXTURES / f"{key_type}-{variant}.ppk").read_text()


def _tampered(text: str) -> str:
    """Change the comment: it is covered by the MAC, so the file no longer verifies."""
    tampered = re.sub(r"^Comment: .*$", "Comment: tampered", text, count=1, flags=re.MULTILINE)
    assert tampered != text
    return tampered


def _public(key_type: str) -> str:
    """'<algorithm> <base64>' from the puttygen OpenSSH export, without the comment."""
    return " ".join((FIXTURES / f"{key_type}.pub").read_text().split()[:2])


@pytest.mark.parametrize("key_type", TYPES)
@pytest.mark.parametrize("variant", VARIANTS)
def test_ppk_loads_and_matches_puttygen_public_key(key_type, variant):
    passphrase = PASSPHRASE if variant.endswith("enc") else None

    key = load_private_key(_ppk(key_type, variant), passphrase)

    assert f"{key.get_name()} {key.get_base64()}" == _public(key_type)


@pytest.mark.parametrize("variant", ("v2-enc", "v3-enc"))
@pytest.mark.parametrize("passphrase", (None, "", "wrong"))
def test_encrypted_ppk_needs_the_right_passphrase(variant, passphrase):
    with pytest.raises(SSHKeyPassphraseRequired):
        load_private_key(_ppk("ed25519", variant), passphrase)
    with pytest.raises(PpkPassphraseRequired):
        ppk_to_openssh(_ppk("ed25519", variant), passphrase)


def test_ppk_converts_to_unencrypted_openssh():
    pem = ppk_to_openssh(_ppk("rsa", "v3-enc"), PASSPHRASE)

    assert pem.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    assert f"{load_private_key(pem).get_name()} {load_private_key(pem).get_base64()}" == _public("rsa")


def test_tampered_ppk_is_rejected():
    with pytest.raises(PpkError, match="checksum"):
        ppk_to_openssh(_tampered(_ppk("ed25519", "v3")))


@pytest.mark.parametrize("text", (
    "PuTTY-User-Key-File-1: ssh-rsa\n",
    "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n",
))
def test_unsupported_or_incomplete_ppk(text):
    assert is_ppk(text)
    with pytest.raises(PpkError):
        ppk_to_openssh(text)


def test_is_ppk_ignores_openssh_keys():
    assert not is_ppk("-----BEGIN OPENSSH PRIVATE KEY-----\n")


# --- key store import ----------------------------------------------------------

@pytest.fixture
def test_vault(tmp_path, monkeypatch):
    vault = SecretVault(key_file=tmp_path / "ssh_vault.key", env_key="")
    monkeypatch.setattr(ssh_api, "vault", vault)
    return vault


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_ppk_import_is_stored_as_openssh_without_passphrase(client, db, admin_token, test_vault):
    res = await client.post(
        "/api/ssh/keys",
        json={"name": "PuTTY", "private_key": _ppk("ed25519", "v3-enc"), "passphrase": PASSPHRASE},
        headers=_auth(admin_token),
    )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["key_type"] == "ssh-ed25519"
    assert body["public_key"].startswith(_public("ed25519"))
    assert body["has_passphrase"] is False

    stored = (await db.execute(select(SshKey))).scalar_one()
    assert stored.encrypted_passphrase is None
    plain = test_vault.decrypt(stored.encrypted_private_key)
    assert plain.startswith("-----BEGIN OPENSSH PRIVATE KEY-----")
    assert load_private_key(plain).get_base64() == _public("ed25519").split()[1]


@pytest.mark.asyncio
async def test_ppk_import_errors_are_explained(client, admin_token, test_vault):
    res = await client.post(
        "/api/ssh/keys", json={"name": "x", "private_key": _ppk("rsa", "v2-enc")}, headers=_auth(admin_token)
    )
    assert res.status_code == 400
    assert "passphrase" in res.json()["detail"]

    broken = _tampered(_ppk("rsa", "v2"))
    res = await client.post("/api/ssh/keys", json={"name": "x", "private_key": broken}, headers=_auth(admin_token))
    assert res.status_code == 400
    assert "PuTTY" in res.json()["detail"]
