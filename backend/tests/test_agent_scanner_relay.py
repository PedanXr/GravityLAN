"""Tests for Agent L2 Scanner Relay."""

import logging
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.models.device import Device, DiscoveredHost
from app.models.agent import AgentConfig, AgentToken
from app.models.network import Subnet
from app.models.setting import Setting
from app.services.agent_scanner_relay import ingest_agent_arp_table

PROBE_TOKEN = "probe-token-123"


async def _add_probe(db, relay=True, cidrs=("192.168.110.0/24",), ip="192.168.110.128"):
    """Add an agent device acting as L2 probe; ``relay=None`` leaves out its AgentConfig."""
    dev = Device(ip=ip, display_name="IoT Gateway", device_type="server", is_online=True)
    db.add(dev)
    await db.flush()
    db.add(AgentToken(device_id=dev.id, token=PROBE_TOKEN, is_active=True))
    if relay is not None:
        db.add(AgentConfig(device_id=dev.id, enable_scanner_relay=relay))
    db.add_all([Subnet(name=cidr, cidr=cidr, is_enabled=True) for cidr in cidrs])
    await db.commit()
    return dev


async def _add_known_device(db, ip):
    """Add an offline inventory device whose MAC an agent must not overwrite."""
    dev = Device(ip=ip, display_name="NAS", device_type="nas", mac="AA:BB:CC:DD:EE:FF", is_online=False)
    db.add(dev)
    await db.commit()
    return dev


async def _assert_untouched(db, dev):
    await db.refresh(dev)
    assert dev.mac == "AA:BB:CC:DD:EE:FF"
    assert dev.vendor is None
    assert dev.is_online is False


@pytest.mark.asyncio
async def test_ingest_agent_arp_table_updates_devices_and_discovered(db):
    probe = await _add_probe(db)

    # 1. Existing device without MAC
    dev = Device(ip="192.168.110.10", display_name="Smart Plug", device_type="unknown", is_online=False)
    db.add(dev)
    await db.commit()
    await db.refresh(dev)

    arp_data = [
        {"ip": "192.168.110.10", "mac": "00:11:32:aa:bb:cc", "interface": "eth0"},
        {"ip": "192.168.110.20", "mac": "b8:27:eb:11:22:33", "interface": "eth0"},
        {"ip": "192.168.110.99", "mac": "00:00:00:00:00:00", "interface": "eth0"}, # invalid, should be skipped
        {"ip": "invalid-ip", "mac": "00:11:22:33:44:55", "interface": "eth0"},      # invalid, should be skipped
    ]

    count = await ingest_agent_arp_table(db, reporting_device_id=probe.id, arp_entries=arp_data)
    assert count == 2

    # Check updated device
    await db.refresh(dev)
    assert dev.mac == "00:11:32:AA:BB:CC"
    assert dev.is_online is True
    assert dev.vendor == "Synology Inc."

    # Check newly created DiscoveredHost
    disc = (await db.execute(select(DiscoveredHost).where(DiscoveredHost.ip == "192.168.110.20"))).scalar_one()
    assert disc.mac == "B8:27:EB:11:22:33"
    assert disc.vendor == "Raspberry Pi Foundation"
    assert disc.is_online is True


@pytest.mark.asyncio
@pytest.mark.parametrize("relay", [False, None], ids=["relay-off", "no-agent-config"])
async def test_ingest_ignored_when_relay_disabled(db, relay):
    probe = await _add_probe(db, relay=relay)
    known = await _add_known_device(db, "192.168.110.10")

    count = await ingest_agent_arp_table(db, probe.id, [
        {"ip": "192.168.110.10", "mac": "00:11:32:aa:bb:cc"},
        {"ip": "192.168.110.20", "mac": "b8:27:eb:11:22:33"},
    ])

    assert count == 0
    await _assert_untouched(db, known)
    assert (await db.execute(select(DiscoveredHost))).scalars().all() == []


