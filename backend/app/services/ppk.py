"""Read PuTTY private key files (.ppk, format 2 and 3) and convert them to OpenSSH.

paramiko only reads OpenSSH/PEM keys, while PuTTYgen saves its own text format:

    PuTTY-User-Key-File-3: ssh-ed25519
    Encryption: none | aes256-cbc
    Comment: ...
    Public-Lines: N        (base64 public key blob follows)
    Key-Derivation: Argon2id, Argon2-Memory/-Passes/-Parallelism/-Salt   (v3, encrypted only)
    Private-Lines: N       (base64 private blob follows, AES-256-CBC if encrypted)
    Private-MAC: hex

Format 2 derives the AES key from the passphrase with SHA-1 and authenticates with
HMAC-SHA-1; format 3 uses Argon2 and HMAC-SHA-256. The MAC covers algorithm,
encryption, comment, public and (decrypted) private blob, so it doubles as the
passphrase check. The rebuilt key is cross-checked against the public blob.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import struct
from typing import Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

PPK_MARKER = "PuTTY-User-Key-File-"

_CURVES = {
    "nistp256": ec.SECP256R1,
    "nistp384": ec.SECP384R1,
    "nistp521": ec.SECP521R1,
}


class PpkError(ValueError):
    """The text is a PuTTY key that cannot be read (corrupt or unsupported)."""


class PpkPassphraseRequired(PpkError):
    """The PuTTY key is encrypted and the passphrase is missing or wrong."""


def is_ppk(text: str) -> bool:
    return text.lstrip().startswith(PPK_MARKER)


def ppk_to_openssh(text: str, passphrase: Optional[str] = None) -> str:
    """Convert a .ppk key (format 2 or 3) to an unencrypted OpenSSH private key."""
    version, algorithm, headers, public_blob, private_blob = _parse(text)
    encryption = headers.get("Encryption", "")
    comment = headers.get("Comment", "")

    if encryption == "none":
        mac_key = _mac_key_v2(b"") if version == 2 else b""
    elif encryption == "aes256-cbc":
        if not passphrase:
            raise PpkPassphraseRequired("This PuTTY key is encrypted: enter its passphrase.")
        secret = passphrase.encode("utf-8")
        if version == 2:
            cipher_key, iv, mac_key = _derive_v2(secret)
        else:
            cipher_key, iv, mac_key = _derive_v3(secret, headers)
        if len(private_blob) % 16:
            raise PpkError("PuTTY key is corrupt (private data length).")
        decryptor = Cipher(algorithms.AES(cipher_key), modes.CBC(iv)).decryptor()
        private_blob = decryptor.update(private_blob) + decryptor.finalize()
    else:
        raise PpkError(f"PuTTY key uses unsupported encryption '{encryption}'.")

    mac_data = b"".join(
        _ssh_string(part)
        for part in (algorithm.encode(), encryption.encode(), comment.encode("utf-8"), public_blob, private_blob)
    )
    digest = hashlib.sha1 if version == 2 else hashlib.sha256
    expected = hmac.new(mac_key, mac_data, digest).hexdigest()
    if not hmac.compare_digest(expected, headers.get("Private-MAC", "").lower()):
        if encryption != "none":
            raise PpkPassphraseRequired("Wrong passphrase for this PuTTY key.")
        raise PpkError("PuTTY key is corrupt (checksum mismatch).")

    key = _build_key(algorithm, public_blob, private_blob)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH,
        serialization.NoEncryption(),
    ).decode("ascii")


# --- file format --------------------------------------------------------------

def _parse(text: str) -> tuple[int, str, dict[str, str], bytes, bytes]:
    lines = [line.strip() for line in text.strip().splitlines()]
    first = lines[0] if lines else ""
    marker, _, algorithm = first.partition(":")
    version_text = marker[len(PPK_MARKER):]
    if not marker.startswith(PPK_MARKER) or version_text not in ("2", "3"):
        raise PpkError("Unsupported PuTTY key format: only PPK version 2 and 3 can be read.")

    headers: dict[str, str] = {}
    blobs: dict[str, bytes] = {}
    i = 1
    while i < len(lines):
        name, sep, value = lines[i].partition(":")
        i += 1
        if not sep:
            continue
        name, value = name.strip(), value.strip()
        if name in ("Public-Lines", "Private-Lines"):
            try:
                count = int(value)
                blobs[name] = base64.b64decode("".join(lines[i:i + count]), validate=True)
            except ValueError as exc:
                raise PpkError("PuTTY key is corrupt (base64 data).") from exc
            i += count
        else:
            headers[name] = value

    if "Public-Lines" not in blobs or "Private-Lines" not in blobs or "Private-MAC" not in headers:
        raise PpkError("PuTTY key is incomplete.")
    return int(version_text), algorithm.strip(), headers, blobs["Public-Lines"], blobs["Private-Lines"]


def _mac_key_v2(secret: bytes) -> bytes:
    return hashlib.sha1(b"putty-private-key-file-mac-key" + secret).digest()


def _derive_v2(secret: bytes) -> tuple[bytes, bytes, bytes]:
    key = hashlib.sha1(b"\0\0\0\0" + secret).digest() + hashlib.sha1(b"\0\0\0\1" + secret).digest()
    return key[:32], b"\0" * 16, _mac_key_v2(secret)


def _derive_v3(secret: bytes, headers: dict[str, str]) -> tuple[bytes, bytes, bytes]:
    try:
        from argon2.low_level import Type, hash_secret_raw
    except ImportError as exc:  # pragma: no cover - argon2-cffi ships in the image
        raise PpkError("Encrypted PPK v3 keys need argon2-cffi on the server.") from exc

    types = {"Argon2id": Type.ID, "Argon2i": Type.I, "Argon2d": Type.D}
    kdf = headers.get("Key-Derivation", "")
    if kdf not in types:
        raise PpkError(f"PuTTY key uses unsupported key derivation '{kdf}'.")
    try:
        material = hash_secret_raw(
            secret=secret,
            salt=bytes.fromhex(headers["Argon2-Salt"]),
            time_cost=int(headers["Argon2-Passes"]),
            memory_cost=int(headers["Argon2-Memory"]),
            parallelism=int(headers["Argon2-Parallelism"]),
            hash_len=80,
            type=types[kdf],
        )
    except (KeyError, ValueError) as exc:
        raise PpkError("PuTTY key is corrupt (key derivation parameters).") from exc
    return material[:32], material[32:48], material[48:80]


# --- SSH wire encoding -------------------------------------------------------

def _ssh_string(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


class _Reader:
    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    def string(self) -> bytes:
        if self._pos + 4 > len(self._data):
            raise PpkError("PuTTY key is corrupt (truncated data).")
        (length,) = struct.unpack(">I", self._data[self._pos:self._pos + 4])
        start = self._pos + 4
        if start + length > len(self._data):
            raise PpkError("PuTTY key is corrupt (truncated data).")
        self._pos = start + length
        return self._data[start:self._pos]

    def mpint(self) -> int:
        return int.from_bytes(self.string(), "big", signed=True)


def _build_key(algorithm: str, public_blob: bytes, private_blob: bytes):
    pub = _Reader(public_blob)
    priv = _Reader(private_blob)
    if pub.string().decode("ascii", "replace") != algorithm:
        raise PpkError("PuTTY key is corrupt (algorithm mismatch).")

    if algorithm == "ssh-rsa":
        e, n = pub.mpint(), pub.mpint()
        d, p, q, iqmp = priv.mpint(), priv.mpint(), priv.mpint(), priv.mpint()
        if p * q != n:
            raise PpkError("PuTTY key is corrupt (RSA parameters).")
        return rsa.RSAPrivateNumbers(
            p=p, q=q, d=d, dmp1=d % (p - 1), dmq1=d % (q - 1), iqmp=iqmp,
            public_numbers=rsa.RSAPublicNumbers(e, n),
        ).private_key()

    if algorithm == "ssh-ed25519":
        public = pub.string()
        raw = priv.string()
        # PuTTY writes the 32-byte seed as an mpint of its little-endian value
        candidates = [int.from_bytes(raw, "big").to_bytes(32, "little")] if len(raw) <= 33 else []
        if len(raw) == 32:
            candidates.append(raw)
        for seed in candidates:
            key = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
            raw_public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            if raw_public == public:
                return key
        raise PpkError("PuTTY key is corrupt (Ed25519 key does not match its public half).")

    if algorithm.startswith("ecdsa-sha2-"):
        curve_name = pub.string().decode("ascii", "replace")
        point = pub.string()
        curve = _CURVES.get(curve_name)
        if curve is None:
            raise PpkError(f"Unsupported ECDSA curve '{curve_name}'.")
        key = ec.derive_private_key(priv.mpint(), curve())
        encoded = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        if encoded != point:
            raise PpkError("PuTTY key is corrupt (ECDSA key does not match its public half).")
        return key

    raise PpkError(f"Unsupported PuTTY key type '{algorithm}' (supported: Ed25519, ECDSA, RSA).")
