import pytest
from types import SimpleNamespace
from unittest.mock import patch
from sqlalchemy import select

from app.models.device import Device, DiscoveredHost, DeviceHistory
from app.scanner.sync import (
    sync_host_to_db,
    sync_hosts_batch,
    sync_docker_containers,
    _mac_is_valid,
    _fuzzy_match,
    _is_unraid_host,
)

class DBSessionContextMock:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


@pytest.mark.asyncio
async def test_sync_host_to_db_single_host_creates_discovered_host(db):
    scan = {
        "ip": "192.168.1.42",
        "mac": "00:11:22:33:44:42",
        "hostname": "raspberry-pi",
        "vendor": "Raspberry Pi Foundation",
    }

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        results = await sync_host_to_db(**scan)

    assert len(results) == 1

    res = await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == "192.168.1.42"))
    disc = res.scalar_one()
    assert disc.hostname == "raspberry-pi"
    assert disc.vendor == "Raspberry Pi Foundation"
    assert disc.is_online is True
    assert disc.is_monitored is False


@pytest.mark.asyncio
async def test_sync_hosts_batch_empty_input_returns_empty(db):
    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        results = await sync_hosts_batch([])

    assert results == []


@pytest.mark.asyncio
async def test_sync_hosts_batch_invalidates_caches_only_when_requested(db):
    dev = Device(
        ip="192.168.1.60",
        mac="00:11:22:33:44:60",
        display_name="Monitored",
        is_online=True,
    )
    db.add(dev)
    await db.commit()

    scan_hosts = [{"ip": "192.168.1.60", "mac": "00:11:22:33:44:60"}]
    session_ctx = DBSessionContextMock(db)

    with (
        patch("app.scanner.sync.async_session", return_value=session_ctx),
        patch("app.scanner.sync.discovery_cache") as disc_cache,
        patch("app.scanner.sync.dashboard_cache") as dash_cache,
        patch("app.scanner.sync.topology_cache") as topo_cache,
    ):
        await sync_hosts_batch(scan_hosts)
        disc_cache.invalidate.assert_called_once()
        dash_cache.invalidate_all.assert_called_once()
        topo_cache.invalidate.assert_called_once()

        disc_cache.reset_mock()
        dash_cache.reset_mock()
        topo_cache.reset_mock()
        await sync_hosts_batch(scan_hosts, should_invalidate_cache=False)
        disc_cache.invalidate.assert_not_called()
        dash_cache.invalidate_all.assert_not_called()
        topo_cache.invalidate.assert_not_called()


@pytest.mark.asyncio
async def test_verified_mac_match_ip_change_creates_history(db):
    dev = Device(
        ip="192.168.1.50",
        mac="00:11:22:33:44:55",
        display_name="Verified Device",
        is_online=True,
    )
    db.add(dev)
    await db.commit()

    scan_hosts = [{"ip": "192.168.1.77", "mac": "00:11:22:33:44:55"}]

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_hosts_batch(scan_hosts)

    res = await db.execute(select(Device).where(Device.id == dev.id))
    updated = res.scalar_one()
    assert updated.ip == "192.168.1.77"
    assert updated.old_ip == "192.168.1.50"

    res_hist = await db.execute(select(DeviceHistory).where(DeviceHistory.device_id == dev.id))
    histories = res_hist.scalars().all()
    assert len(histories) == 1
    assert "192.168.1.50" in histories[0].message
    assert "192.168.1.77" in histories[0].message


