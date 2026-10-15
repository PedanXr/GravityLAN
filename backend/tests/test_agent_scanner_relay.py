"""Tests for Agent L2 Scanner Relay."""

import pytest
from sqlalchemy import select

from app.models.device import Device, DiscoveredHost
from app.models.agent import AgentConfig, AgentToken
from app.models.network import Subnet
from app.services.agent_scanner_relay import ingest_agent_arp_table


@pytest.mark.asyncio
async def test_ingest_agent_arp_table_updates_devices_and_discovered(db):
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

    count = await ingest_agent_arp_table(db, reporting_device_id=999, arp_entries=arp_data)
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
