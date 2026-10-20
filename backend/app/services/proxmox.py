"""Read-only Proxmox discovery; no guest operations or power-state changes."""
import asyncio
import ipaddress
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
from sqlalchemy import select, update

from app.models.device import Device, DiscoveredHost
from app.models.proxmox import ProxmoxIntegration
from app.scanner.hostname import is_ip_like
from app.services.cache_service import dashboard_cache, discovery_cache, topology_cache
from app.services.secret_vault import vault, VaultError

# Serialize scheduled/manual imports and config changes in this single-worker app.
sync_lock = asyncio.Lock()


class ProxmoxError(Exception):
    """A safe, credential-free error suitable for the settings UI."""


@dataclass
class Guest:
    identity: str
    name: str
    addresses: list[str]


async def imported_addresses(db) -> set[str]:
    """Keep API-imported guests visible even before a network probe succeeds."""
    connection = await db.get(ProxmoxIntegration, 1)
    if not connection or not connection.enabled:
        return set()
    return set(json.loads(connection.inventory or "{}"))


def usable_ip(value: str) -> str | None:
    try:
        addr = ipaddress.ip_interface(value).ip
    except ValueError:
        return None
    if addr.is_loopback or addr.is_link_local or addr.is_multicast or addr.is_unspecified:
        return None
    return str(addr)


class ProxmoxClient:
    def __init__(self, url: str, token_id: str, secret: str, verify_tls: bool = True):
        self.client = httpx.AsyncClient(
            base_url=url + "/api2/json/",
            headers={"Authorization": f"PVEAPIToken={token_id}={secret}"},
            verify=verify_tls, follow_redirects=False, timeout=10.0,
        )

    async def get(self, path: str):
        try:
            response = await self.client.get(path)
            if response.status_code in (401, 403):
                raise ProxmoxError("Proxmox denied access. Check the API token and its permissions.")
            if response.status_code != 200:
                raise ProxmoxError(f"Proxmox returned HTTP {response.status_code}.")
            return response.json()["data"]
        except httpx.TransportError as exc:
            raise ProxmoxError("Cannot connect to Proxmox. Check the address, network and TLS certificate.") from exc
        except (ValueError, KeyError) as exc:
            raise ProxmoxError("Proxmox returned an invalid API response.") from exc

    async def discover(self) -> tuple[list[Guest], int]:
        resources = await self.get("cluster/resources?type=vm")
        if not isinstance(resources, list):
            raise ProxmoxError("Proxmox returned an invalid guest list.")
        semaphore = asyncio.Semaphore(4)

        async def read_guest(resource):
            if not isinstance(resource, dict) or resource.get("type") not in ("qemu", "lxc") or resource.get("template"):
                return None, False
            name = str(resource.get("name") or "").strip()[:100]
            node = resource.get("node")
            vmid = resource.get("vmid")
            if not name or not node or not isinstance(vmid, int):
                return None, True
            kind = resource["type"]
            # Runtime addresses are unavailable for a stopped VM. Never reuse stale agent data.
            if kind == "qemu" and resource.get("status") != "running":
                return None, True
            prefix = f"nodes/{quote(str(node), safe='')}/{kind}/{vmid}"
            async with semaphore:
                try:
                    if kind == "qemu":
                        data = await self.get(prefix + "/agent/network-get-interfaces")
                        interfaces = data.get("result", [])
                        addresses = [a.get("ip-address", "") for i in interfaces
                                     for a in i.get("ip-addresses", [])]
                    elif resource.get("status") == "running":
                        interfaces = await self.get(prefix + "/interfaces")
                        addresses = [i.get(key, "") for i in interfaces for key in ("inet", "inet6")]
                        addresses.extend(a.get("ip-address", "") for i in interfaces
                                         for a in i.get("ip-addresses", []))
                    else:
                        # Static LXC addresses also work while the container is stopped.
                        config = await self.get(prefix + "/config")
                        addresses = [part.split("=", 1)[1] for key, value in config.items()
                                     if key.startswith("net") and key[3:].isdigit() and isinstance(value, str)
                                     for part in value.split(",") if part.startswith(("ip=", "ip6="))]
                    ips = sorted({ip for value in addresses if isinstance(value, str) and (ip := usable_ip(value))})
                    return Guest(f"{kind}/{vmid}", name, ips), not bool(ips)
                except (ProxmoxError, TypeError, AttributeError, KeyError):
                    # Missing guest agent / per-guest ACLs must not hide other guests.
                    return None, True

        try:
            results = await asyncio.wait_for(asyncio.gather(*(read_guest(r) for r in resources)), timeout=120)
        except TimeoutError as exc:
            raise ProxmoxError("Proxmox discovery timed out. Check guest agents and network access.") from exc
        return [g for g, _ in results if g], sum(int(skipped) for _, skipped in results)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.client.aclose()


