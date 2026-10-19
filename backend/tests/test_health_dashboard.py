"""Tests for the Health Dashboard API and probe engine (app/api/health.py)."""

from datetime import UTC, datetime, timedelta

import pytest
from app.models.device import Device, DeviceHealthSample, DeviceHistory, Service
from app.scanner.health_probe import run_health_probe_pass
from sqlalchemy import select


@pytest.mark.asyncio
async def test_health_overview_empty_db(client, admin_token):
    """Calling overview on empty inventory returns 100 score and empty lists."""
    response = await client.get("/api/health/overview", headers={"Authorization": f"Bearer {admin_token}"})
    assert response.status_code == 200
    data = response.json()
    assert data["kpis"]["network_health_score"] == 100
    assert data["kpis"]["total_devices"] == 0
    assert data["devices"] == []
    assert data["recent_incidents"] == []


@pytest.mark.asyncio
async def test_health_overview_populated(client, db, admin_token):
    """Overview aggregates device telemetry, latency sparklines, heartbeat bars, and incidents."""
    now = datetime.now(UTC)
    dev1 = Device(ip="192.168.1.10", display_name="Router", device_type="router", is_online=True)
    dev2 = Device(ip="192.168.1.20", display_name="Flapping AP", device_type="ap", is_online=True, missed_scans=2)
    dev3 = Device(ip="192.168.1.30", display_name="Offline Host", device_type="server", is_online=False)

    db.add_all([dev1, dev2, dev3])
    await db.commit()

    # Add services
    svc1 = Service(device_id=dev1.id, name="Web Admin", protocol="https", port=443, is_up=True, latency_ms=4.2, ssl_expiry_days=9)
    db.add(svc1)

    # Add samples
    for i in range(5):
        sample_time = (now - timedelta(minutes=i * 10)).replace(tzinfo=None)
        db.add(DeviceHealthSample(
            device_id=dev1.id,
            timestamp=sample_time,
            is_online=True,
            latency_ms=3.0 + i,
            probe_type="icmp",
            ports_up=1,
            ports_total=1
        ))
    
    # Add incidents
    db.add(DeviceHistory(
        device_id=dev3.id,
        status="offline",
        message="Device went offline",
        timestamp=(now - timedelta(hours=2)).replace(tzinfo=None)
    ))
    await db.commit()

    # Call endpoint
    response = await client.get("/api/health/overview?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert response.status_code == 200
    data = response.json()

    kpis = data["kpis"]
    assert kpis["total_devices"] == 3
    assert kpis["online_devices"] == 2
    assert kpis["offline_devices"] == 1
    assert kpis["flapping_devices"] == 1
    assert kpis["ssl_warning_count"] == 1

    devices = {d["ip"]: d for d in data["devices"]}
    r_item = devices["192.168.1.10"]
    assert r_item["is_online"] is True
    assert r_item["health_status"] in ("healthy", "degraded")
    assert r_item["latency"]["min_ms"] == 3.0
    assert r_item["latency"]["max_ms"] == 7.0
    assert len(r_item["latency"]["sparkline"]) > 0
    assert len(r_item["uptime"]["history_bars"]) == 24

    f_item = devices["192.168.1.20"]
    assert f_item["health_status"] == "flapping"

    o_item = devices["192.168.1.30"]
    assert o_item["health_status"] == "offline"
    assert o_item["health_score"] == 0

    assert len(data["recent_incidents"]) >= 1
    assert data["recent_incidents"][0]["status"] == "offline"


@pytest.mark.asyncio
async def test_device_health_detail(client, db, admin_token):
    """Device detail endpoint returns full timeseries and incidents for that device."""
    now = datetime.now(UTC)
    dev = Device(ip="192.168.1.15", display_name="NAS", device_type="nas", is_online=True)
    db.add(dev)
    await db.commit()

    sample = DeviceHealthSample(
        device_id=dev.id,
        timestamp=now.replace(tzinfo=None),
        is_online=True,
        latency_ms=1.5,
        probe_type="icmp"
    )
    db.add(sample)
    await db.commit()

    response = await client.get(f"/api/health/device/{dev.id}?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert response.status_code == 200
    detail = response.json()
    assert detail["device"]["id"] == dev.id
    assert len(detail["time_series"]) == 1
    assert detail["time_series"][0]["latency_ms"] == 1.5


@pytest.mark.asyncio
async def test_ui_start_page_setting_validation(client, admin_token):
    """Settings validator rejects invalid start pages and accepts '/' and '/health'."""
    # 1. Valid settings
    res = await client.post("/api/settings", json={"ui.start_page": "/health"}, headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200

    res = await client.get("/api/settings", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.json()["ui.start_page"] == "/health"

    res = await client.post("/api/settings", json={"ui.start_page": "/"}, headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200

    # 2. Invalid start page
    res_bad = await client.post("/api/settings", json={"ui.start_page": "/evil"}, headers={"Authorization": f"Bearer {admin_token}"})
    assert res_bad.status_code == 400
    assert "Invalid start page" in res_bad.json()["detail"]


@pytest.mark.asyncio
async def test_health_probe_pass_execution(monkeypatch, db):
    """run_health_probe_pass probes devices and writes DeviceHealthSample rows."""
    from contextlib import asynccontextmanager

    from app.scanner import health_probe as hp_mod

    @asynccontextmanager
    async def fake_session():
        yield db

    monkeypatch.setattr(hp_mod, "async_session", fake_session)

    dev = Device(ip="192.168.1.99", display_name="Test Host", is_online=True)
    db.add(dev)
    await db.commit()

    # Mock ping to return 5.5ms
    async def fake_ping(ip, timeout):
        return 5.5

    monkeypatch.setattr(hp_mod, "measure_ping_latency_ms", fake_ping)

    count = await run_health_probe_pass()
    assert count >= 1

    samples = (await db.execute(select(DeviceHealthSample).where(DeviceHealthSample.device_id == dev.id))).scalars().all()
    assert len(samples) >= 1
    assert samples[0].latency_ms == 5.5
    assert samples[0].probe_type == "icmp"
    assert samples[0].is_online is True


@pytest.mark.asyncio
async def test_health_probe_ssl_cache_honors_6h_ttl(monkeypatch, db):
    """SSL expiry check runs once and is cached for 6 hours without resetting ssl_checked_at on every pass."""
    from contextlib import asynccontextmanager

    from app.scanner import health_probe as hp_mod

    @asynccontextmanager
    async def fake_session():
        yield db

    monkeypatch.setattr(hp_mod, "async_session", fake_session)

    dev = Device(ip="192.168.1.101", display_name="TLS Host", is_online=True)
    db.add(dev)
    await db.commit()

    svc = Service(device_id=dev.id, name="HTTPS", protocol="https", port=443, is_up=True)
    db.add(svc)
    await db.commit()

    ssl_calls = 0

    async def fake_ping(ip, timeout):
        return 2.0

    async def fake_tcp(ip, port, timeout):
        return 3.1

    async def fake_ssl(ip, port, hostname, timeout):
        nonlocal ssl_calls
        ssl_calls += 1
        return 30

    monkeypatch.setattr(hp_mod, "measure_ping_latency_ms", fake_ping)
    monkeypatch.setattr(hp_mod, "measure_tcp_latency_ms", fake_tcp)
    monkeypatch.setattr(hp_mod, "check_ssl_expiry_days", fake_ssl)

    # First pass: SSL check must run
    await run_health_probe_pass()
    await db.refresh(svc)
    assert ssl_calls == 1
    assert svc.ssl_expiry_days == 30
    first_checked_at = svc.ssl_checked_at
    assert first_checked_at is not None

    # Second pass immediately after: SSL check must be skipped and ssl_checked_at must NOT be overwritten
    await run_health_probe_pass()
    await db.refresh(svc)
    assert ssl_calls == 1
    assert svc.ssl_checked_at == first_checked_at


@pytest.mark.asyncio
async def test_health_overview_excludes_hidden_device_incidents(client, db, admin_token):
    """Incidents belonging to hidden devices must not appear in recent_incidents."""
    now = datetime.now(UTC)
    visible_dev = Device(ip="192.168.1.11", display_name="Visible", is_online=True, is_hidden=False)
    hidden_dev = Device(ip="192.168.1.12", display_name="Hidden", is_online=False, is_hidden=True)
    db.add_all([visible_dev, hidden_dev])
    await db.commit()

    db.add(DeviceHistory(
        device_id=hidden_dev.id,
        status="offline",
        message="Hidden device went offline",
        timestamp=now.replace(tzinfo=None),
    ))
    await db.commit()

    res = await client.get("/api/health/overview?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    data = res.json()
    incident_device_ids = [inc["device_id"] for inc in data["recent_incidents"]]
    assert hidden_dev.id not in incident_device_ids


@pytest.mark.asyncio
async def test_service_ignore_ssl_suppresses_warning_and_penalty(client, db, admin_token):
    """When a service has ignore_ssl=True, expired SSL certs do not drop score or trigger warning count."""
    dev = Device(ip="192.168.1.55", display_name="Synology NAS", device_type="nas", is_online=True)
    db.add(dev)
    await db.commit()

    # Service with expired cert (0 days left) but ignore_ssl=True
    svc = Service(
        device_id=dev.id,
        name="DSM Admin",
        protocol="https",
        port=5001,
        is_up=True,
        latency_ms=2.5,
        ssl_expiry_days=0,
        ignore_ssl=True
    )
    db.add(svc)
    await db.commit()

    res = await client.get("/api/health/overview?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    data = res.json()

    assert data["kpis"]["ssl_warning_count"] == 0
    dev_item = next(d for d in data["devices"] if d["id"] == dev.id)
    # Healthy because SSL penalty of 15 was skipped!
    assert dev_item["health_score"] == 100
    assert dev_item["health_status"] == "healthy"
    assert dev_item["services"][0]["ignore_ssl"] is True

    # Test detail endpoint
    res_det = await client.get(f"/api/health/device/{dev.id}?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert res_det.status_code == 200
    det_data = res_det.json()
    assert det_data["device"]["services"][0]["ignore_ssl"] is True
    assert det_data["device"]["health_score"] == 100


@pytest.mark.asyncio
async def test_alert_offline_device_standby_and_suppression(client, db, admin_token):
    """Devices marked alert_offline=False get status 'standby', score 100 when offline, and no offline incidents."""
    now = datetime.now(UTC)
    # Sleeper PC / TV (not 24/7)
    pc = Device(
        ip="192.168.1.77",
        display_name="Gaming PC",
        device_type="desktop",
        is_online=False,
        alert_offline=False
    )
    # 24/7 Server
    srv = Device(
        ip="192.168.1.88",
        display_name="Home Server",
        device_type="server",
        is_online=False,
        alert_offline=True
    )
    db.add_all([pc, srv])
    await db.commit()

    # Add offline incidents for both
    db.add_all([
        DeviceHistory(
            device_id=pc.id,
            status="offline",
            message="Device went offline",
            timestamp=now.replace(tzinfo=None)
        ),
        DeviceHistory(
            device_id=srv.id,
            status="offline",
            message="Device went offline",
            timestamp=now.replace(tzinfo=None)
        ),
    ])
    await db.commit()

    # 1. Overview check
    res = await client.get("/api/health/overview?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    data = res.json()

    # Only server should count towards offline_devices KPI
    assert data["kpis"]["offline_devices"] == 1

    devices = {d["id"]: d for d in data["devices"]}
    pc_data = devices[pc.id]
    assert pc_data["alert_offline"] is False
    assert pc_data["health_status"] == "standby"
    assert pc_data["health_score"] == 100

    srv_data = devices[srv.id]
    assert srv_data["alert_offline"] is True
    assert srv_data["health_status"] == "offline"
    assert srv_data["health_score"] == 0

    # The PC's offline incident must be suppressed from recent_incidents
    incident_dev_ids = [inc["device_id"] for inc in data["recent_incidents"]]
    assert pc.id not in incident_dev_ids
    assert srv.id in incident_dev_ids

    # 2. Detail check for PC
    res_det = await client.get(f"/api/health/device/{pc.id}?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert res_det.status_code == 200
    det = res_det.json()
    assert det["device"]["alert_offline"] is False
    assert det["device"]["health_status"] == "standby"
    assert len(det["incidents"]) == 0

    # 3. Update alert_offline via PATCH /api/devices/{id}
    res_up = await client.patch(
        f"/api/devices/{pc.id}",
        json={"alert_offline": True},
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert res_up.status_code == 200
    assert res_up.json()["alert_offline"] is True


@pytest.mark.asyncio
async def test_non_24_7_device_with_offline_services_stays_standby_and_does_not_lower_network_score(client, db, admin_token):
    """A client device (TV/PC) with alert_offline=False whose services are unreachable is standby, not critical."""
    tv = Device(
        ip="192.168.100.49",
        display_name="LGwebOSTV",
        device_type="tv",
        is_online=True,
        alert_offline=False,
    )
    db.add(tv)
    await db.commit()

    # Add 4 closed services (e.g. TV in standby)
    for port in [80, 8080, 3000, 3001]:
        db.add(Service(
            device_id=tv.id,
            name=f"TV Service {port}",
            protocol="tcp",
            port=port,
            is_up=False,
        ))
    await db.commit()

    res = await client.get("/api/health/overview?period=24h", headers={"Authorization": f"Bearer {admin_token}"})
    assert res.status_code == 200
    data = res.json()

    assert data["kpis"]["active_issues_count"] == 0
    assert data["kpis"]["network_health_score"] == 100

    tv_data = next(d for d in data["devices"] if d["id"] == tv.id)
    assert tv_data["health_status"] == "standby"
    assert tv_data["health_score"] == 100


