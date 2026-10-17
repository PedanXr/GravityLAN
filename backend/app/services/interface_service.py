"""Device interfaces: find duplicates of multi-homed devices, merge them, list subnet gateways.

A router that is the gateway of several VLANs used to show up as one Device per VLAN.
This module finds such duplicates (same MAC across subnets, same hostname, same pinned
SSH host key, configured subnet gateways) and turns them into interfaces of one
device when the operator asks for it. Nothing here deletes data on its own.
"""

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent import AgentConfig, AgentToken, DeviceMetrics
from app.models.device import Device, DeviceHistory, DeviceInterface, DiscoveredHost, Service
from app.models.network import Subnet
from app.models.setting import Setting
from app.models.ssh import SshHistory, SshKnownHost, SshProfile
from app.models.topology import TopologyLink
from app.scanner.gateways import detect_default_gateways, effective_gateway
from app.scanner.hostname import is_ip_like
from app.scanner.sync import _mac_is_valid, load_sync_context

logger = logging.getLogger(__name__)

DISMISSED_KEY = "interfaces.dismissed_suggestions"


class InterfaceError(Exception):
    """A request the interface operations refuse; carries the HTTP status to answer with."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# --- merge suggestions -------------------------------------------------------

def _norm_hostname(name: str | None) -> str | None:
    if not name or is_ip_like(name):
        return None
    return name.strip().lower() or None


def _entity(kind: str, rec, name: str | None, ctx) -> dict:
    return {
        "kind": kind, "id": rec.id, "ip": rec.ip, "mac": rec.mac,
        "hostname": _norm_hostname(rec.hostname), "name": name,
        "is_online": bool(rec.is_online),
        "segment": ctx.segment(rec.ip),
        "gw_source": ctx.gateway_source(rec.ip),
    }


async def _host_key_index(db) -> dict[str, set[str]]:
    """Pinned SSH host key fingerprints per host (any port)."""
    index: dict[str, set[str]] = defaultdict(set)
    for host, fingerprint in (await db.execute(select(SshKnownHost.host, SshKnownHost.fingerprint))).all():
        index[host].add(fingerprint)
    return index


async def _dismissed_row(db) -> Setting | None:
    return (await db.execute(select(Setting).where(Setting.key == DISMISSED_KEY))).scalar_one_or_none()


async def _load_dismissed(db) -> set[str]:
    row = await _dismissed_row(db)
    if not row or not row.value:
        return set()
    try:
        return set(json.loads(row.value))
    except (ValueError, TypeError):
        return set()


def _dismiss_key(target_id: int, kind: str, ip: str) -> str:
    return f"{target_id}:{kind}:{ip}"


def _is_ambiguous(members: list[dict]) -> bool:
    """One signal on several records of the same subnet cannot point at a single box.

    ipvlan containers share their host's MAC, so a MAC seen twice in one subnet must not
    chain those containers to the host's address in another VLAN.
    """
    segments = [m["segment"] for m in members]
    return len(segments) != len(set(segments))


def _buckets(entities: list[dict], host_keys: dict[str, set[str]]) -> dict:
    """Group entities by every signal they carry; only members of one bucket can match."""
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for ent in entities:
        if _mac_is_valid(ent["mac"]):
            buckets[("same_mac", ent["mac"].lower())].append(ent)
        if ent["hostname"]:
            buckets[("same_hostname", ent["hostname"])].append(ent)
        for fp in host_keys.get(ent["ip"], ()):
            buckets[("same_host_key", fp)].append(ent)
        if ent["gw_source"]:
            buckets[("subnet_gateway", "")].append(ent)
    return {
        key: members for key, members in buckets.items()
        if key[0] == "subnet_gateway" or not _is_ambiguous(members)
    }


def _linked(reason: str, a: dict, b: dict) -> bool:
    if a["kind"] == "discovered" and b["kind"] == "discovered":
        return False
    if not (a["segment"] and b["segment"]) or a["segment"] == b["segment"]:
        return False
    # Two bare `.1` guesses prove nothing; one side must be an entered or detected gateway
    return not (reason == "subnet_gateway" and a["gw_source"] == b["gw_source"] == "suggested")


def _edges(buckets: dict) -> dict[tuple, set[str]]:
    """Pairs of entity keys in different subnets with the reasons that link them."""
    edges: dict[tuple, set[str]] = defaultdict(set)
    for (reason, _), members in buckets.items():
        for i, a in enumerate(members):
            for b in members[i + 1:]:
                if _linked(reason, a, b):
                    key = tuple(sorted(((a["kind"], a["id"]), (b["kind"], b["id"]))))
                    edges[key].add(reason)
    return edges


def _cluster_roots(device_keys: list[tuple], edges: dict) -> dict[tuple, tuple]:
    """Union-find over device-device edges; returns device key -> cluster root."""
    parent = {k: k for k in device_keys}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for a, b in edges:
        if a[0] == "device" and b[0] == "device":
            parent[find(a)] = find(b)
    return {k: find(k) for k in device_keys}


def _target_rank(dev: Device, agent_ids: set[int], ctx):
    """Which device of a cluster keeps its identity: agent, interfaces, gateway, oldest."""
    return (dev.id not in agent_ids, -len(dev.interfaces), not ctx.is_gateway(dev.ip), dev.id)


def _targets(roots: dict, by_id: dict, agent_ids: set[int], ctx) -> dict[tuple, Device]:
    groups: dict[tuple, list[Device]] = defaultdict(list)
    for key, root in roots.items():
        groups[root].append(by_id[key[1]])
    target_of = {}
    for group in groups.values():
        target = min(group, key=lambda d: _target_rank(d, agent_ids, ctx))
        for dev in group:
            target_of[("device", dev.id)] = target
    return target_of


def _candidate_reasons(edges: dict, target_of: dict) -> dict[tuple, tuple[Device, set[str]]]:
    """Every entity that is not its cluster's target, with its target and the linking reasons."""
    found: dict[tuple, tuple[Device, set[str]]] = {}
    for (a, b), reasons in edges.items():
        for cand, other in ((a, b), (b, a)):
            if other[0] != "device":
                continue
            target = target_of[other]
            if cand == ("device", target.id):
                continue
            prev = found.get(cand)
            if prev and prev[0] is not target:
                continue  # a discovered address linked to two clusters keeps the first
            found[cand] = (target, (prev[1] if prev else set()) | reasons)
    return found


