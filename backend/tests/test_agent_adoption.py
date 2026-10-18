import pytest
from datetime import datetime, timezone, timedelta
from app.models.setting import Setting
from app.models.device import Device
from app.models.agent import AgentToken
from app.services.agent_tokens import hash_agent_token
from app.version import normalize_version
from app.scanner.utils import ensure_utc

@pytest.fixture(autouse=True)
def clear_setting_cache():
    from app.api.agent import _setting_cache, _setting_cache_time
    _setting_cache.clear()
    # Reset the cache time to minimum
    from datetime import datetime, timezone
    _setting_cache_time = datetime.min.replace(tzinfo=timezone.utc)

def test_version_normalization():
    """Verify that normalize_version handles various input styles correctly."""
    assert normalize_version("v0.2.5") == "0.2.5"
    assert normalize_version("0.2.5") == "0.2.5"
    assert normalize_version("  v0.2.5  ") == "0.2.5"
    assert normalize_version("V1.0.0") == "1.0.0"
    assert normalize_version(None) is None
    assert normalize_version("") is None

@pytest.mark.asyncio
async def test_agent_reporting_clears_pending_token(client, db):
    """Test that a successful report using a valid active token clears any pending token."""
    # 1. Setup DB state
    db.add(Setting(key="setup.complete", value="true"))
    
    device = Device(
        id=10,
        ip="192.168.1.100",
        display_name="Test Device",
        is_online=True,
        has_agent=True
    )
    db.add(device)
    
    active_token = "valid-active-token"
    agent_token = AgentToken(
        device_id=10,
        token=active_token,
        is_active=True,
        pending_token="stale-pending-token",
        pending_at=datetime.now(timezone.utc) - timedelta(minutes=10)
    )
    db.add(agent_token)
    await db.commit()

    # 2. Send report with the valid active token
    payload = {
        "device_id": 10,
        "agent_version": "0.2.5",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 12.5,
        "ram": {
            "total_mb": 8192,
            "used_mb": 4096,
            "percent": 50.0
        },
        "disk": [
            {
                "path": "/",
                "total_gb": 100.0,
                "used_gb": 40.0,
                "percent": 40.0
            }
        ]
    }

    response = await client.post(
        "/api/agent/report",
        json=payload,
        headers={"Authorization": f"Bearer {active_token}"}
    )
    assert response.status_code == 200

    # 3. Refresh and check database state
    await db.refresh(agent_token)
    assert agent_token.pending_token is None
    assert agent_token.pending_at is None

@pytest.mark.asyncio
async def test_agent_auto_adoption_when_offline(client, db):
    """Test that a mismatched token is automatically adopted if the device is currently offline."""
    # 1. Enable auto-adoption setting
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="agent.allow_auto_adoption", value="true"))
    
    # Device is offline
    device = Device(
        id=11,
        ip="192.168.1.101",
        display_name="Offline Device",
        is_online=False
    )
    db.add(device)
    
    # Old token in database
    agent_token = AgentToken(
        device_id=11,
        token="old-token",
        is_active=True,
        last_seen=datetime.now(timezone.utc) - timedelta(hours=1)
    )
    db.add(agent_token)
    await db.commit()

    # 2. Report with a new, mismatched token (client IP matches)
    new_token = "newly-generated-token"
    payload = {
        "device_id": 11,
        "agent_version": "0.2.5",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 15.0,
        "ram": {"total_mb": 4096, "used_mb": 2048, "percent": 50.0}
    }

    # Override client IP in request using httpx extra if possible, or test standard endpoint behavior.
    # The client fixture doesn't let us easily fake remote_addr, so we will manually verify the endpoint logic
    # or rely on the test engine faking request.client.host as "127.0.0.1". 
    # To bypass client IP mismatch, we update the device IP to "127.0.0.1".
    device.ip = "127.0.0.1"
    await db.commit()

    response = await client.post(
        "/api/agent/report",
        json=payload,
        headers={"Authorization": f"Bearer {new_token}"}
    )
    assert response.status_code == 200

    # 3. Check that the new token has been adopted
    await db.refresh(agent_token)
    assert agent_token.token == hash_agent_token(new_token)
    assert agent_token.pending_token is None
    assert agent_token.pending_at is None
    assert agent_token.is_active is True

