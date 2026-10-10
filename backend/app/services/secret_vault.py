"""Symmetric encryption for secrets GravityLAN keeps at rest (SSH keys, passwords).

The Fernet key comes from GRAVITYLAN_VAULT_KEY when set, otherwise from
<data_dir>/ssh_vault.key, which is generated on first use with owner-only
permissions. Losing that file makes stored secrets unreadable, so it is
deliberately not part of the JSON backup (see docs/adr/002-ssh-keystore.md).
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

logger = logging.getLogger(__name__)

VAULT_KEY_FILENAME = "ssh_vault.key"


class VaultError(Exception):
    """Raised when the vault key is unusable or a stored secret cannot be decrypted."""
    pass


class SecretVault:
    """Lazily initialised Fernet wrapper; safe to share between threads."""

    def __init__(self, key_file: Optional[Path] = None, env_key: Optional[str] = None):
        self._key_file = key_file
        self._env_key = env_key
        self._fernet: Optional[Fernet] = None
        self._lock = threading.Lock()

    @property
    def key_source(self) -> str:
        """'env' when the key comes from GRAVITYLAN_VAULT_KEY, otherwise 'file'."""
        return "env" if self._configured_env_key() else "file"

    def encrypt(self, plaintext: str) -> str:
        return self._get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, token: str) -> str:
        try:
            return self._get_fernet().decrypt(token.encode("ascii")).decode("utf-8")
        except InvalidToken as exc:
            raise VaultError(
                "Stored secret cannot be decrypted. Was the vault key (ssh_vault.key / GRAVITYLAN_VAULT_KEY) replaced?"
            ) from exc

    def encrypt_optional(self, plaintext: Optional[str]) -> Optional[str]:
        return self.encrypt(plaintext) if plaintext else None

    def decrypt_optional(self, token: Optional[str]) -> Optional[str]:
        return self.decrypt(token) if token else None

    def _configured_env_key(self) -> str:
        return (self._env_key if self._env_key is not None else settings.vault_key).strip()

    def _key_path(self) -> Path:
        return self._key_file or settings.data_dir / VAULT_KEY_FILENAME

    def _get_fernet(self) -> Fernet:
        if self._fernet is None:
            with self._lock:
                if self._fernet is None:
                    try:
                        self._fernet = Fernet(self._read_or_create_key())
                    except ValueError as exc:
                        raise VaultError("The vault key is not a valid Fernet key.") from exc
        return self._fernet

    def _read_or_create_key(self) -> bytes:
        env_key = self._configured_env_key()
        if env_key:
            return env_key.encode("ascii")

        key_path = self._key_path()
        if key_path.exists():
            return key_path.read_bytes().strip()

        key = Fernet.generate_key()
        key_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # Another worker created it in the meantime.
            return key_path.read_bytes().strip()
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
        logger.info("Generated new secret vault key at %s", key_path)
        return key


vault = SecretVault()