async def find_merge_suggestions(db: AsyncSession) -> list[dict]:
    """Devices/addresses that look like further interfaces of another device."""
    ctx = await load_sync_context(db)
    devices = (await db.execute(select(Device))).scalars().all()
    by_id = {d.id: d for d in devices}
    taken = {d.ip for d in devices} | {i.ip for d in devices for i in d.interfaces}
    discovered = [
        h for h in (await db.execute(select(DiscoveredHost))).scalars().all()
        if h.ip not in taken and not h.ip_placeholder
    ]
    agent_ids = set((await db.execute(select(AgentToken.device_id))).scalars().all())
    dismissed = await _load_dismissed(db)

    entities = [_entity("device", d, d.display_name or d.hostname, ctx) for d in devices if not d.ip_placeholder]
    entities += [_entity("discovered", h, h.custom_name or h.hostname, ctx) for h in discovered]
    ent_by_key = {(e["kind"], e["id"]): e for e in entities}

    edges = _edges(_buckets(entities, await _host_key_index(db)))
    roots = _cluster_roots([k for k in ent_by_key if k[0] == "device"], edges)
    target_of = _targets(roots, by_id, agent_ids, ctx)

    suggestions = []
    for cand_key, (target, reasons) in _candidate_reasons(edges, target_of).items():
        ent = ent_by_key[cand_key]
        if _dismiss_key(target.id, ent["kind"], ent["ip"]) in dismissed:
            continue
        sub = ctx.subnet_for(ent["ip"])
        suggestions.append({
            "target_id": target.id,
            "target_name": target.display_name or target.hostname or target.ip,
            "target_ip": target.ip,
            "candidate": {
                "kind": ent["kind"], "id": ent["id"], "ip": ent["ip"], "name": ent["name"],
                "mac": ent["mac"], "subnet_id": sub.id if sub else None,
                "subnet_name": sub.name if sub else None, "is_online": ent["is_online"],
            },
            "reasons": sorted(reasons),
        })
    suggestions.sort(key=lambda s: (s["target_name"].lower(), s["candidate"]["ip"]))
    return suggestions


async def dismiss_suggestion(db: AsyncSession, target_id: int, kind: str, candidate_ip: str) -> None:
    dismissed = await _load_dismissed(db)
    dismissed.add(_dismiss_key(target_id, kind, candidate_ip))
    row = await _dismissed_row(db)
    value = json.dumps(sorted(dismissed))
    if row:
        row.value = value
    else:
        db.add(Setting(key=DISMISSED_KEY, value=value))
    await db.commit()


# --- attach / merge / detach -------------------------------------------------

async def _ensure_address_free(db, target: Device, ip: str) -> None:
    if ip == target.ip:
        raise InterfaceError(409, f"{ip} is already the primary address of this device")
    if (await db.execute(select(DeviceInterface.id).where(DeviceInterface.ip == ip))).first():
        raise InterfaceError(409, f"{ip} is already an interface of a device")
    holder = (await db.execute(select(Device).where(Device.ip == ip))).scalar_one_or_none()
    if holder:
        raise InterfaceError(
            409, f"{ip} belongs to device '{holder.display_name or holder.ip}' (id {holder.id}); merge that device instead"
        )


