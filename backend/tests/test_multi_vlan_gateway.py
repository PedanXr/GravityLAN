"""A router that is the gateway of several VLANs answers with one MAC in every subnet."""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.models.device import Device, DeviceHistory, DeviceInterface, DiscoveredHost
from app.models.network import Subnet
from app.scanner.sync import sync_hosts_batch

GW_MAC = "aa:bb:cc:00:00:01"


class DBSessionContextMock:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


@pytest.fixture(autouse=True)
def _offline_lookups():
    """No vendor API calls and no real routing table in these tests."""
    with (
        patch("app.scanner.sync.get_vendor", return_value=None),
        patch("app.scanner.sync.detect_default_gateways", return_value=[]),
    ):
        yield


async def _scan(db, hosts):
    with patch("app.scanner.sync.async_session", return_value=DBSessionContextMock(db)):
        await sync_hosts_batch(hosts)


async def _two_vlans(db, iot_gateway=None):
    lan = Subnet(cidr="192.168.100.0/24", name="LAN")
    iot = Subnet(cidr="192.168.110.0/24", name="IoT", vlan_id=110, gateway_ip=iot_gateway)
    db.add_all([lan, iot])
    await db.commit()
    return lan, iot


async def _router(db, **kwargs):
    dev = Device(ip="192.168.100.1", mac=GW_MAC, display_name="Router", is_online=True, **kwargs)
    db.add(dev)
    await db.commit()
    return dev


async def _all(db, model):
    return (await db.execute(select(model).order_by(model.id))).scalars().all()


def _ip_changes(history):
    return [h for h in history if "IP changed" in (h.message or "")]


@pytest.mark.asyncio
async def test_gateway_does_not_jump_between_its_vlan_addresses(db):
    """Without any subnet config the same MAC in another /24 is still no IP change."""
    await _router(db)

    await _scan(db, [{"ip": "192.168.100.1", "mac": GW_MAC}])
    await _scan(db, [{"ip": "192.168.110.1", "mac": GW_MAC}])
    await _scan(db, [{"ip": "192.168.100.1", "mac": GW_MAC}])
    await _scan(db, [{"ip": "192.168.110.1", "mac": GW_MAC}])

    devices = await _all(db, Device)
    assert [d.ip for d in devices] == ["192.168.100.1"]
    assert devices[0].old_ip is None
    assert not _ip_changes(await _all(db, DeviceHistory))
    # Both addresses stay listed in the IP overview, each in its own subnet
    assert sorted(h.ip for h in await _all(db, DiscoveredHost)) == ["192.168.100.1", "192.168.110.1"]


@pytest.mark.asyncio
async def test_configured_vlan_gateway_becomes_an_interface(db):
    _, iot = await _two_vlans(db, iot_gateway="192.168.110.1")
    await _router(db)

    for _ in range(3):
        await _scan(db, [{"ip": "192.168.110.1", "mac": GW_MAC}])
        await _scan(db, [{"ip": "192.168.100.1", "mac": GW_MAC}])

    devices = await _all(db, Device)
    assert [d.ip for d in devices] == ["192.168.100.1"]
    ifaces = await _all(db, DeviceInterface)
    assert len(ifaces) == 1
    iface = ifaces[0]
    assert (iface.ip, iface.device_id, iface.subnet_id, iface.vlan_id) == ("192.168.110.1", devices[0].id, iot.id, None)
    await db.refresh(iface, ["subnet"])
    assert iface.effective_vlan_id == 110  # inherited, so a later VLAN change on the subnet applies
    assert iface.is_online is True

    history = await _all(db, DeviceHistory)
    assert not _ip_changes(history)
    assert [h.message for h in history] == ["Interface 192.168.110.1 (IoT) attached"]

    disc = (await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == "192.168.110.1"))).scalar_one()
    assert disc.is_monitored is True


@pytest.mark.asyncio
async def test_unset_gateway_falls_back_to_the_first_host_suggestion(db):
    """A subnet without stored gateway_ip uses `.1`, so a stock homelab works without config."""
    await _two_vlans(db)
    await _router(db)

    await _scan(db, [{"ip": "192.168.110.1", "mac": GW_MAC}])

    assert [i.ip for i in await _all(db, DeviceInterface)] == ["192.168.110.1"]


