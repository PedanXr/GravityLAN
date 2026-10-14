"""Tests for schema migrations and corrupted-IP repair logic."""

from unittest.mock import MagicMock

import pytest
from sqlalchemy import select, text

import app.database.migrations as migrations
from app.models.device import Device, DiscoveredHost


@pytest.fixture
def docker_unavailable(monkeypatch):
    docker_service = MagicMock()
    docker_service.is_available.return_value = False
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)
    return docker_service


def test_no_hardcoded_developer_network_data():
    """The repair used to map device ids and names to one developer's 192.168.100.x IPs."""
    for name in ("KNOWN_CONTAINER_IPS", "RECONCILIATION_KEYWORD_MAP", "_ip_from_known_id", "_ip_from_keywords"):
        assert not hasattr(migrations, name)

    import inspect
    assert "192.168.100." not in inspect.getsource(migrations)


@pytest.mark.parametrize("dev_id, name", [
    (27, ""),            # was KNOWN_CONTAINER_IPS[27]
    (None, "Nextcloud"),  # was RECONCILIATION_KEYWORD_MAP["nextcloud"]
    (None, "unraid"),
])
async def test_repair_device_ignores_former_hardcoded_ids_and_names(db, docker_unavailable, dev_id, name):
    """Another installation's device 27 or 'Nextcloud' must not get a foreign IP."""
    dev = Device(ip="offline-aa:bb:cc", ip_placeholder=True, display_name=name)
    if dev_id:
        dev.id = dev_id
    db.add(dev)
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.ip == "0.0.0.0"
    assert dev.is_online is False
    assert dev.ip_placeholder is True


async def test_repair_device_docker_match(db, monkeypatch):
    docker_service = MagicMock()
    docker_service.is_available.return_value = True
    docker_service.get_local_containers.return_value = [
        {"name": "nextcloud-aio", "ips": ["10.0.0.7"], "status": "running"},
    ]
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)

    db.add(Device(ip="offline-aa:bb:cc", ip_placeholder=True, display_name="Nextcloud"))
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.ip == "10.0.0.7"
    assert dev.is_online is True
    assert dev.ip_placeholder is False


async def test_repair_device_restores_old_ip(db, docker_unavailable):
    db.add(Device(ip="offline-aa:bb:cc", ip_placeholder=True, display_name="", old_ip="192.168.5.50"))
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    dev = (await db.execute(select(Device))).scalar_one()
    assert dev.ip == "192.168.5.50"
    assert dev.is_online is False
    assert dev.ip_placeholder is True


async def test_repair_device_fallback_unique_placeholder(db, docker_unavailable):
    db.add(Device(ip="offline-aa:bb:cc", ip_placeholder=True, display_name=""))
    db.add(Device(ip="offline-dd:ee:ff", ip_placeholder=True, display_name=""))
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    devs = (await db.execute(select(Device))).scalars().all()
    assert sorted(d.ip for d in devs) == ["0.0.0.0", "0.0.0.1"]
    assert all(d.is_online is False and d.ip_placeholder is True for d in devs)


async def test_repair_device_skips_taken_docker_ip(db, monkeypatch):
    docker_service = MagicMock()
    docker_service.is_available.return_value = True
    docker_service.get_local_containers.return_value = [
        {"name": "nextcloud", "ips": ["10.0.0.7"], "status": "running"},
    ]
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)

    db.add(Device(ip="10.0.0.7", display_name="Real Nextcloud"))
    db.add(Device(ip="offline-aa:bb:cc", ip_placeholder=True, display_name="nextcloud", old_ip="10.0.0.9"))
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    devs = {d.display_name: d for d in (await db.execute(select(Device))).scalars().all()}
    assert devs["Real Nextcloud"].ip == "10.0.0.7"
    repaired = devs["nextcloud"]
    # Docker IP taken -> old_ip restore strategy wins
    assert repaired.ip == "10.0.0.9"
    assert repaired.is_online is False
    assert repaired.ip_placeholder is True


async def test_repair_discovered_host_docker_match(db, monkeypatch):
    docker_service = MagicMock()
    docker_service.is_available.return_value = True
    docker_service.get_local_containers.return_value = [
        {"name": "Redis", "ips": ["10.0.0.5"], "status": "running"},
        {"name": "Stopped", "ips": ["10.0.0.6"], "status": "exited"},
    ]
    monkeypatch.setattr("app.services.docker_service.docker_service", docker_service)

    db.add(DiscoveredHost(ip="offline-aa:bb:cc", ip_placeholder=True, custom_name="redis"))
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    host = (await db.execute(select(DiscoveredHost))).scalar_one()
    assert host.ip == "10.0.0.5"
    assert host.is_online is True
    assert host.ip_placeholder is False


async def test_repair_discovered_host_fallback(db, docker_unavailable):
    db.add(DiscoveredHost(ip="offline-aa:bb:cc", ip_placeholder=True, custom_name="mystery"))
    await db.commit()

    await migrations._clean_corrupted_ip_placeholders(db)
    await db.commit()

    host = (await db.execute(select(DiscoveredHost))).scalar_one()
    assert host.ip == "0.0.0.0"
    assert host.is_online is False
    assert host.ip_placeholder is True


async def test_run_migrations_noop_on_fresh_schema(db, docker_unavailable):
    # conftest already created the full schema; nothing to alter, but it must run clean.
    await migrations.run_migrations(db)

    rows = (await db.execute(text("PRAGMA table_info(devices)"))).all()
    names = {r[1] for r in rows}
    assert {"topology_x", "max_ports", "ip_placeholder"} <= names
