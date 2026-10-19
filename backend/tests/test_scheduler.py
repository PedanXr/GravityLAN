"""Tests for the scan scheduler (app/scanner/scheduler.py)."""

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest_asyncio

from sqlalchemy import select

import app.scanner.scheduler as scheduler_module
import app.scanner.utils as utils_module
from app.scanner.scheduler import _get_auto_scan_subnets  # noqa: F401  (re-exported for tests)
from app.models.device import Device, DeviceHistory
from app.models.network import Subnet
from app.models.setting import Setting
from app.models.agent import DeviceMetrics


async def _seed_device(db) -> Device:
    """Create a minimal device row and return it (required by history FK)."""
    dev = Device(ip="192.168.1.50", mac="aa:bb:cc:dd:ee:ff", hostname="test-host")
    db.add(dev)
    await db.flush()
    return dev


@pytest_asyncio.fixture
def patch_async_session(monkeypatch, db):
    """Route scheduler's async_session() to the isolated test database."""
    @asynccontextmanager
    async def fake_session():
        yield db
    monkeypatch.setattr(scheduler_module, "async_session", fake_session)
    return db


# --- _get_auto_scan_subnets -------------------------------------------------

def test_get_auto_scan_subnets_filters_virtual(monkeypatch):
    class FakeSubnet:
        def __init__(self, subnet, is_virtual):
            self.subnet = subnet
            self.is_virtual = is_virtual

    monkeypatch.setattr(
        utils_module,
        "get_local_subnets",
        lambda: [
            FakeSubnet("192.168.1.0/24", False),
            FakeSubnet("172.17.0.0/16", True),
            FakeSubnet("10.0.0.0/8", False),
        ],
    )
    assert scheduler_module._get_auto_scan_subnets() == ["192.168.1.0/24", "10.0.0.0/8"]


# --- _get_setting_value / _get_setting_int ----------------------------------

async def test_get_setting_value_missing(db):
    assert await scheduler_module._get_setting_value(db, "does.not.exist") is None


async def test_get_setting_value_present(db):
    db.add(Setting(key="scan_interval", value="15"))
    await db.commit()
    assert await scheduler_module._get_setting_value(db, "scan_interval") == "15"


async def test_get_setting_int_valid_and_fallback(db):
    db.add(Setting(key="scan_interval", value="7"))
    await db.commit()

    assert await scheduler_module._get_setting_int(db, "scan_interval", 0) == 7
    assert await scheduler_module._get_setting_int(db, "missing.key", 42) == 42
    db.add(Setting(key="bad.value", value="not-a-number"))
    await db.commit()
    assert await scheduler_module._get_setting_int(db, "bad.value", 9) == 9


# --- _get_scan_subnets ------------------------------------------------------

async def test_get_scan_subnets_configured(db):
    db.add_all([
        Subnet(cidr="192.168.100.0/24", name="Home LAN"),
        Subnet(cidr="192.168.110.0/24", name="IoT"),
        Subnet(cidr="192.168.120.0/24", name="Paused", is_enabled=False),
    ])
    # Only the Subnet table counts; the legacy setting is ignored
    db.add(Setting(key="scan_subnets", value="10.0.0.0/24"))
    await db.commit()

    result = await scheduler_module._get_scan_subnets(db, ["auto-dummy"])
    assert result == ["192.168.100.0/24", "192.168.110.0/24"]


async def test_get_scan_subnets_fallback(db):
    result = await scheduler_module._get_scan_subnets(db, ["auto-dummy"])
    assert result == ["auto-dummy"]


async def test_get_scan_subnets_fallback_when_all_disabled(db):
    db.add(Subnet(cidr="192.168.100.0/24", name="Home LAN", is_enabled=False))
    await db.commit()

    result = await scheduler_module._get_scan_subnets(db, ["auto-dummy"])
    assert result == ["auto-dummy"]