async def attach_address(
    db: AsyncSession, target: Device, ip: str, label: str | None = None, vlan_id: int | None = None
) -> DeviceInterface:
    """Add `ip` (a discovered or typed address) as an interface of `target` and commit."""
    await _ensure_address_free(db, target, ip)
    ctx = await load_sync_context(db)
    sub = ctx.subnet_for(ip)
    disc = (await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == ip))).scalar_one_or_none()

    iface = DeviceInterface(
        ip=ip,
        mac=disc.mac if disc else None,
        subnet_id=sub.id if sub else None,
        vlan_id=vlan_id,
        label=label,
        is_online=bool(disc.is_online) if disc else False,
        last_seen=disc.last_seen if disc else None,
    )
    target.interfaces.append(iface)
    if disc:
        disc.is_monitored = True
    db.add(DeviceHistory(device_id=target.id, status="info", message=f"Interface {ip} added"))
    await db.commit()
    await db.refresh(iface)
    return iface


async def _move_services(db, source: Device, target: Device) -> None:
    """Services the target lacks move over; duplicates go with the source."""
    have = {(s.protocol, s.port) for s in target.services}
    move_ids = [s.id for s in source.services if (s.protocol, s.port) not in have]
    if move_ids:
        await db.execute(update(Service).where(Service.id.in_(move_ids)).values(device_id=target.id))
    await db.execute(delete(Service).where(Service.device_id == source.id))


async def _move_topology_links(db, source_id: int, target_id: int) -> None:
    """Re-point the source's cables to the target; drop self-loops and duplicates."""
    links = (await db.execute(
        select(TopologyLink).where((TopologyLink.source_id == source_id) | (TopologyLink.target_id == source_id))
    )).scalars().all()
    existing = {
        (s, t) for s, t in (await db.execute(
            select(TopologyLink.source_id, TopologyLink.target_id)
            .where((TopologyLink.source_id == target_id) | (TopologyLink.target_id == target_id))
        )).all()
    }
    for link in links:
        s = target_id if link.source_id == source_id else link.source_id
        t = target_id if link.target_id == source_id else link.target_id
        if s == t or (s, t) in existing:
            await db.delete(link)
            continue
        link.source_id, link.target_id = s, t
        existing.add((s, t))
    await db.flush()


async def _repoint_references(db, source: Device, target: Device) -> None:
    """Everything the operator set up on the duplicate moves to the kept device."""
    await _move_services(db, source, target)
    await db.execute(update(DeviceHistory).where(DeviceHistory.device_id == source.id).values(device_id=target.id))
    await _move_topology_links(db, source.id, target.id)
    await db.execute(
        update(Device).where(Device.parent_id == source.id, Device.id != target.id).values(parent_id=target.id)
    )
    if target.parent_id == source.id:
        target.parent_id = None
    await db.execute(update(SshProfile).where(SshProfile.device_id == source.id).values(device_id=target.id))
    await db.execute(update(SshHistory).where(SshHistory.device_id == source.id).values(device_id=target.id))
    await db.execute(update(DeviceInterface).where(DeviceInterface.device_id == source.id).values(device_id=target.id))
    await db.execute(delete(DeviceMetrics).where(DeviceMetrics.device_id == source.id))
    await db.execute(delete(AgentConfig).where(AgentConfig.device_id == source.id))


async def merge_device_into(db: AsyncSession, target: Device, source: Device) -> DeviceInterface:
    """Turn the duplicate `source` into an interface of `target` and remove the duplicate.

    Only on the operator's request. History, cables, SSH profiles, child devices and
    services the target lacks move over to the target, so nothing the operator set up
    is lost. A source with an agent is refused: its token and metrics are per device.
    """
    if source.id == target.id:
        raise InterfaceError(400, "A device cannot be merged into itself")
    if (await db.execute(select(AgentToken.id).where(AgentToken.device_id == source.id))).first():
        raise InterfaceError(409, "The device has an agent; uninstall or move the agent before merging")
    if (await db.execute(select(DeviceInterface.id).where(DeviceInterface.ip == source.ip))).first():
        raise InterfaceError(409, f"{source.ip} is already an interface of a device")

    ctx = await load_sync_context(db)
    sub = ctx.subnet_for(source.ip)
    source_id, source_ip = source.id, source.ip
    source_name = source.display_name or source.hostname or source.ip
    target_name = target.display_name or target.hostname or target.ip
    keep_label = source.display_name and source.display_name not in (source.ip, target.display_name)

    iface = DeviceInterface(
        device_id=target.id,
        ip=source_ip,
        mac=source.mac,
        subnet_id=sub.id if sub else None,
        label=source.display_name if keep_label else None,
        is_online=bool(source.is_online),
        last_seen=source.last_seen,
        first_seen=source.first_seen or datetime.now(timezone.utc),
    )

    await _repoint_references(db, source, target)
    db.expunge(source)
    await db.execute(delete(Device).where(Device.id == source_id))
    db.add(iface)
    db.add(DeviceHistory(
        device_id=target.id, status="info",
        message=f"Merged {source_name} ({source_ip}) as interface of {target_name}",
    ))
    await db.commit()
    logger.info(f"Interfaces: merged device {source_id} ({source_ip}) into device {target.id}")
    await db.refresh(target)
    await db.refresh(iface)
    return iface


