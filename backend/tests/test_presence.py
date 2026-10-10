"""Tests for the online/offline hysteresis (app/scanner/presence.py)."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

import app.scanner.presence as presence
from app.models.device import Device, DeviceHistory
from app.models.setting import Setting


# --- get_offline_threshold --------------------------------------------------

async def test_offline_threshold_defaults_to_three(db):
    assert await presence.get_offline_threshold(db) == 3


async def test_offline_threshold_reads_setting(db):
    db.add(Setting(key=presence.OFFLINE_THRESHOLD_KEY, value="5"))
    await db.commit()

    assert await presence.get_offline_threshold(db) == 5


@pytest.mark.parametrize("value", ["", "abc", "-1", "2.5"])
async def test_offline_threshold_invalid_falls_back(db, value):
    db.add(Setting(key=presence.OFFLINE_THRESHOLD_KEY, value=value))
    await db.commit()

    assert await presence.get_offline_threshold(db) == 3


async def test_offline_threshold_zero_clamped_to_one(db):
    db.add(Setting(key=presence.OFFLINE_THRESHOLD_KEY, value="0"))
    await db.commit()

    assert await presence.get_offline_threshold(db) == 1


# --- register_miss / register_seen ------------------------------------------

async def test_register_miss_flips_offline_only_at_threshold(monkeypatch, db):
    dev = Device(ip="192.168.1.70", is_online=True, hostname="nextcloud", virtual_type="docker")
    db.add(dev)
    await db.commit()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    assert await presence.register_miss(dev, db, 3) is False
    assert await presence.register_miss(dev, db, 3) is False
    assert dev.is_online is True
    assert dev.missed_scans == 2
    webhook_mock.assert_not_awaited()

    assert await presence.register_miss(dev, db, 3) is True
    await db.commit()

    assert dev.is_online is False
    assert dev.status_changed_at is not None
    history = (await db.execute(select(DeviceHistory))).scalars().all()
    assert [h.status for h in history] == ["offline"]
    webhook_mock.assert_awaited_once()
    assert webhook_mock.await_args.kwargs["event_type"] == "device.offline"


async def test_register_miss_ignores_already_offline_device(monkeypatch, db):
    dev = Device(ip="192.168.1.71", is_online=False, missed_scans=3)
    db.add(dev)
    await db.commit()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    assert await presence.register_miss(dev, db, 3) is False
    assert dev.missed_scans == 3
    webhook_mock.assert_not_awaited()


async def test_register_seen_resets_counter(db):
    dev = Device(ip="192.168.1.72", is_online=True, missed_scans=2)
    db.add(dev)
    await db.commit()

    presence.register_seen(dev)

    assert dev.is_online is True
    assert dev.missed_scans == 0


async def test_flapping_device_never_goes_offline(monkeypatch, db):
    """Miss, miss, seen, miss, miss: never three in a row, so no offline event."""
    dev = Device(ip="192.168.1.73", is_online=True)
    db.add(dev)
    await db.commit()
    webhook_mock = AsyncMock()
    monkeypatch.setattr("app.services.webhook_service.trigger_webhooks", webhook_mock)

    await presence.register_miss(dev, db, 3)
    await presence.register_miss(dev, db, 3)
    presence.register_seen(dev)
    await presence.register_miss(dev, db, 3)
    await presence.register_miss(dev, db, 3)

    assert dev.is_online is True
    webhook_mock.assert_not_awaited()


# --- tcp_fallback_alive -----------------------------------------------------

async def test_tcp_fallback_alive_returns_ips_with_open_ports(monkeypatch):
    scan_mock = AsyncMock(side_effect=lambda ip, **kwargs: [80] if ip == "192.168.1.80" else [])
    monkeypatch.setattr(presence, "scan_ports", scan_mock)

    alive = await presence.tcp_fallback_alive(["192.168.1.80", "192.168.1.81"])

    assert alive == {"192.168.1.80"}
    assert scan_mock.await_args.kwargs["ports"] == presence.FALLBACK_PROBE_PORTS


async def test_tcp_fallback_alive_empty_input_skips_scan(monkeypatch):
    scan_mock = AsyncMock()
    monkeypatch.setattr(presence, "scan_ports", scan_mock)

    assert await presence.tcp_fallback_alive([]) == set()
    scan_mock.assert_not_awaited()


# --- settings validation ----------------------------------------------------

async def test_offline_threshold_setting_validation(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}

    ok = await client.post("/api/settings", json={"scanner.offline_threshold": "3"}, headers=headers)
    assert ok.status_code == 200

    for bad in ("0", "21", "abc", "2.5"):
        res = await client.post("/api/settings", json={"scanner.offline_threshold": bad}, headers=headers)
        assert res.status_code == 400
        assert "offline threshold" in res.json()["detail"]
