"""Tests for the Network Planner scan logic (app/scanner/planner.py)."""

import pytest
import pytest_asyncio
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy import select

import app.scanner.planner as planner
from app.models.device import DiscoveredHost, Device, Service, DeviceHistory
from app.models.network import Subnet
from app.models.setting import Setting


@pytest_asyncio.fixture
def patch_async_session(monkeypatch, db):
    """Route planner's async_session() to the isolated test database."""
    @asynccontextmanager
    async def fake_session():
        yield db
    monkeypatch.setattr(planner, "async_session", fake_session)
    return db


# --- _normalize_subnets -----------------------------------------------------

def test_normalize_subnets_dedupe_and_sort():
    assert planner._normalize_subnets(["10.0.0.0/8", "192.168.1.0/24", "10.0.0.0/8"]) == [
        "10.0.0.0/8", "192.168.1.0/24"
    ]


def test_normalize_subnets_classless_forms():
    assert planner._normalize_subnets(["192.168.1", "192.168.1.5", "myhost"]) == [
        "192.168.1.0/24", "192.168.1.5/32", "myhost/24"
    ]


def test_normalize_subnets_skips_empty():
    assert planner._normalize_subnets(["", "10.0.0.0/8"]) == ["10.0.0.0/8"]


# --- _parse_subnet_list / _load_allowed_networks ----------------------------

def test_parse_subnet_list_skips_invalid(caplog):
    nets = planner._parse_subnet_list(["192.168.1.0/24", "not-a-net", " 10.0.0.0/8 "])
    assert len(nets) == 2
    assert str(nets[0]) == "192.168.1.0/24"
    assert str(nets[1]) == "10.0.0.0/8"


async def test_load_allowed_networks_from_subnet_table(db):
    db.add_all([
        Subnet(cidr="192.168.1.0/24", name="LAN"),
        Subnet(cidr="10.0.0.0/16", name="Lab"),
        Subnet(cidr="garbage", name="Broken"),
        Subnet(cidr="172.16.0.0/24", name="Paused", is_enabled=False),
    ])
    # The legacy setting is no longer a source
    db.add(Setting(key="scan_subnets", value="192.168.50.0/24"))
    await db.commit()

    nets = await planner._load_allowed_networks(db)
    assert [str(n) for n in nets] == ["192.168.1.0/24", "10.0.0.0/16"]


async def test_load_allowed_networks_fallback(monkeypatch, db):
    monkeypatch.setattr(
        "app.scanner.utils.get_auto_scan_subnets", lambda: ["172.16.0.0/12", "nope"]
    )

    nets = await planner._load_allowed_networks(db)
    assert len(nets) == 1
    assert str(nets[0]) == "172.16.0.0/12"


# --- _ip_in_any_subnet ------------------------------------------------------

def test_ip_in_any_subnet():
    subnets = ["192.168.1.0/24", "10.0.0.0/8"]
    assert planner._ip_in_any_subnet("192.168.1.42", subnets) is True
    assert planner._ip_in_any_subnet("10.9.9.9", subnets) is True
    assert planner._ip_in_any_subnet("172.16.0.1", subnets) is False


def test_ip_in_any_subnet_handles_bad_input():
    assert planner._ip_in_any_subnet("not-an-ip", ["192.168.1.0/24"]) is False
    assert planner._ip_in_any_subnet("192.168.1.5", ["not-a-net"]) is False
    assert planner._ip_in_any_subnet("192.168.1.5", []) is False


# --- run_arp_only_scan ------------------------------------------------------

async def test_run_arp_only_scan_empty_table(monkeypatch, patch_async_session):
    monkeypatch.setattr(planner, "get_local_arp_table", lambda: {})
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_hosts_batch", sync_mock)

    assert await planner.run_arp_only_scan() == 0
    sync_mock.assert_not_awaited()


async def test_run_arp_only_scan_filters_by_enabled_subnets(monkeypatch, patch_async_session, db):
    db.add_all([Subnet(cidr="192.168.1.0/24", name="LAN"), Subnet(cidr="10.0.0.0/8", name="Lab")])
    await db.commit()

    arp_table = {
        "192.168.1.10": "aa:bb:cc:dd:ee:01",
        "10.1.2.3": "aa:bb:cc:dd:ee:02",
        "172.16.0.5": "aa:bb:cc:dd:ee:03",
        "not-an-ip": "aa:bb:cc:dd:ee:04",
        "169.254.1.1": "00:00:00:00:00:00",
    }
    monkeypatch.setattr(planner, "get_local_arp_table", lambda: arp_table)
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_hosts_batch", sync_mock)

    assert await planner.run_arp_only_scan() == 2
    sync_mock.assert_awaited_once()
    args = sync_mock.await_args
    assert args.kwargs["is_planner_scan"] is True
    ips = {h["ip"] for h in args.args[0]}
    assert ips == {"192.168.1.10", "10.1.2.3"}