async def apply_guests(db, connection: ProxmoxIntegration, guests: list[Guest]) -> dict:
    """Enrich inventory by exact IP, keeping custom labels and scanner-owned health."""
    previous = json.loads(connection.inventory or "{}")
    mapping = {}
    conflicts = set()
    for guest in guests:
        for ip in guest.addresses:
            entry = {"name": guest.name, "guest": guest.identity}
            if ip in mapping and mapping[ip] != entry:
                conflicts.add(ip)
            mapping[ip] = entry
    for ip in conflicts:
        mapping.pop(ip)

    devices = {d.ip: d for d in (await db.execute(select(Device))).scalars()}
    discovered = {d.ip: d for d in (await db.execute(select(DiscoveredHost))).scalars()}
    updated = 0
    for ip, entry in mapping.items():
        name = entry["name"]
        old_entry = previous.get(ip, {})
        old_name = old_entry.get("name") if old_entry.get("guest") == entry["guest"] else None
        device = devices.get(ip)
        if device:
            automatic_names = {device.ip, device.hostname, (device.hostname or "").split(".")[0], old_name}
            display_name = device.display_name
            if is_ip_like(device.display_name) or device.display_name in automatic_names:
                display_name = name
            # Explicit last_seen suppresses the model's onupdate timestamp: importing
            # metadata is not evidence that this address was reachable.
            await db.execute(update(Device).where(Device.id == device.id).values(
                hostname=name, display_name=display_name, last_seen=device.last_seen))
            updated += 1
        host = discovered.get(ip)
        if host is None:
            host = DiscoveredHost(ip=ip, hostname=name, is_online=False, is_monitored=device is not None)
            db.add(host)
        else:
            await db.execute(update(DiscoveredHost).where(DiscoveredHost.id == host.id).values(
                hostname=name, last_seen=host.last_seen))
        # Do not replace host.custom_name or mark a guest reachable merely because it runs.

    connection.inventory = json.dumps(mapping)
    connection.last_sync = datetime.now(timezone.utc).isoformat()
    connection.last_error = None
    await db.commit()
    dashboard_cache.invalidate_all()
    discovery_cache.invalidate()
    topology_cache.invalidate()
    return {"guests": len(guests), "addresses": len(mapping), "updated_devices": updated, "conflicts": len(conflicts)}


async def sync_proxmox(db) -> dict:
    # Caller owns sync_lock (also used while saving credentials).
    connection = await db.get(ProxmoxIntegration, 1)
    if not connection or not connection.enabled:
        raise ProxmoxError("Enable and save the Proxmox connection first.")
    try:
        secret = vault.decrypt(connection.encrypted_secret)
        async with ProxmoxClient(connection.url, connection.token_id, secret, connection.verify_tls) as client:
            guests, skipped = await client.discover()
        result = await apply_guests(db, connection, guests)
        result["skipped"] = skipped
        return result
    except (ProxmoxError, VaultError) as exc:
        # Never expose a response body, request headers or the token in errors/logs.
        message = str(exc) if isinstance(exc, ProxmoxError) else "Cannot decrypt the Proxmox token. Check the secret vault key."
        connection.last_error = message
        await db.commit()
        raise ProxmoxError(message) from exc