@pytest.mark.asyncio
async def test_ip_conflict_moves_device_to_reusable_old_ip(db):
    dev_a = Device(
        ip="192.168.1.100",
        mac="00:11:22:33:44:aa",
        display_name="Device A",
        is_online=True,
    )
    dev_b = Device(
        ip="192.168.1.200",
        mac="00:11:22:33:44:bb",
        display_name="Device B",
        is_online=True,
        old_ip="192.168.1.99",
    )
    db.add_all([dev_a, dev_b])
    await db.commit()

    scan_hosts = [{"ip": "192.168.1.200", "mac": "00:11:22:33:44:aa"}]

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_hosts_batch(scan_hosts)

    res_a = await db.execute(select(Device).where(Device.mac == "00:11:22:33:44:aa"))
    a = res_a.scalar_one()
    assert a.ip == "192.168.1.200"

    res_b = await db.execute(select(Device).where(Device.mac == "00:11:22:33:44:bb"))
    b = res_b.scalar_one()
    assert b.ip == "192.168.1.99"
    assert b.ip_placeholder is True
    assert b.is_online is False


@pytest.mark.asyncio
async def test_unraid_host_keeps_ip_on_mac_only_fallback(db):
    unraid = Device(
        ip="192.168.1.10",
        mac="00:11:22:33:44:66",
        display_name="Unraid Server",
        is_online=True,
    )
    db.add(unraid)
    await db.commit()

    scan_hosts = [{"ip": "192.168.1.20", "mac": "00:11:22:33:44:66"}]

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_hosts_batch(scan_hosts)

    res = await db.execute(select(Device).where(Device.id == unraid.id))
    after = res.scalar_one()
    assert after.ip == "192.168.1.10", "Unraid host must not be hijacked to a new IP"

    res_disc = await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == "192.168.1.20"))
    disc = res_disc.scalar_one()
    assert disc.mac == "00:11:22:33:44:66"


@pytest.mark.asyncio
async def test_unraid_host_recognised_by_hostname_keeps_ip(db):
    """The Unraid guard looks at every name field, not only the first non-empty one."""
    unraid = Device(
        ip="192.168.1.10",
        mac="00:11:22:33:44:67",
        display_name="Tower",
        hostname="unraid",
        is_online=True,
    )
    db.add(unraid)
    await db.commit()

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_hosts_batch([{"ip": "192.168.1.21", "mac": "00:11:22:33:44:67"}])

    res = await db.execute(select(Device).where(Device.id == unraid.id))
    assert res.scalar_one().ip == "192.168.1.10"


@pytest.mark.asyncio
async def test_device_id_29_gets_no_unraid_protection(db):
    """Device ID 29 used to be hardcoded as the Unraid host; it is an ordinary device now."""
    dev = Device(
        id=29,
        ip="192.168.1.30",
        mac="00:11:22:33:44:29",
        display_name="Printer",
        is_online=True,
    )
    db.add(dev)
    await db.commit()

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_hosts_batch([{"ip": "192.168.1.31", "mac": "00:11:22:33:44:29"}])

    res = await db.execute(select(Device).where(Device.id == 29))
    assert res.scalar_one().ip == "192.168.1.31"


@pytest.mark.asyncio
async def test_discovered_host_inherits_name_from_monitored_device(db):
    dev = Device(
        ip="192.168.1.30",
        mac="00:aa:bb:cc:dd:01",
        display_name="Media Server",
        is_online=True,
    )
    db.add(dev)
    await db.commit()

    scan_hosts = [{"ip": "192.168.1.30", "mac": "00:aa:bb:cc:dd:01"}]

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_hosts_batch(scan_hosts)

    res = await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == "192.168.1.30"))
    disc = res.scalar_one()
    assert disc.custom_name == "Media Server"
    assert disc.is_monitored is True


@pytest.mark.asyncio
async def test_docker_sync_restores_placeholder_device_by_fuzzy_name(db):
    dev = Device(
        ip="0.0.0.1",
        mac="02:63:aa:bb:cc:dd",
        display_name="Lancache Cache",
        ip_placeholder=True,
        is_online=False,
    )
    db.add(dev)
    await db.commit()

    containers = [{
        "id": "c1",
        "name": "lancache",
        "ips": ["192.168.100.15"],
        "status": "running",
    }]

    session_ctx = DBSessionContextMock(db)
    with (
        patch("app.scanner.sync.async_session", return_value=session_ctx),
        patch("app.scanner.sync.discovery_cache"),
        patch("app.scanner.sync.dashboard_cache"),
        patch("app.scanner.sync.topology_cache"),
    ):
        await sync_docker_containers(containers)

    res = await db.execute(select(Device).where(Device.id == dev.id))
    updated = res.scalar_one()
    assert updated.ip == "192.168.100.15"
    assert updated.ip_placeholder is False
    assert updated.is_online is True