async def test_quick_loop_scans_every_enabled_subnet(monkeypatch, patch_async_session, db):
    db.add_all([
        Setting(key="setup.complete", value="true"),
        Subnet(cidr="192.168.100.0/24", name="Home LAN"),
        Subnet(cidr="192.168.110.0/24", name="IoT"),
    ])
    await db.commit()

    sched = scheduler_module.ScanScheduler()
    sched._running = True
    scanned = []

    async def fake_planner_scan(subnets):
        scanned.append(subnets)
        sched._running = False

    monkeypatch.setattr(scheduler_module, "run_planner_scan", fake_planner_scan)
    monkeypatch.setattr(scheduler_module, "_get_auto_scan_subnets", lambda: ["10.9.9.0/24"])
    monkeypatch.setattr(scheduler_module.asyncio, "sleep", AsyncMock())

    await sched._quick_loop()
    assert scanned == [["192.168.100.0/24", "192.168.110.0/24"]]


# --- _get_retention_days ----------------------------------------------------

async def test_get_retention_days_from_setting(db):
    db.add(Setting(key="history_retention_days", value="30"))
    await db.commit()
    assert await scheduler_module._get_retention_days(db) == 30


async def test_get_retention_days_invalid_setting_falls_back(monkeypatch, db):
    db.add(Setting(key="history_retention_days", value="oops"))
    await db.commit()

    fake_settings = MagicMock()
    fake_settings.history_retention_days = 90
    monkeypatch.setattr(scheduler_module, "settings", fake_settings)
    assert await scheduler_module._get_retention_days(db) == 90


async def test_get_retention_days_missing_falls_back(monkeypatch, db):
    fake_settings = MagicMock()
    fake_settings.history_retention_days = 90
    monkeypatch.setattr(scheduler_module, "settings", fake_settings)
    assert await scheduler_module._get_retention_days(db) == 90


# --- ScanScheduler basics ---------------------------------------------------

def test_scheduler_global_instance():
    assert isinstance(scheduler_module.scheduler, scheduler_module.ScanScheduler)


async def test_start_and_stop_creates_loops(monkeypatch):
    scheduler_obj = scheduler_module.ScanScheduler()
    created = []

    def fake_create_task(coro):
        task = MagicMock()
        task.cancel = MagicMock()
        created.append(task)
        return task

    monkeypatch.setattr(asyncio, "create_task", fake_create_task)
    monkeypatch.setattr(asyncio, "gather", AsyncMock(return_value=[None]))

    await scheduler_obj.start()
    assert scheduler_obj._running is True
    assert len(created) == 6  # full, quick, ARP, Docker, retention, health probe

    await scheduler_obj.stop()
    assert scheduler_obj._running is False
    assert all(t.cancel.called for t in created)


async def test_start_idempotent(monkeypatch):
    scheduler_obj = scheduler_module.ScanScheduler()
    monkeypatch.setattr(asyncio, "create_task", MagicMock(side_effect=AssertionError("should not run")))

    scheduler_obj._running = True
    await scheduler_obj.start()


async def test_is_setup_complete_true(patch_async_session):
    db = patch_async_session
    db.add(Setting(key="setup.complete", value="true"))
    await db.commit()

    s = scheduler_module.ScanScheduler()
    assert await s._is_setup_complete() is True


async def test_is_setup_complete_false(patch_async_session):
    s = scheduler_module.ScanScheduler()
    assert await s._is_setup_complete() is False


async def test_is_setup_complete_db_error(monkeypatch):
    async def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(scheduler_module.async_session, "__call__", lambda: boom())
    s = scheduler_module.ScanScheduler()
    assert await s._is_setup_complete() is False


# --- _clean_old_history -----------------------------------------------------

async def test_clean_old_history_deletes_expired(patch_async_session, monkeypatch):
    db = patch_async_session
    dev = await _seed_device(db)
    db.add(Setting(key="history_retention_days", value="30"))
    old_ts = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=60)
    db.add(DeviceHistory(device_id=dev.id, timestamp=old_ts, status="offline", message="old"))
    db.add(DeviceMetrics(device_id=dev.id, timestamp=old_ts, cpu_percent=5.0, ram_percent=5.0))
    await db.commit()

    s = scheduler_module.ScanScheduler()
    await s._clean_old_history(force=True)

    assert (await db.execute(select(DeviceHistory))).scalars().all() == []
    assert (await db.execute(select(DeviceMetrics))).scalars().all() == []


async def test_clean_old_history_keeps_recent(patch_async_session):
    db = patch_async_session
    dev = await _seed_device(db)
    db.add(Setting(key="history_retention_days", value="30"))
    db.add(DeviceHistory(device_id=dev.id, timestamp=datetime.now(timezone.utc).replace(tzinfo=None), status="online", message="now"))
    await db.commit()

    s = scheduler_module.ScanScheduler()
    await s._clean_old_history(force=True)

    assert len((await db.execute(select(DeviceHistory))).scalars().all()) == 1