# --- _cleanup_discovered_hosts ---------------------------------------------

async def test_cleanup_discovered_hosts_deletes_unmonitored(db):
    db.add(DiscoveredHost(ip="192.168.1.50", is_online=True, is_monitored=False))
    db.add(DiscoveredHost(ip="172.16.0.9", is_online=True, is_monitored=False))
    await db.commit()

    await planner._cleanup_discovered_hosts(db, ["192.168.1.0/24"], set())
    await db.commit()

    remaining = (await db.execute(select(DiscoveredHost))).scalars().all()
    assert [h.ip for h in remaining] == ["172.16.0.9"]


async def test_cleanup_discovered_hosts_marks_monitored_offline(db):
    db.add(DiscoveredHost(ip="192.168.1.50", is_online=True, is_monitored=True))
    db.add(DiscoveredHost(ip="192.168.1.60", is_online=True, is_monitored=True))
    await db.commit()

    await planner._cleanup_discovered_hosts(db, ["192.168.1.0/24"], {"192.168.1.60"})
    await db.commit()

    hosts = (await db.execute(select(DiscoveredHost))).scalars().all()
    by_ip = {h.ip: h for h in hosts}
    assert by_ip["192.168.1.50"].is_online is False
    assert by_ip["192.168.1.60"].is_online is True


# --- _cleanup_devices -------------------------------------------------------

@pytest.fixture
def no_tcp_fallback(monkeypatch):
    """TCP fallback finds nothing, so every absent device counts a miss."""
    mock = AsyncMock(return_value=set())
    monkeypatch.setattr(planner, "tcp_fallback_alive", mock)
    return mock


async def test_cleanup_devices_marks_offline_after_threshold(monkeypatch, db, no_tcp_fallback):
    db.add(Device(ip="192.168.1.60", is_online=True, hostname="printer"))
    await db.commit()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    for _ in range(2):
        await planner._cleanup_devices(db, ["192.168.1.0/24"], set(), offline_threshold=3)
        await db.commit()
    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is True
    assert dev.missed_scans == 2
    webhook_mock.assert_not_awaited()

    await planner._cleanup_devices(db, ["192.168.1.0/24"], set(), offline_threshold=3)
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is False
    assert dev.status_changed_at is not None

    history = (await db.execute(select(DeviceHistory))).scalars().all()
    assert len(history) == 1
    assert history[0].device_id == dev.id
    assert history[0].status == "offline"

    webhook_mock.assert_awaited_once()
    call = webhook_mock.await_args
    assert call.kwargs["event_type"] == "device.offline"
    assert call.kwargs["data"]["ip"] == "192.168.1.60"


async def test_cleanup_devices_skips_configured_services(monkeypatch, db):
    dev = Device(ip="192.168.1.60", is_online=True, hostname="switch")
    db.add(dev)
    await db.flush()
    db.add(Service(device_id=dev.id, name="SSH", protocol="ssh", port=22))
    await db.commit()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    await planner._cleanup_devices(db, ["192.168.1.0/24"], set())
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is True
    assert (await db.execute(select(DeviceHistory))).scalars().all() == []
    webhook_mock.assert_not_awaited()


async def test_cleanup_devices_tcp_fallback_keeps_docker_online(monkeypatch, db):
    """An ipvlan container that ignores ICMP but answers on TCP stays online."""
    db.add(Device(ip="192.168.1.231", is_online=True, hostname="nextcloud", virtual_type="docker", missed_scans=2))
    await db.commit()
    tcp_mock = AsyncMock(return_value={"192.168.1.231"})
    monkeypatch.setattr(planner, "tcp_fallback_alive", tcp_mock)
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    await planner._cleanup_devices(db, ["192.168.1.0/24"], set(), offline_threshold=3)
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is True
    assert dev.missed_scans == 0
    tcp_mock.assert_awaited_once_with(["192.168.1.231"])
    webhook_mock.assert_not_awaited()