@pytest.mark.asyncio
async def test_known_interface_is_refreshed_not_moved(db):
    lan, iot = await _two_vlans(db)
    dev = await _router(db)
    db.add(DeviceInterface(device_id=dev.id, ip="192.168.110.1", mac=None, is_online=False, missed_scans=2))
    await db.commit()

    await _scan(db, [{"ip": "192.168.110.1", "mac": GW_MAC, "hostname": "router.lan"}])

    devices = await _all(db, Device)
    assert len(devices) == 1 and devices[0].ip == "192.168.100.1"
    iface = (await _all(db, DeviceInterface))[0]
    assert (iface.is_online, iface.missed_scans, iface.mac, iface.subnet_id) == (True, 0, GW_MAC, iot.id)
    assert iface.last_seen is not None
    assert await _all(db, DeviceHistory) == []


@pytest.mark.asyncio
async def test_interface_hit_works_even_with_a_different_mac(db):
    """Routers with one MAC per VLAN: the address alone identifies the interface."""
    await _two_vlans(db)
    dev = await _router(db)
    db.add(DeviceInterface(device_id=dev.id, ip="192.168.110.1"))
    await db.commit()

    await _scan(db, [{"ip": "192.168.110.1", "mac": "aa:bb:cc:00:01:10"}])

    assert [d.ip for d in await _all(db, Device)] == ["192.168.100.1"]
    assert (await _all(db, DeviceInterface))[0].mac == "aa:bb:cc:00:01:10"


@pytest.mark.asyncio
async def test_same_hostname_in_another_subnet_does_not_move_an_online_device(db):
    await _two_vlans(db)
    db.add(Device(ip="192.168.100.20", hostname="nas", display_name="nas", is_online=True))
    await db.commit()

    await _scan(db, [{"ip": "192.168.110.20", "mac": None, "hostname": "nas"}])

    devices = await _all(db, Device)
    assert [(d.ip, d.old_ip) for d in devices] == [("192.168.100.20", None)]


@pytest.mark.asyncio
async def test_offline_device_may_still_roam_to_another_vlan(db):
    """A laptop that left the LAN and shows up in the IoT VLAN keeps the old IP-change behaviour."""
    await _two_vlans(db)
    mac = "aa:bb:cc:00:00:42"
    db.add(Device(ip="192.168.100.42", mac=mac, display_name="Laptop", is_online=False))
    await db.commit()

    await _scan(db, [{"ip": "192.168.110.42", "mac": mac}])

    dev = (await _all(db, Device))[0]
    assert (dev.ip, dev.old_ip) == ("192.168.110.42", "192.168.100.42")
    assert len(_ip_changes(await _all(db, DeviceHistory))) == 1
    assert await _all(db, DeviceInterface) == []


@pytest.mark.asyncio
async def test_same_subnet_mac_change_is_still_an_ip_change(db):
    await _two_vlans(db)
    mac = "aa:bb:cc:00:00:43"
    db.add(Device(ip="192.168.100.43", mac=mac, display_name="Phone", is_online=True))
    await db.commit()

    await _scan(db, [{"ip": "192.168.100.44", "mac": mac}])

    dev = (await _all(db, Device))[0]
    assert (dev.ip, dev.old_ip) == ("192.168.100.44", "192.168.100.43")


@pytest.mark.asyncio
async def test_unmonitored_router_record_does_not_jump_either(db):
    db.add(DiscoveredHost(
        ip="192.168.100.1", mac=GW_MAC, is_online=True,
        first_seen=datetime.now(timezone.utc), last_seen=datetime.now(timezone.utc),
    ))
    await db.commit()

    await _scan(db, [{"ip": "192.168.110.1", "mac": GW_MAC}])

    assert sorted(h.ip for h in await _all(db, DiscoveredHost)) == ["192.168.100.1", "192.168.110.1"]


@pytest.mark.asyncio
async def test_offline_discovered_host_still_follows_its_mac(db):
    db.add(DiscoveredHost(
        ip="192.168.100.50", mac="aa:bb:cc:00:00:50", is_online=False,
        first_seen=datetime.now(timezone.utc), last_seen=datetime.now(timezone.utc),
    ))
    await db.commit()

    await _scan(db, [{"ip": "192.168.110.50", "mac": "aa:bb:cc:00:00:50"}])

    assert [h.ip for h in await _all(db, DiscoveredHost)] == ["192.168.110.50"]
