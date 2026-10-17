"""The Subnet table as the only source of scan subnets (#18).

Covers which subnets get scanned, the start-up migration of the legacy
``scan_subnets`` setting, and every writer of the table: settings API,
network API and setup wizard.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

import app.database as database_module
from app.api import scanner as scanner_api
from app.main import _migrate_legacy_scan_subnets
from app.models.network import Subnet
from app.models.setting import Setting
from app.schemas.network import normalize_cidr, validate_scan_cidr
from app.schemas.scan import ScanRequest, SubnetInfo
from app.scanner.subnets import find_subnet, get_enabled_subnets, get_scan_subnets, merge_subnets


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


async def _subnets(db) -> dict[str, bool]:
    """cidr -> is_enabled of every row, read fresh from the database."""
    db.expire_all()
    rows = (await db.execute(select(Subnet).order_by(Subnet.id))).scalars().all()
    return {row.cidr: row.is_enabled for row in rows}


async def _setting(db, key):
    return (await db.execute(select(Setting).where(Setting.key == key))).scalar_one_or_none()


@pytest.fixture
def route_sessions(monkeypatch, db):
    """Point async_session() of the app and the scanner API at the test database."""
    @asynccontextmanager
    async def fake_session():
        yield db
    monkeypatch.setattr(database_module, "async_session", fake_session)
    monkeypatch.setattr(scanner_api, "async_session", fake_session)
    # The scan job state is module-global; every test gets a fresh one
    monkeypatch.setattr(scanner_api, "state", scanner_api.ScanStateManager())
    return db


# --- normalize_cidr / validate_scan_cidr -------------------------------------

@pytest.mark.parametrize("raw, expected", [
    ("192.168.110.0/24", "192.168.110.0/24"),
    (" 192.168.110 ", "192.168.110.0/24"),
    ("192.168.110.5/24", "192.168.110.0/24"),
    ("192.168.110.5", "192.168.110.5/32"),
])
def test_normalize_cidr(raw, expected):
    assert normalize_cidr(raw) == expected


@pytest.mark.parametrize("raw", ["", "garbage", "999.1.1.0/24", "fd00::/64"])
def test_normalize_cidr_rejects_non_ipv4(raw):
    with pytest.raises(ValueError):
        normalize_cidr(raw)


def test_validate_scan_cidr_rejects_huge_networks():
    assert validate_scan_cidr("10.20.0.0/16") == "10.20.0.0/16"
    with pytest.raises(ValueError, match="too large"):
        validate_scan_cidr("10.0.0.0/8")


# --- what gets scanned -------------------------------------------------------

async def test_enabled_subnets_are_scanned_in_creation_order(db):
    db.add_all([
        Subnet(cidr="192.168.110.0/24", name="IoT"),
        Subnet(cidr="192.168.100.0/24", name="Home LAN"),
        Subnet(cidr="192.168.120.0/24", name="Guests", is_enabled=False),
        Subnet(cidr="not-a-net", name="Broken"),
    ])
    await db.commit()

    assert await get_enabled_subnets(db) == ["192.168.110.0/24", "192.168.100.0/24"]


async def test_scan_subnets_fall_back_to_local_interfaces_only_without_enabled_rows(monkeypatch, db):
    monkeypatch.setattr("app.scanner.utils.get_auto_scan_subnets", lambda: ["192.168.100.0/24"])
    assert await get_scan_subnets(db) == ["192.168.100.0/24"]

    db.add(Subnet(cidr="192.168.110.0/24", name="IoT"))
    await db.commit()
    # A subnet added in the overview is scanned; the container's own interface is no longer implied
    assert await get_scan_subnets(db) == ["192.168.110.0/24"]


async def test_legacy_setting_is_not_a_scan_source(monkeypatch, db):
    monkeypatch.setattr("app.scanner.utils.get_auto_scan_subnets", lambda: [])
    db.add(Setting(key="scan_subnets", value="192.168.110.0/24"))
    await db.commit()
    assert await get_scan_subnets(db) == []


async def test_dashboard_scan_without_subnets_uses_enabled_rows(route_sessions, db):
    db.add_all([Subnet(cidr="192.168.100.0/24", name="Home LAN"), Subnet(cidr="192.168.110.0/24", name="IoT")])
    await db.commit()

    with patch.object(scanner_api, "run_dashboard_scan", AsyncMock(return_value=0)) as scan:
        res = await scanner_api.start_dashboard_scan_api(ScanRequest(), background_tasks=None)
        assert res["status"] == "ok"
        await scanner_api.state.task

    scan.assert_awaited_once()
    assert scan.await_args.args[0] == ["192.168.100.0/24", "192.168.110.0/24"]


async def test_planner_scan_keeps_explicit_subnets(route_sessions, db):
    db.add(Subnet(cidr="192.168.100.0/24", name="Home LAN"))
    await db.commit()

    with patch.object(scanner_api, "run_planner_scan", AsyncMock(return_value=0)) as scan:
        await scanner_api.start_scan(ScanRequest(subnets=["10.1.1.0/24"]))
        await scanner_api.state.task

    assert scan.await_args.args[0] == ["10.1.1.0/24"]


# --- merge_subnets / find_subnet ----------------------------------------------

async def test_merge_adds_missing_and_skips_equal_networks(db):
    db.add(Subnet(cidr="192.168.100.0/24", name="Home LAN"))
    await db.commit()

    added = await merge_subnets(
        db, ["192.168.100", "192.168.110.0/24", "192.168.110.7/24", "garbage"], names={"192.168.110.0/24": "IoT"}
    )
    await db.commit()

    assert added == ["192.168.110.0/24"]
    rows = (await db.execute(select(Subnet).order_by(Subnet.id))).scalars().all()
    assert [(r.cidr, r.name) for r in rows] == [("192.168.100.0/24", "Home LAN"), ("192.168.110.0/24", "IoT")]


async def test_merge_only_re_enables_when_asked(db):
    db.add(Subnet(cidr="192.168.110.0/24", name="IoT", is_enabled=False))
    await db.commit()

    await merge_subnets(db, ["192.168.110.0/24"])
    assert await _subnets(db) == {"192.168.110.0/24": False}

    await merge_subnets(db, ["192.168.110.0/24"], enable_existing=True)
    await db.commit()
    assert await _subnets(db) == {"192.168.110.0/24": True}


async def test_find_subnet_compares_canonical_forms(db):
    row = Subnet(cidr="192.168.110.0/24", name="IoT")
    db.add(row)
    await db.commit()

    assert (await find_subnet(db, "192.168.110")).id == row.id
    assert await find_subnet(db, "192.168.110.0/24", exclude_id=row.id) is None
    assert await find_subnet(db, "garbage") is None


# --- start-up migration of the legacy setting ---------------------------------

async def test_migration_merges_into_a_filled_table_and_drops_the_setting(route_sessions, db):
    # The situation from #18: the overview knows the IoT net, only the setting lists both
    db.add_all([
        Subnet(cidr="192.168.110.0/24", name="IoT"),
        Subnet(cidr="192.168.120.0/24", name="Guests", is_enabled=False),
        Setting(key="scan_subnets", value="192.168.100.0/24, 192.168.110.0/24, 192.168.120.0/24, bogus"),
    ])
    await db.commit()

    await _migrate_legacy_scan_subnets()

    assert await _subnets(db) == {
        "192.168.110.0/24": True,
        "192.168.120.0/24": True,  # was scanned through the setting, so it stays scanned
        "192.168.100.0/24": True,
    }
    assert await _setting(db, "scan_subnets") is None


async def test_migration_runs_once_so_deleted_subnets_stay_deleted(route_sessions, db):
    db.add(Setting(key="scan_subnets", value="192.168.100.0/24"))
    await db.commit()
    await _migrate_legacy_scan_subnets()

    row = (await db.execute(select(Subnet))).scalar_one()
    await db.delete(row)
    await db.commit()

    await _migrate_legacy_scan_subnets()
    assert await _subnets(db) == {}


async def test_migration_drops_an_empty_setting(route_sessions, db):
    db.add_all([Subnet(cidr="192.168.100.0/24", name="Home LAN"), Setting(key="scan_subnets", value="")])
    await db.commit()

    await _migrate_legacy_scan_subnets()

    assert await _subnets(db) == {"192.168.100.0/24": True}
    assert await _setting(db, "scan_subnets") is None


# --- writers: settings API, network API, setup wizard ---------------------------

async def test_settings_api_writes_scan_subnets_into_the_table(client, db, admin_token):
    db.add(Subnet(cidr="192.168.100.0/24", name="Home LAN"))
    await db.commit()

    res = await client.post(
        "/api/settings",
        json={"scan_subnets": "192.168.100.0/24, 192.168.110.0/24", "scan_interval": "15"},
        headers=_headers(admin_token),
    )
    assert res.status_code == 200

    assert await _subnets(db) == {"192.168.100.0/24": True, "192.168.110.0/24": True}
    assert await _setting(db, "scan_subnets") is None
    assert (await _setting(db, "scan_interval")).value == "15"
    assert "scan_subnets" not in (await client.get("/api/settings", headers=_headers(admin_token))).json()


async def test_settings_api_still_rejects_invalid_scan_subnets(client, db, admin_token):
    res = await client.post("/api/settings", json={"scan_subnets": "192.168.1.0/24, nope"}, headers=_headers(admin_token))
    assert res.status_code == 400
    assert await _subnets(db) == {}


async def test_network_api_normalizes_and_names_new_subnets(client, db, admin_token):
    res = await client.post("/api/network/subnets", json={"cidr": "192.168.110.7/24"}, headers=_headers(admin_token))
    assert res.status_code == 200
    body = res.json()
    assert body["cidr"] == "192.168.110.0/24"
    assert body["name"] == "Network 192.168.110.0/24"
    assert body["is_enabled"] is True


@pytest.mark.parametrize("cidr", ["garbage", "10.0.0.0/8", "fd00::/64"])
async def test_network_api_rejects_unscannable_subnets(client, db, admin_token, cidr):
    res = await client.post("/api/network/subnets", json={"cidr": cidr, "name": "X"}, headers=_headers(admin_token))
    assert res.status_code == 422
    assert await _subnets(db) == {}


async def test_network_api_rejects_duplicates_with_409(client, db, admin_token):
    headers = _headers(admin_token)
    first = await client.post("/api/network/subnets", json={"cidr": "192.168.110.0/24", "name": "IoT"}, headers=headers)
    other = await client.post("/api/network/subnets", json={"cidr": "192.168.120.0/24", "name": "Guests"}, headers=headers)
    assert first.status_code == other.status_code == 200

    dup = await client.post("/api/network/subnets", json={"cidr": "192.168.110", "name": "Again"}, headers=headers)
    assert dup.status_code == 409

    other_url = f"/api/network/subnets/{other.json()['id']}"
    clash = await client.patch(other_url, json={"cidr": "192.168.110.0/24"}, headers=headers)
    assert clash.status_code == 409

    paused = await client.patch(other_url, json={"is_enabled": False}, headers=headers)
    assert paused.status_code == 200
    assert paused.json()["is_enabled"] is False


LOCAL = [
    SubnetInfo(interface_name="eth0", ip_address="192.168.100.20", subnet="192.168.100.0/24", netmask="255.255.255.0"),
    SubnetInfo(
        interface_name="docker0", ip_address="172.17.0.1", subnet="172.17.0.0/16", netmask="255.255.0.0", is_virtual=True
    ),
]


async def test_setup_registers_scanned_subnets_even_without_hosts(monkeypatch, client, db):
    monkeypatch.setattr("app.scanner.utils.get_local_subnets", lambda: LOCAL)

    res = await client.post(
        "/api/setup/complete",
        json={"admin_password": "supersecretpassword123", "subnets": ["192.168.100.0/24", "192.168.110.0/24"]},
    )
    assert res.status_code == 200

    rows = (await db.execute(select(Subnet).order_by(Subnet.id))).scalars().all()
    assert [(r.cidr, r.name, r.is_enabled) for r in rows] == [
        ("192.168.100.0/24", "eth0", True),
        ("192.168.110.0/24", "Network 192.168.110.0/24", True),
    ]


async def test_setup_without_scan_registers_physical_subnets(monkeypatch, client, db):
    monkeypatch.setattr("app.scanner.utils.get_local_subnets", lambda: LOCAL)

    res = await client.post("/api/setup/complete", json={"admin_password": "supersecretpassword123"})
    assert res.status_code == 200

    assert await _subnets(db) == {"192.168.100.0/24": True}