async def test_cleanup_devices_resets_counter_when_seen(db, no_tcp_fallback):
    db.add(Device(ip="192.168.1.60", is_online=True, hostname="printer", missed_scans=2))
    await db.commit()

    await planner._cleanup_devices(db, ["192.168.1.0/24"], {"192.168.1.60"}, offline_threshold=3)
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is True
    assert dev.missed_scans == 0
    no_tcp_fallback.assert_awaited_once_with([])


async def test_cleanup_devices_skips_outside_subnets(db):
    db.add(Device(ip="172.16.0.9", is_online=True, hostname="other"))
    await db.commit()

    await planner._cleanup_devices(db, ["192.168.1.0/24"], set())
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is True


# --- run_planner_scan -------------------------------------------------------

async def test_run_planner_scan_end_to_end(monkeypatch, patch_async_session, db, no_tcp_fallback):
    db.add(DiscoveredHost(ip="192.168.1.50", is_online=True, is_monitored=False))
    db.add(DiscoveredHost(ip="192.168.1.10", is_online=True, is_monitored=True))
    # Two misses already counted: this scan is the third (default threshold)
    db.add(Device(ip="192.168.1.60", is_online=True, hostname="printer", missed_scans=2))
    await db.commit()

    monkeypatch.setattr(planner, "discover_hosts_simple", AsyncMock(return_value=[
        {"ip": "192.168.1.10", "mac": "aa:bb:cc:dd:ee:10"}
    ]))
    monkeypatch.setattr(planner, "resolve_mac_addresses", AsyncMock(return_value=[
        {"ip": "192.168.1.10", "mac": "aa:bb:cc:dd:ee:10"}
    ]))
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_hosts_batch", sync_mock)
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)
    docker_service = MagicMock()
    docker_service.is_available.return_value = False
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)
    progress = AsyncMock()

    total = await planner.run_planner_scan(["192.168.1.0/24"], progress_callback=progress)

    assert total == 1
    sync_mock.assert_awaited_once()
    assert sync_mock.await_args.kwargs["is_planner_scan"] is True
    docker_service.get_local_containers.assert_not_called()

    remaining_hosts = (await db.execute(select(DiscoveredHost))).scalars().all()
    assert [h.ip for h in remaining_hosts] == ["192.168.1.10"]
    assert remaining_hosts[0].is_online is True

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.is_online is False

    events = [c.args[0] if c.args else c.kwargs.get("event_type") for c in webhook_mock.await_args_list]
    assert "scan.complete" in events
    assert "device.offline" in events
    progress.assert_awaited()


async def test_run_planner_scan_skips_link_local_and_invalid_subnets(monkeypatch, patch_async_session, db):
    monkeypatch.setattr(planner, "discover_hosts_simple", AsyncMock(return_value=[]))
    monkeypatch.setattr(planner, "resolve_mac_addresses", AsyncMock(return_value=[]))
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_hosts_batch", sync_mock)
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", AsyncMock())

    total = await planner.run_planner_scan(["169.254.0.0/16", "not-a-subnet", "10.0.0.0/8"])

    assert total == 0
    # Only the valid 10.0.0.0/8 subnet is scanned
    assert planner.discover_hosts_simple.await_count == 1
    args = planner.discover_hosts_simple.await_args
    assert args.args[0][0] == "10.0.0.1"
    sync_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_network_subnets_l2_l3_enrichment(client, db, admin_token, monkeypatch):
    from app.models.network import Subnet
    from app.schemas.scan import SubnetInfo

    # Mock local interfaces: eth0 on 192.168.1.0/24
    mock_local = [
        SubnetInfo(
            interface_name="eth0",
            ip_address="192.168.1.50",
            subnet="192.168.1.0/24",
            netmask="255.255.255.0",
            is_up=True,
            is_virtual=False,
        )
    ]
    monkeypatch.setattr("app.scanner.utils.get_local_subnets", lambda: mock_local)

    # Insert one direct L2 subnet and one routed L3 subnet
    db.add(Subnet(name="LAN Direct", cidr="192.168.1.0/24", is_enabled=True))
    db.add(Subnet(name="VLAN 50 Routed", cidr="10.50.0.0/24", is_enabled=True))
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}
    response = await client.get("/api/network/subnets", headers=headers)
    assert response.status_code == 200
    data = response.json()

    lan = next(s for s in data if s["cidr"] == "192.168.1.0/24")
    assert lan["is_direct_l2"] is True
    assert lan["interface_name"] == "eth0"

    vlan = next(s for s in data if s["cidr"] == "10.50.0.0/24")
    assert vlan["is_direct_l2"] is False
    assert vlan["interface_name"] is None