"""Device interfaces: API, merging duplicates, gateway list, silent presence, migration."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select, text

import app.database.migrations as migrations
from app.database import Base
from app.models.agent import AgentToken
from app.models.device import Device, DeviceHistory, DeviceInterface, DiscoveredHost, Service
from app.models.network import Subnet
from app.models.ssh import SshKnownHost, SshProfile
from app.models.topology import TopologyLink
from app.scanner.gateways import (
    effective_gateway,
    gateway_prefill,
    parse_proc_net_route,
    suggest_gateway,
)
from app.scanner.presence import update_interface_presence
from app.services.cache_service import dashboard_cache

GW_MAC = "aa:bb:cc:00:00:01"
NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _no_routes_no_cache():
    dashboard_cache.invalidate_all()
    with (
        patch("app.scanner.sync.detect_default_gateways", return_value=[]),
        patch("app.services.interface_service.detect_default_gateways", return_value=[]),
    ):
        yield
    dashboard_cache.invalidate_all()


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


async def _two_vlans(db, **iot):
    lan = Subnet(cidr="192.168.100.0/24", name="LAN")
    iot = Subnet(cidr="192.168.110.0/24", name="IoT", vlan_id=110, **iot)
    db.add_all([lan, iot])
    await db.commit()
    return lan, iot


def _device(ip, name, mac=GW_MAC, **kw):
    return Device(ip=ip, mac=mac, display_name=name, is_online=True, **kw)


def _disc(ip, mac=GW_MAC, **kw):
    return DiscoveredHost(ip=ip, mac=mac, is_online=True, first_seen=NOW, last_seen=NOW, **kw)


# --- gateways ---------------------------------------------------------------

def test_proc_net_route_default_gateways():
    dump = (
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
        "eth0\t00000000\t0164A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
        "eth0\t0064A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n"
        "eth1\t00000000\t016EA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n"
    )
    assert parse_proc_net_route(dump) == ["192.168.100.1", "192.168.110.1"]


def test_gateway_sources_and_prefill():
    sub = Subnet(cidr="192.168.110.0/24", name="IoT")
    assert suggest_gateway("192.168.110.0/24") == "192.168.110.1"
    assert suggest_gateway("10.0.0.5/32") is None
    assert (effective_gateway(sub, []).ip, effective_gateway(sub, []).source) == ("192.168.110.1", "suggested")
    detected = effective_gateway(sub, ["192.168.100.1", "192.168.110.254"])
    assert (detected.ip, detected.source) == ("192.168.110.254", "detected")
    sub.gateway_ip = "192.168.110.2"
    configured = effective_gateway(sub, ["192.168.110.254"])
    assert (configured.ip, configured.source) == ("192.168.110.2", "configured")
    assert gateway_prefill("192.168.100.0/24", ["192.168.100.254"]).ip == "192.168.100.254"
    assert gateway_prefill("192.168.110.0/24", ["192.168.100.254"]).source == "suggested"


@pytest.mark.asyncio
async def test_gateway_list_links_every_vlan_to_the_same_device(client, db, admin_token):
    await _two_vlans(db, gateway_ip="192.168.110.1")
    db.add(Subnet(cidr="10.10.0.0/24", name="Guest"))
    router = _device("192.168.100.1", "Router")
    db.add(router)
    await db.commit()
    db.add(DeviceInterface(device_id=router.id, ip="192.168.110.1", is_online=False))
    db.add(_disc("10.10.0.1", mac="aa:bb:cc:00:00:99", custom_name="Guest AP"))
    await db.commit()

    res = await client.get("/api/network/gateways", headers=_auth(admin_token))

    assert res.status_code == 200
    # Untagged main network first, then by VLAN tag
    assert [r["subnet_name"] for r in res.json()] == ["Guest", "LAN", "IoT"]
    rows = {r["subnet_name"]: r for r in res.json()}
    assert rows["LAN"]["gateway_ip"] == "192.168.100.1"
    assert (rows["LAN"]["source"], rows["LAN"]["device_id"], rows["LAN"]["is_primary"]) == ("suggested", router.id, True)
    assert (rows["IoT"]["source"], rows["IoT"]["device_id"], rows["IoT"]["vlan_id"]) == ("configured", router.id, 110)
    assert rows["IoT"]["interface_id"] is not None and rows["IoT"]["is_online"] is False
    assert rows["IoT"]["device_name"] == "Router"
    assert (rows["Guest"]["device_id"], rows["Guest"]["device_name"], rows["Guest"]["is_online"]) == (None, "Guest AP", True)


# --- subnet gateway / VLAN fields ---------------------------------------------

@pytest.mark.asyncio
async def test_subnet_api_stores_gateway_and_vlan_and_prefills_the_rest(client, db, admin_token):
    res = await client.post(
        "/api/network/subnets",
        json={"cidr": "192.168.110.0/24", "name": "IoT", "gateway_ip": " 192.168.110.254 ", "vlan_id": 110},
        headers=_auth(admin_token),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["gateway_ip"], body["vlan_id"], body["gateway_suggestion"], body["gateway_source"]) == \
        ("192.168.110.254", 110, "192.168.110.1", "suggested")

    res = await client.patch(f"/api/network/subnets/{body['id']}", json={"gateway_ip": ""}, headers=_auth(admin_token))
    assert res.json()["gateway_ip"] is None

    res = await client.patch(f"/api/network/subnets/{body['id']}", json={"gateway_ip": "10.0.0.1"}, headers=_auth(admin_token))
    assert res.status_code == 422 and "not inside" in res.text
    res = await client.patch(f"/api/network/subnets/{body['id']}", json={"vlan_id": 5000}, headers=_auth(admin_token))
    assert res.status_code == 422
    res = await client.post(
        "/api/network/subnets", json={"cidr": "10.0.0.0/24", "gateway_ip": "10.0.1.1"}, headers=_auth(admin_token),
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_subnet_vlan_change_reaches_interfaces_and_device_list(client, db, admin_token):
    _, iot = await _two_vlans(db)
    router = _device("192.168.100.1", "Router")
    db.add(router)
    await db.commit()
    db.add(DeviceInterface(device_id=router.id, ip="192.168.110.1", subnet_id=iot.id))
    await db.commit()
    await client.get("/api/devices", headers=_auth(admin_token))  # fills the cache

    await client.patch(f"/api/network/subnets/{iot.id}", json={"vlan_id": 111, "name": "Smart Home"}, headers=_auth(admin_token))

    dev = (await client.get("/api/devices", headers=_auth(admin_token))).json()[0]
    assert [(i["subnet_name"], i["vlan_id"]) for i in dev["interfaces"]] == [("Smart Home", 111)]


# --- device list ------------------------------------------------------------

@pytest.mark.asyncio
async def test_device_list_carries_interfaces_and_subnet_chips(client, db, admin_token):
    _, iot = await _two_vlans(db)
    router = _device("192.168.100.1", "Router")
    db.add(router)
    await db.commit()
    db.add(DeviceInterface(device_id=router.id, ip="192.168.110.1", subnet_id=iot.id, mac=GW_MAC))
    await db.commit()

    res = await client.get("/api/devices", headers=_auth(admin_token))

    dev = res.json()[0]
    assert dev["subnet_name"] == "LAN"
    assert [(i["ip"], i["subnet_name"], i["vlan_id"]) for i in dev["interfaces"]] == [("192.168.110.1", "IoT", 110)]


@pytest.mark.asyncio
async def test_add_from_ip_of_an_interface_returns_its_device(client, db, admin_token):
    router = _device("192.168.100.1", "Router")
    db.add(router)
    await db.commit()
    db.add(DeviceInterface(device_id=router.id, ip="192.168.110.1"))
    await db.commit()

    res = await client.post("/api/devices/add-from-ip?ip=192.168.110.1", headers=_auth(admin_token))

    assert res.status_code == 200 and res.json()["id"] == router.id
    assert len((await db.execute(select(Device))).scalars().all()) == 1


# --- suggestions ------------------------------------------------------------

@pytest.mark.asyncio
async def test_suggestions_find_duplicates_by_mac_hostname_host_key_and_gateway(client, db, admin_token):
    await _two_vlans(db, gateway_ip="192.168.110.1")
    db.add(Subnet(cidr="192.168.100.0/25", name="never-matches-twice"))  # more specific subnet must win
    router = _device("192.168.100.1", "Router", hostname="router.lan")
    dup = _device("192.168.110.1", "Router IoT", hostname="router.lan")
    nas = _device("192.168.100.20", "NAS", mac="aa:bb:cc:00:00:20")
    nas_dup = _device("192.168.110.20", "NAS (IoT)", mac="aa:bb:cc:00:00:21")
    # ipvlan: containers share the host MAC inside one subnet, so that MAC links nothing
    host_mac = "aa:bb:cc:00:00:30"
    containers = [_device("192.168.100.30", "Container A", mac=host_mac), _device("192.168.100.31", "Container B", mac=host_mac)]
    db.add_all([router, dup, nas, nas_dup, *containers])
    db.add_all([_disc("192.168.120.1"), _disc("192.168.110.30", mac=host_mac)])
    for ip in ("192.168.100.20", "192.168.110.20"):
        db.add(SshKnownHost(host=ip, port=22, key_type="ssh-ed25519", fingerprint="SHA256:same", public_key="AAAA"))
    await db.commit()

    res = await client.get("/api/interfaces/suggestions", headers=_auth(admin_token))

    got = {(s["target_id"], s["candidate"]["kind"], s["candidate"]["ip"]): s["reasons"] for s in res.json()}
    assert got == {
        (router.id, "device", "192.168.110.1"): ["same_hostname", "same_mac", "subnet_gateway"],
        (router.id, "discovered", "192.168.120.1"): ["same_mac"],
        (nas.id, "device", "192.168.110.20"): ["same_host_key"],
    }


@pytest.mark.asyncio
async def test_dismissed_suggestion_stays_hidden(client, db, admin_token):
    await _two_vlans(db)
    router = _device("192.168.100.1", "Router")
    db.add_all([router, _device("192.168.110.1", "Router IoT")])
    await db.commit()

    res = await client.post(
        "/api/interfaces/suggestions/dismiss",
        json={"target_id": router.id, "kind": "device", "candidate_ip": "192.168.110.1"},
        headers=_auth(admin_token),
    )
    assert res.status_code == 204

    res = await client.get("/api/interfaces/suggestions", headers=_auth(admin_token))
    assert res.json() == []


# --- merge ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_merge_moves_everything_and_removes_only_the_duplicate(client, db, admin_token):
    _, iot = await _two_vlans(db)
    router = _device("192.168.100.1", "Router")
    dup = _device("192.168.110.1", "Router IoT")
    switch = _device("192.168.100.2", "Switch", mac="aa:bb:cc:00:00:02")
    db.add_all([router, dup, switch])
    await db.commit()
    db.add_all([
        Service(device_id=router.id, name="HTTPS", protocol="https", port=443),
        Service(device_id=dup.id, name="HTTPS", protocol="https", port=443),
        Service(device_id=dup.id, name="DNS UI", protocol="http", port=5380),
        DeviceHistory(device_id=dup.id, status="offline", message="old outage"),
        TopologyLink(source_id=dup.id, target_id=switch.id),
        TopologyLink(source_id=router.id, target_id=dup.id),
        SshProfile(name="iot", device_id=dup.id, username="root"),
        _disc("192.168.110.1", is_monitored=True),
    ])
    await db.commit()
    router_id, dup_id, switch_id = router.id, dup.id, switch.id

    res = await client.post(
        f"/api/devices/{router_id}/interfaces/merge", json={"source_device_id": dup_id}, headers=_auth(admin_token)
    )

    assert res.status_code == 201, res.text
    body = res.json()
    assert (body["ip"], body["device_id"], body["subnet_id"], body["vlan_id"], body["label"]) == \
        ("192.168.110.1", router_id, iot.id, 110, "Router IoT")
    db.expire_all()
    assert [d.id for d in (await db.execute(select(Device).order_by(Device.id))).scalars().all()] == [router_id, switch_id]
    services = (await db.execute(select(Service.device_id, Service.port))).all()
    assert sorted(services) == [(router_id, 443), (router_id, 5380)]
    links = (await db.execute(select(TopologyLink.source_id, TopologyLink.target_id))).all()
    assert links == [(router_id, switch_id)]
    assert (await db.execute(select(SshProfile.device_id))).scalar_one() == router_id
    messages = [h.message for h in (await db.execute(select(DeviceHistory).order_by(DeviceHistory.id))).scalars()]
    assert messages == ["old outage", "Merged Router IoT (192.168.110.1) as interface of Router"]
    assert all(h.device_id == router_id for h in (await db.execute(select(DeviceHistory))).scalars())


@pytest.mark.asyncio
async def test_merge_refuses_a_device_with_an_agent(client, db, admin_token):
    router = _device("192.168.100.1", "Router")
    dup = _device("192.168.110.1", "Router IoT")
    db.add_all([router, dup])
    await db.commit()
    db.add(AgentToken(device_id=dup.id, token="t" * 32))
    await db.commit()

    res = await client.post(
        f"/api/devices/{router.id}/interfaces/merge", json={"source_device_id": dup.id}, headers=_auth(admin_token)
    )

    assert res.status_code == 409
    assert len((await db.execute(select(Device))).scalars().all()) == 2


@pytest.mark.asyncio
async def test_merge_a_discovered_address_and_detach_it_again(client, db, admin_token):
    _, iot = await _two_vlans(db)
    router = _device("192.168.100.1", "Router")
    db.add_all([router, _disc("192.168.110.1")])
    await db.commit()

    res = await client.post(
        f"/api/devices/{router.id}/interfaces/merge", json={"ip": "192.168.110.1"}, headers=_auth(admin_token)
    )
    assert res.status_code == 201, res.text
    iface_id = res.json()["id"]
    assert (res.json()["mac"], res.json()["subnet_id"], res.json()["is_online"]) == (GW_MAC, iot.id, True)
    disc = (await db.execute(select(DiscoveredHost))).scalar_one()
    assert disc.is_monitored is True

    res = await client.patch(
        f"/api/devices/{router.id}/interfaces/{iface_id}", json={"label": "IoT VLAN"}, headers=_auth(admin_token)
    )
    assert res.json()["label"] == "IoT VLAN"

    res = await client.delete(f"/api/devices/{router.id}/interfaces/{iface_id}", headers=_auth(admin_token))
    assert res.status_code == 204
    db.expire_all()
    assert (await db.execute(select(DeviceInterface))).first() is None
    assert (await db.execute(select(DiscoveredHost))).scalar_one().is_monitored is False
    assert len((await db.execute(select(Device))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_adding_an_address_held_by_another_device_is_refused(client, db, admin_token):
    router = _device("192.168.100.1", "Router")
    db.add_all([router, _device("192.168.110.1", "Router IoT")])
    await db.commit()

    for ip in ("192.168.110.1", "192.168.100.1"):
        res = await client.post(f"/api/devices/{router.id}/interfaces", json={"ip": ip}, headers=_auth(admin_token))
        assert res.status_code == 409
    res = await client.post(f"/api/devices/{router.id}/interfaces", json={"ip": "not-an-ip"}, headers=_auth(admin_token))
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_interface_endpoints_need_auth(client, db):
    res = await client.get("/api/network/gateways")
    assert res.status_code in (401, 403)


# --- presence ---------------------------------------------------------------

@pytest.mark.asyncio
async def test_interface_goes_offline_silently_once_per_device(db):
    router = _device("192.168.100.1", "Router")
    db.add(router)
    await db.commit()
    db.add_all([
        DeviceInterface(device_id=router.id, ip="192.168.110.1", is_online=True),
        DeviceInterface(device_id=router.id, ip="10.0.0.1", is_online=True),
    ])
    await db.commit()

    with patch("app.services.webhook_service.trigger_webhooks", new=AsyncMock()) as hook:
        for _ in range(3):
            await update_interface_presence(db, ["192.168.110.0/24"], {"192.168.100.1"}, offline_threshold=3)
    await db.commit()

    by_ip = {i.ip: i for i in (await db.execute(select(DeviceInterface))).scalars()}
    assert by_ip["192.168.110.1"].is_online is False
    assert by_ip["10.0.0.1"].is_online is True  # not in the scanned subnets
    assert hook.await_count == 0
    assert (await db.execute(select(DeviceHistory))).first() is None

    await update_interface_presence(db, ["192.168.110.0/24"], {"192.168.110.1"})
    assert by_ip["192.168.110.1"].is_online is True and by_ip["192.168.110.1"].missed_scans == 0


# --- migration --------------------------------------------------------------

@pytest.mark.asyncio
async def test_migration_adds_gateway_columns_and_interface_table_to_an_old_db(db, monkeypatch):
    docker = MagicMock()
    docker.is_available.return_value = False
    monkeypatch.setattr("app.services.docker_service.docker_service", docker)

    await db.execute(text("DROP TABLE device_interfaces"))
    await db.execute(text("DROP TABLE subnets"))
    await db.execute(text(
        "CREATE TABLE subnets (id INTEGER PRIMARY KEY, cidr VARCHAR(50) NOT NULL UNIQUE, "
        "name VARCHAR(100) NOT NULL, dns_server VARCHAR(45), is_enabled BOOLEAN)"
    ))
    await db.execute(text("INSERT INTO subnets (cidr, name, is_enabled) VALUES ('192.168.110.0/24', 'IoT', 1)"))
    await db.commit()

    # Startup order: init_db's create_all, then run_migrations
    conn = await db.connection()
    await conn.run_sync(Base.metadata.create_all)
    await migrations.run_migrations(db)

    cols = {r[1] for r in (await db.execute(text("PRAGMA table_info(subnets)"))).all()}
    assert {"gateway_ip", "vlan_id"} <= cols
    iface_cols = {r[1] for r in (await db.execute(text("PRAGMA table_info(device_interfaces)"))).all()}
    assert {"device_id", "ip", "mac", "subnet_id", "vlan_id", "label", "is_online", "last_seen"} <= iface_cols
    sub = (await db.execute(select(Subnet))).scalar_one()
    assert (sub.name, sub.gateway_ip, sub.vlan_id) == ("IoT", None, None)