@pytest.mark.asyncio
async def test_ingest_ignores_entries_outside_probe_subnets(db, caplog):
    probe = await _add_probe(db, cidrs=("192.168.110.0/24", "192.168.1.0/24"))
    other_subnet_device = await _add_known_device(db, "192.168.1.10")

    with caplog.at_level(logging.DEBUG, logger="app.services.agent_scanner_relay"):
        count = await ingest_agent_arp_table(db, probe.id, [
            {"ip": "192.168.1.10", "mac": "00:11:32:aa:bb:cc"},    # configured subnet, but not the probe's
            {"ip": "172.17.0.2", "mac": "02:42:ac:11:00:02"},      # not configured at all (e.g. Docker bridge)
            {"ip": "192.168.110.20", "mac": "b8:27:eb:11:22:33"},  # the probe's own subnet
        ])

    assert count == 1
    await _assert_untouched(db, other_subnet_device)
    discovered = (await db.execute(select(DiscoveredHost.ip))).scalars().all()
    assert discovered == ["192.168.110.20"]
    assert "192.168.1.10" in caplog.text and "172.17.0.2" in caplog.text


@pytest.mark.asyncio
async def test_ingest_ignored_when_no_subnet_contains_probe(db):
    probe = await _add_probe(db, cidrs=("192.168.1.0/24",))

    count = await ingest_agent_arp_table(db, probe.id, [
        {"ip": "192.168.110.20", "mac": "b8:27:eb:11:22:33"},
    ])

    assert count == 0
    assert (await db.execute(select(DiscoveredHost))).scalars().all() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "relay, expected_mac",
    [(True, "00:11:32:AA:BB:CC"), (False, "AA:BB:CC:DD:EE:FF")],
    ids=["relay-on", "relay-off"],
)
async def test_report_endpoint_ingests_arp_table_only_with_relay(client, db, relay, expected_mac):
    db.add(Setting(key="setup.complete", value="true"))
    probe = await _add_probe(db, relay=relay)
    known = await _add_known_device(db, "192.168.110.10")

    payload = {
        "device_id": probe.id,
        "agent_version": "0.3.9",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 5.0,
        "ram": {"total_mb": 1024, "used_mb": 512, "percent": 50.0},
        "arp_table": [{"ip": "192.168.110.10", "mac": "00:11:32:aa:bb:cc", "interface": "eth0"}],
    }
    response = await client.post(
        "/api/agent/report", json=payload, headers={"Authorization": f"Bearer {PROBE_TOKEN}"}
    )

    assert response.status_code == 200
    await db.refresh(known)
    assert known.mac == expected_mac


@pytest.mark.asyncio
async def test_network_subnets_detects_agent_probe(client, db, admin_token, monkeypatch):
    monkeypatch.setattr("app.scanner.utils.get_local_subnets", lambda: [])

    # Setup a device with agent in subnet 192.168.110.0/24
    dev = Device(ip="192.168.110.128", display_name="IoT Gateway", device_type="server", is_online=True)
    db.add(dev)
    await db.flush()

    token = AgentToken(device_id=dev.id, token="token-123", is_active=True)
    cfg = AgentConfig(device_id=dev.id, enable_scanner_relay=True)
    sub = Subnet(name="IoT Subnet", cidr="192.168.110.0/24", is_enabled=True)
    db.add_all([token, cfg, sub])
    await db.commit()

    headers = {"Authorization": f"Bearer {admin_token}"}
    response = await client.get("/api/network/subnets", headers=headers)
    assert response.status_code == 200
    data = response.json()

    iot_sub = next(s for s in data if s["cidr"] == "192.168.110.0/24")
    assert iot_sub["is_direct_l2"] is False
    assert iot_sub["is_agent_probe"] is True
    assert iot_sub["probe_device_name"] == "IoT Gateway"
    assert iot_sub["probe_device_ip"] == "192.168.110.128"
