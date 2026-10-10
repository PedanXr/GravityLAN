"""Pydantic schemas for the SSH terminal API.

Secret-bearing request fields (private_key, passphrase, password) carry no
Pydantic constraints on purpose: a constraint violation would echo the raw
value into the 422 response and the validation log. Every field has a
default for the same reason (a missing field echoes the whole body); the
route handlers validate presence and size themselves.
"""

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

AuthMethod = Literal["key", "password", "ask"]


class SshKeyCreate(BaseModel):
    name: str = Field(default="", max_length=100)
    private_key: str = ""
    passphrase: Optional[str] = None


class SshKeyGenerate(BaseModel):
    name: str = Field(default="", max_length=100)


class SshKeyUpdate(BaseModel):
    name: str = Field(default="", max_length=100)


class SshKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    key_type: str
    fingerprint: str
    public_key: str
    has_passphrase: bool
    created_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


class SshProfileCreate(BaseModel):
    name: str = Field(default="", max_length=100)
    device_id: Optional[int] = None
    host: Optional[str] = Field(default=None, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="", max_length=100)
    auth_method: AuthMethod = "key"
    key_id: Optional[int] = None
    password: Optional[str] = None


class SshProfileUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    device_id: Optional[int] = None
    host: Optional[str] = Field(default=None, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    username: Optional[str] = Field(default=None, max_length=100)
    auth_method: Optional[AuthMethod] = None
    key_id: Optional[int] = None
    password: Optional[str] = None


class SshProfileOut(BaseModel):
    id: int
    name: str
    device_id: Optional[int]
    device_name: Optional[str]
    host: Optional[str]
    target_host: Optional[str]
    port: int
    username: str
    auth_method: str
    key_id: Optional[int]
    key_name: Optional[str]
    has_password: bool
    created_at: Optional[datetime] = None
    last_connected_at: Optional[datetime] = None


class SshKnownHostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    host: str
    port: int
    key_type: str
    fingerprint: str
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None


class SshSessionPrepare(BaseModel):
    """Either a saved profile, or an ad-hoc target (device_id or host) with user and credentials."""

    profile_id: Optional[int] = None
    device_id: Optional[int] = None
    host: Optional[str] = Field(default=None, max_length=255)
    port: int = Field(default=22, ge=1, le=65535)
    username: Optional[str] = Field(default=None, max_length=100)
    key_id: Optional[int] = None
    password: Optional[str] = None


class SshSessionTicket(BaseModel):
    ticket: str
    label: str
    expires_in: int


class SshStatus(BaseModel):
    vault_key_source: str
    active_sessions: int
    max_sessions: int
    idle_timeout_minutes: int