async def detach_interface(db: AsyncSession, iface: DeviceInterface) -> None:
    """Remove an interface; its address stays a discovered host (no Device is recreated)."""
    disc = (await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == iface.ip))).scalar_one_or_none()
    if disc:
        disc.is_monitored = False
    db.add(DeviceHistory(device_id=iface.device_id, status="info", message=f"Interface {iface.ip} removed"))
    await db.delete(iface)
    await db.commit()


async def annotate_primary_subnets(db: AsyncSession, devices) -> None:
    """Set the subnet of each device's primary ip as plain attributes for DeviceResponse."""
    ctx = await load_sync_context(db)
    for dev in devices:
        sub = ctx.subnet_for(dev.ip)
        dev.subnet_id = sub.id if sub else None
        dev.subnet_name = sub.name if sub else None
        dev.subnet_vlan_id = sub.vlan_id if sub else None


async def load_device(db: AsyncSession, device_id: int) -> Device | None:
    """A device with its services and interfaces loaded (a select, unlike db.get, also
    fills collections of an instance the session already holds)."""
    return (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()


async def device_for_interface_ip(db: AsyncSession, ip: str) -> Device | None:
    """The device that owns `ip` as a further interface, if any."""
    iface = (await db.execute(select(DeviceInterface).where(DeviceInterface.ip == ip))).scalar_one_or_none()
    return await load_device(db, iface.device_id) if iface else None


# --- gateway list ------------------------------------------------------------

def _gateway_holder(ip: str, devices: dict, ifaces: dict, owners: dict, discs: dict) -> dict:
    """Who answers on a gateway address: a device, a device's interface, or a bare discovered host."""
    if ip in devices:
        dev = devices[ip]
        return dict(device_id=dev.id, device_name=dev.display_name or dev.hostname or dev.ip, is_primary=True,
                    is_online=bool(dev.is_online), last_seen=dev.last_seen, mac=dev.mac)
    if ip in ifaces:
        iface = ifaces[ip]
        owner = owners.get(iface.device_id)
        return dict(device_id=iface.device_id, interface_id=iface.id,
                    device_name=(owner.display_name or owner.hostname or owner.ip) if owner else None,
                    is_online=bool(iface.is_online), last_seen=iface.last_seen, mac=iface.mac)
    if ip in discs:
        disc = discs[ip]
        return dict(is_online=bool(disc.is_online), last_seen=disc.last_seen, mac=disc.mac,
                    device_name=disc.custom_name or disc.hostname)
    return {}


async def list_gateways(db: AsyncSession) -> list[dict]:
    """The effective gateway of every configured subnet and the device answering there."""
    subnets = (await db.execute(select(Subnet))).scalars().all()
    if not subnets:
        return []
    # The untagged (main) network first, then by VLAN tag, then by name
    subnets = sorted(subnets, key=lambda s: (s.vlan_id is not None, s.vlan_id or 0, (s.name or "").lower()))
    detected = detect_default_gateways()
    gateways = {s.id: effective_gateway(s, detected) for s in subnets}
    ips = {gw.ip for gw in gateways.values() if gw}

    devices = {d.ip: d for d in (await db.execute(select(Device).where(Device.ip.in_(ips)))).scalars().all()}
    ifaces = {
        i.ip: i for i in (await db.execute(select(DeviceInterface).where(DeviceInterface.ip.in_(ips)))).scalars().all()
    }
    owner_ids = {i.device_id for i in ifaces.values()}
    owners = {
        d.id: d for d in (await db.execute(select(Device).where(Device.id.in_(owner_ids)))).scalars().all()
    } if owner_ids else {}
    discs = {
        h.ip: h for h in (await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip.in_(ips)))).scalars().all()
    }

    entries = []
    for sub in subnets:
        gw = gateways[sub.id]
        entry = {
            "subnet_id": sub.id, "subnet_name": sub.name, "cidr": sub.cidr, "vlan_id": sub.vlan_id,
            "is_enabled": bool(sub.is_enabled),
            "gateway_ip": gw.ip if gw else None, "source": gw.source if gw else None,
        }
        if gw:
            entry.update(_gateway_holder(gw.ip, devices, ifaces, owners, discs))
        entries.append(entry)
    return entries
