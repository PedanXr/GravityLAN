"""Health summary counts (app/api/health.py)."""

from datetime import datetime, timedelta, timezone

import pytest

from app.models.device import Device, DeviceHistory


@pytest.mark.asyncio
async def test_fresh_notifications_use_utc_window(client, db, admin_token):
    """DeviceHistory.timestamp is naive UTC; a cutoff in local server time shifted the
    30-minute window by the UTC offset (on a UTC+2 host nothing ever counted as fresh)."""
    device = Device(ip="192.168.1.30", display_name="nas", device_type="server")
    db.add(device)
    await db.commit()
    utc_now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(DeviceHistory(device_id=device.id, status="offline", timestamp=utc_now - timedelta(minutes=10)))
    db.add(DeviceHistory(device_id=device.id, status="online", timestamp=utc_now - timedelta(minutes=50)))
    await db.commit()

    response = await client.get("/api/health/summary", headers={"Authorization": f"Bearer {admin_token}"})

    assert response.status_code == 200
    assert response.json()["notifications"] == {"unread": 2, "fresh_30min": 1}