@pytest.mark.asyncio
async def test_agent_auto_adoption_when_stale(client, db):
    """Test that a mismatched token is automatically adopted if the last seen heartbeat is stale (>5m)."""
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="agent.allow_auto_adoption", value="true"))
    
    # Device is online but last seen was 10 minutes ago
    device = Device(
        id=12,
        ip="127.0.0.1",
        display_name="Stale Device",
        is_online=True
    )
    db.add(device)
    
    agent_token = AgentToken(
        device_id=12,
        token="old-token",
        is_active=True,
        last_seen=datetime.now(timezone.utc) - timedelta(minutes=10)
    )
    db.add(agent_token)
    await db.commit()

    new_token = "new-stale-adopt-token"
    payload = {
        "device_id": 12,
        "agent_version": "0.2.5",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 15.0,
        "ram": {"total_mb": 4096, "used_mb": 2048, "percent": 50.0}
    }

    response = await client.post(
        "/api/agent/report",
        json=payload,
        headers={"Authorization": f"Bearer {new_token}"}
    )
    assert response.status_code == 200

    await db.refresh(agent_token)
    assert agent_token.token == hash_agent_token(new_token)
    assert agent_token.pending_token is None

@pytest.mark.asyncio
async def test_agent_no_auto_adoption_when_active_and_healthy(client, db):
    """Test that a mismatched token is NOT adopted and is rejected if the device is active and recently seen."""
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="agent.allow_auto_adoption", value="true"))
    
    # Device is online and was seen 1 minute ago
    device = Device(
        id=13,
        ip="127.0.0.1",
        display_name="Healthy Online Device",
        is_online=True
    )
    db.add(device)
    
    agent_token = AgentToken(
        device_id=13,
        token="current-active-token",
        is_active=True,
        last_seen=datetime.now(timezone.utc) - timedelta(minutes=1)
    )
    db.add(agent_token)
    await db.commit()

    mismatched_token = "some-mismatched-token"
    payload = {
        "device_id": 13,
        "agent_version": "0.2.5",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 15.0,
        "ram": {"total_mb": 4096, "used_mb": 2048, "percent": 50.0}
    }

    response = await client.post(
        "/api/agent/report",
        json=payload,
        headers={"Authorization": f"Bearer {mismatched_token}"}
    )
    # Must be rejected with 401 since device is active and healthy
    assert response.status_code == 401
    assert "Manual adoption required" in response.json()["detail"]

    # Verify mismatched token is stored as pending
    await db.refresh(agent_token)
    assert agent_token.token == "current-active-token"
    assert agent_token.pending_token == hash_agent_token(mismatched_token)
    assert agent_token.pending_at is not None

@pytest.mark.asyncio
async def test_pending_placeholder_token_cannot_authenticate(client, db):
    """An unknown token on a device without a token row must not mint a usable placeholder.

    The placeholder row used to be active with token "TEMP_INVALID_" + the first
    8 chars of the submitted token, so a second report with that string passed
    authentication and bypassed manual adoption.
    """
    db.add(Setting(key="setup.complete", value="true"))
    db.add(Setting(key="agent.allow_auto_adoption", value="false"))
    db.add(Device(id=14, ip="127.0.0.1", display_name="No Token Device", is_online=True))
    await db.commit()

    submitted = "attacker-chosen-token"
    payload = {
        "device_id": 14,
        "agent_version": "0.2.5",
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "cpu_percent": 15.0,
        "ram": {"total_mb": 4096, "used_mb": 2048, "percent": 50.0}
    }

    response = await client.post(
        "/api/agent/report",
        json=payload,
        headers={"Authorization": f"Bearer {submitted}"}
    )
    assert response.status_code == 401
    assert "Manual adoption required" in response.json()["detail"]

    from sqlalchemy import select
    placeholder = (await db.execute(select(AgentToken).where(AgentToken.device_id == 14))).scalar_one()
    assert placeholder.is_active is False
    assert placeholder.pending_token == hash_agent_token(submitted)
    assert submitted[:8] not in placeholder.token

    response = await client.post(
        "/api/agent/report",
        json=payload,
        headers={"Authorization": f"Bearer TEMP_INVALID_{submitted[:8]}"}
    )
    assert response.status_code == 401
