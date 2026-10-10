"""Tests for the dashboard scan logic."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select

import app.scanner.dashboard as dashboard
from app.models.device import Device, DeviceHistory, Service
from app.models.network import Subnet


@pytest.fixture
def patch_async_session(monkeypatch, db):
    """Route dashboard sessions to the isolated test database."""
    @asynccontextmanager
    async def fake_session():
        yield db

    monkeypatch.setattr(dashboard, "async_session", fake_session)
    return db


async def test_sync_local_docker_containers_skips_unavailable(monkeypatch):
    docker_service = MagicMock()
    docker_service.is_available.return_value = False
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_docker_containers", sync_mock)

    await dashboard._sync_local_docker_containers()

    docker_service.get_local_containers.assert_not_called()
    sync_mock.assert_not_awaited()


async def test_sync_local_docker_containers_syncs_available_containers(monkeypatch):
    docker_service = MagicMock()
    docker_service.is_available.return_value = True
    containers = [{"name": "web", "ip": "172.17.0.2"}]
    docker_service.get_local_containers.return_value = containers
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_docker_containers", sync_mock)

    await dashboard._sync_local_docker_containers()

    sync_mock.assert_awaited_once_with(containers)


async def test_discover_subnet_hosts_uses_dns_and_syncs(monkeypatch, patch_async_session, db):
    db.add(Subnet(cidr="192.168.1.0/30", name="LAN", dns_server="8.8.8.8"))
    await db.commit()
    alive = [{"ip": "192.168.1.1"}]
    resolved = [{"ip": "192.168.1.1", "mac": "aa:bb:cc:dd:ee:01"}]
    discover_mock = AsyncMock(return_value=alive)
    resolve_mock = AsyncMock(return_value=resolved)
    sync_mock = AsyncMock()
    monkeypatch.setattr(dashboard, "discover_hosts_simple", discover_mock)
    monkeypatch.setattr(dashboard, "resolve_mac_addresses", resolve_mock)
    monkeypatch.setattr("app.scanner.sync.sync_hosts_batch", sync_mock)

    result = await dashboard._discover_subnet_hosts("192.168.1.0/30")

    assert result == resolved
    discover_mock.assert_awaited_once_with(["192.168.1.1", "192.168.1.2"], dns_server="8.8.8.8")
    resolve_mock.assert_awaited_once_with(alive)
    sync_mock.assert_awaited_once_with(
        resolved,
        is_planner_scan=False,
        should_invalidate_cache=False,
    )


async def test_update_device_health_counts_miss_below_threshold(monkeypatch, db):
    from sqlalchemy.orm import selectinload

    db.add(Device(ip="192.168.1.60", is_online=True, hostname="printer"))
    await db.commit()
    device = (await db.execute(select(Device).options(selectinload(Device.services)))).scalar_one()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    await dashboard._update_device_health(device, {}, [], db, offline_threshold=3)
    await db.commit()

    assert device.is_online is True
    assert device.missed_scans == 1
    assert (await db.execute(select(DeviceHistory))).scalars().all() == []
    webhook_mock.assert_not_awaited()


async def test_update_device_health_marks_offline(monkeypatch, db):
    from sqlalchemy.orm import selectinload

    db.add(Device(ip="192.168.1.60", is_online=True, hostname="printer", missed_scans=2))
    await db.commit()
    device = (await db.execute(select(Device).options(selectinload(Device.services)))).scalar_one()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    await dashboard._update_device_health(device, {}, [], db, offline_threshold=3)
    await db.commit()

    assert device.is_online is False
    assert device.status_changed_at is not None
    history = (await db.execute(select(DeviceHistory))).scalars().all()
    assert len(history) == 1
    assert history[0].status == "offline"
    webhook_mock.assert_awaited_once()
    assert webhook_mock.await_args.kwargs["event_type"] == "device.offline"


async def test_update_device_health_backfills_mac_and_service_status(db):
    from sqlalchemy.orm import selectinload

    device = Device(ip="192.168.1.10", is_online=False, missed_scans=3)
    device.services = [
        Service(name="SSH", protocol="ssh", port=22),
        Service(name="HTTP", protocol="http", port=80),
    ]
    db.add(device)
    await db.commit()

    await dashboard._update_device_health(
        device,
        {"192.168.1.10": {"mac": "aa:bb:cc:dd:ee:10", "vendor": "Test Vendor"}},
        [22],
        db,
    )
    await db.commit()

    assert device.is_online is True
    assert device.missed_scans == 0
    assert device.mac == "aa:bb:cc:dd:ee:10"
    assert device.vendor == "Test Vendor"
    assert device.last_seen is not None
    assert [service.is_up for service in device.services] == [True, False]


async def test_find_new_management_devices_filters_known_and_closed_hosts(monkeypatch):
    scan_mock = AsyncMock(side_effect=lambda ip, **kwargs: [22] if ip == "192.168.1.200" else [])
    classify_mock = MagicMock(return_value={"hostname": "router"})
    monkeypatch.setattr(dashboard, "scan_ports", scan_mock)
    monkeypatch.setattr("app.scanner.classifier.classify_device", classify_mock)
    devices = [Device(ip="192.168.1.10")]
    hosts = [
        {"ip": "192.168.1.10"},
        {"ip": "192.168.1.100"},
        {"ip": "192.168.1.200", "mac": "aa:bb:cc:dd:ee:20", "vendor": "Vendor"},
    ]

    result = await dashboard._find_new_management_devices(hosts, devices)

    assert result == [{
        "ip": "192.168.1.200",
        "mac": "aa:bb:cc:dd:ee:20",
        "hostname": "router",
        "vendor": "Vendor",
        "ports": [22],
    }]
    assert scan_mock.await_count == 2
    classify_mock.assert_called_once_with({"ip": "192.168.1.200", "ports": [22]})


async def test_run_dashboard_scan_end_to_end(monkeypatch, patch_async_session, db):
    existing = Device(ip="192.168.1.10", is_online=True)
    # Two misses already counted: this scan is the third (default threshold)
    offline = Device(ip="192.168.1.60", is_online=True, missed_scans=2)
    db.add_all([existing, offline])
    await db.commit()

    docker_service = MagicMock()
    docker_service.is_available.return_value = False
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)
    monkeypatch.setattr(
        dashboard,
        "discover_hosts_simple",
        AsyncMock(return_value=[{"ip": "192.168.1.10"}, {"ip": "192.168.1.200"}]),
    )
    monkeypatch.setattr(
        dashboard,
        "resolve_mac_addresses",
        AsyncMock(return_value=[
            {"ip": "192.168.1.10", "mac": "aa:bb:cc:dd:ee:10"},
            {"ip": "192.168.1.200", "mac": "aa:bb:cc:dd:ee:20"},
        ]),
    )
    sync_mock = AsyncMock()
    monkeypatch.setattr("app.scanner.sync.sync_hosts_batch", sync_mock)
    monkeypatch.setattr(
        dashboard,
        "scan_ports",
        AsyncMock(side_effect=lambda ip, **kwargs: [22] if ip in {"192.168.1.10", "192.168.1.200"} else []),
    )
    monkeypatch.setattr("app.scanner.classifier.classify_device", MagicMock(return_value={"hostname": "router"}))
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)
    monkeypatch.setattr(dashboard, "discovery_cache", MagicMock())
    monkeypatch.setattr(dashboard, "dashboard_cache", MagicMock())
    monkeypatch.setattr(dashboard, "topology_cache", MagicMock())
    progress = AsyncMock()

    result = await dashboard.run_dashboard_scan(["192.168.1.0/24"], progress_callback=progress)

    assert result == 1
    assert sync_mock.await_count == 2
    assert sync_mock.await_args.kwargs["is_planner_scan"] is False
    assert (await db.execute(select(Device).where(Device.ip == "192.168.1.60"))).scalar_one().is_online is False
    events = [call.kwargs["event_type"] for call in webhook_mock.await_args_list]
    assert "device.offline" in events
    assert "scan.complete" in events
    assert webhook_mock.await_args.kwargs["data"]["new_devices_found"] == 1
    progress.assert_awaited()
