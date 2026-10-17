"""Pydantic schemas for Webhook Subscriptions."""

import ipaddress
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

# AWS's IPv6 metadata endpoint; the IPv4 one (169.254.169.254) is link-local anyway
_METADATA_IPS = {ipaddress.ip_address("fd00:ec2::254")}


def is_blocked_webhook_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True for addresses a webhook must never reach.

    Loopback (the GravityLAN host itself), link-local (cloud metadata at
    169.254.169.254), unspecified (0.0.0.0 reaches localhost) and multicast.
    LAN addresses stay allowed: webhooks to Home Assistant, n8n etc. are the point.
    """
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip in _METADATA_IPS


def check_webhook_url(url: str) -> str:
    """Return ``url`` if it is a safe webhook target, otherwise raise ValueError.

    Only checks the URL itself; what a host name resolves to is checked again
    right before each request (webhook_service).
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Must be a valid HTTP or HTTPS URL")
    try:
        parsed.port
    except ValueError:
        raise ValueError("Invalid port in URL")

    host = parsed.hostname.rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        raise ValueError("Webhooks must not target localhost; use the host's LAN address")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Resolvers still read numeric forms such as 2130706433, 0x7f.1 or 127.1 as an
        # IPv4 address (here: loopback), so only real host names get past this point.
        last_label = host.rsplit(".", 1)[-1]
        if last_label.isdigit() or last_label.startswith("0x"):
            raise ValueError("Use a dotted IPv4 address or a host name")
        return url
    if is_blocked_webhook_ip(ip):
        raise ValueError("Webhooks must not target loopback, link-local or cloud metadata addresses")
    return url


class WebhookSubscriptionCreate(BaseModel):
    url: str = Field(..., description="Target URL for webhook POST requests")
    events: list[str] = Field(..., description="List of events to subscribe to (e.g. ['device.offline', 'scan.complete'])")

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        return check_webhook_url(v)

class WebhookSubscriptionResponse(BaseModel):
    id: int
    url: str
    events: list[str]
    is_active: bool
    created_at: datetime

    @field_validator("events", mode="before")
    @classmethod
    def parse_events(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            return [e.strip() for e in v.split(",") if e.strip()]
        return v

    class Config:
        from_attributes = True