@pytest.mark.asyncio
async def test_docker_sync_skips_non_running_containers(db):
    dev = Device(
        ip="0.0.0.2",
        mac="02:63:aa:bb:cc:ee",
        display_name="Stopped Service",
        ip_placeholder=True,
        is_online=False,
    )
    db.add(dev)
    await db.commit()

    containers = [{
        "id": "c2",
        "name": "stopped-service",
        "ips": ["192.168.100.22"],
        "status": "exited",
    }]

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_docker_containers(containers)

    res = await db.execute(select(Device).where(Device.id == dev.id))
    after = res.scalar_one()
    assert after.ip == "0.0.0.2"
    assert after.ip_placeholder is True
    assert after.is_online is False


@pytest.mark.asyncio
async def test_docker_sync_updates_discovered_host_placeholder(db):
    disc = DiscoveredHost(
        ip="0.0.0.3",
        hostname="plex",
        custom_name="Unknown",
        ip_placeholder=True,
        is_online=False,
        is_monitored=False,
    )
    db.add(disc)
    await db.commit()

    containers = [{
        "id": "c3",
        "name": "plex",
        "ips": ["192.168.100.20"],
        "status": "running",
    }]

    session_ctx = DBSessionContextMock(db)
    with patch("app.scanner.sync.async_session", return_value=session_ctx):
        await sync_docker_containers(containers)

    res = await db.execute(select(DiscoveredHost).where(DiscoveredHost.id == disc.id))
    updated = res.scalar_one()
    assert updated.ip == "192.168.100.20"
    assert updated.ip_placeholder is False
    assert updated.is_online is True
    assert updated.custom_name == "plex"


def test_mac_is_valid_cases():
    assert _mac_is_valid(None) is False
    assert _mac_is_valid("") is False
    assert _mac_is_valid("00:00:00:00:00:00") is False
    assert _mac_is_valid("ff:ff:ff:ff:ff:ff") is False
    assert _mac_is_valid("01:00:5e:00:00:01") is False
    assert _mac_is_valid("33:33:00:00:00:01") is False
    assert _mac_is_valid("02:42:ac:11:00:01") is True
    assert _mac_is_valid("00:11:22:33:44:55") is True


def test_fuzzy_match_cases():
    assert _fuzzy_match(None, "lancache") is False
    assert _fuzzy_match("lancache", None) is False
    assert _fuzzy_match("lancache", "Lancache Cache") is True
    assert _fuzzy_match("my_device", "my-device-1") is True
    assert _fuzzy_match("router", "switch") is False


def test_is_unraid_host_checks_names_and_vendor():
    def entity(**fields):
        base = {"display_name": None, "custom_name": None, "hostname": None, "vendor": None}
        return SimpleNamespace(**{**base, **fields})

    assert _is_unraid_host(entity(display_name="My UNRAID box")) is True
    assert _is_unraid_host(entity(custom_name="unraid")) is True
    assert _is_unraid_host(entity(display_name="Tower", hostname="Unraid-01")) is True
    assert _is_unraid_host(entity(vendor="Unraid")) is True
    assert _is_unraid_host(entity(display_name="Printer", hostname="hp-laserjet")) is False
    assert _is_unraid_host(entity()) is False
    # Device has no custom_name, DiscoveredHost no display_name: missing attributes are fine
    assert _is_unraid_host(SimpleNamespace(hostname="unraid")) is True