async def test_clean_old_history_rate_limited(patch_async_session):
    db = patch_async_session
    dev = await _seed_device(db)
    db.add(Setting(key="history_retention_days", value="30"))
    db.add(DeviceHistory(device_id=dev.id, timestamp=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=60), status="offline", message="old"))
    await db.commit()

    s = scheduler_module.ScanScheduler()
    s._last_cleanup_time = datetime.now(timezone.utc)
    await s._clean_old_history()

    assert len((await db.execute(select(DeviceHistory))).scalars().all()) == 1


async def test_clean_old_history_invalid_retention_noop(monkeypatch, patch_async_session):
    db = patch_async_session
    await _seed_device(db)
    db.add(Setting(key="history_retention_days", value="9999"))
    await db.commit()

    s = scheduler_module.ScanScheduler()
    await s._clean_old_history(force=True)

    fake_settings = MagicMock()
    fake_settings.history_retention_days = 90
    monkeypatch.setattr(scheduler_module, "settings", fake_settings)

    setting = (await db.execute(select(Setting).where(Setting.key == "history_retention_days"))).scalar_one()
    setting.value = "oops"
    await db.commit()
    await s._clean_old_history(force=True)


# --- _retention_loop --------------------------------------------------------

async def _run_retention_loop_once(s, monkeypatch):
    """Run one iteration of _retention_loop; the first sleep stops the loop."""
    sleeps = []

    async def stop_after_first_sleep(seconds):
        sleeps.append(seconds)
        s._running = False

    monkeypatch.setattr(scheduler_module.asyncio, "sleep", stop_after_first_sleep)
    s._running = True
    await s._retention_loop()
    return sleeps


async def test_retention_loop_prunes_metrics_regardless_of_scan_interval(patch_async_session, monkeypatch):
    """Pruning used to run only inside the full-scan loop, i.e. once per scan interval (here: a week)."""
    db = patch_async_session
    dev = await _seed_device(db)
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="scan_interval", value="10080"))
    db.add(Setting(key="history_retention_days", value="7"))
    old_ts = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=8)
    new_ts = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
    db.add_all([
        DeviceHistory(device_id=dev.id, timestamp=old_ts, status="offline", message="old"),
        DeviceHistory(device_id=dev.id, timestamp=new_ts, status="online", message="new"),
        DeviceMetrics(device_id=dev.id, timestamp=old_ts, cpu_percent=90.0, ram_percent=5.0),
        DeviceMetrics(device_id=dev.id, timestamp=new_ts, cpu_percent=10.0, ram_percent=5.0),
    ])
    await db.commit()

    s = scheduler_module.ScanScheduler()
    sleeps = await _run_retention_loop_once(s, monkeypatch)

    assert sleeps == [scheduler_module.RETENTION_CHECK_SECONDS]
    assert [h.message for h in (await db.execute(select(DeviceHistory))).scalars().all()] == ["new"]
    assert [m.cpu_percent for m in (await db.execute(select(DeviceMetrics))).scalars().all()] == [10.0]


async def test_retention_loop_waits_for_setup(patch_async_session, monkeypatch):
    s = scheduler_module.ScanScheduler()
    clean = AsyncMock()
    monkeypatch.setattr(s, "_clean_old_history", clean)

    await _run_retention_loop_once(s, monkeypatch)

    clean.assert_not_called()


async def test_full_scan_loop_no_longer_prunes(patch_async_session, monkeypatch):
    db = patch_async_session
    db.add(Setting(key="setup.complete", value="true"))
    await db.commit()

    s = scheduler_module.ScanScheduler()
    clean = AsyncMock()
    monkeypatch.setattr(s, "_clean_old_history", clean)

    async def stop(seconds):
        s._running = False

    monkeypatch.setattr(scheduler_module.asyncio, "sleep", stop)
    s._running = True
    await s._loop()

    clean.assert_not_called()


def test_agent_api_has_no_dead_metrics_cap():
    """MAX_METRICS_PER_DEVICE was never enforced; retention is history_retention_days only."""
    import app.api.agent as agent_api
    assert not hasattr(agent_api, "MAX_METRICS_PER_DEVICE")
