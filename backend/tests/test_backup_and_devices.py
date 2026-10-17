"""Tests for backup cache invalidation and device group details batching (Befunde 4 & 5)."""

from datetime import datetime, timezone

import pytest

from app.api.agent import _latest_metrics
from app.api.auth import _setting_cache
from app.api.backup import invalidate_all_runtime_caches
from app.api.devices import dashboard_cache, get_group_details
from app.api.discovery import discovery_cache
from app.api.topology import topology_cache
from app.models.agent import AgentToken
from app.models.device import Device, DeviceGroup
from app.models.setting import Setting


def test_invalidate_all_runtime_caches_clears_populated_caches():
    """Befund 4: invalidate_all_runtime_caches must clear all in-memory caches."""
    # 1. Populate all in-memory runtime caches
    dashboard_cache["test_key"] = {"data": [1, 2, 3]}
    topology_cache["topology_key"] = {"nodes": ["a", "b"]}
    discovery_cache["discovery_key"] = {"hosts": ["192.168.1.1"]}
    _latest_metrics[42] = {"cpu_percent": 15.5}
    _setting_cache["test_setting"] = "cached_val"

    assert len(dashboard_cache) > 0
    assert len(topology_cache) > 0
    assert len(discovery_cache) > 0
    assert len(_latest_metrics) > 0
    assert len(_setting_cache) > 0

    # 2. Invoke cache invalidation
    invalidate_all_runtime_caches()

    # 3. Verify all caches are cleared
    assert len(dashboard_cache) == 0
    assert len(topology_cache) == 0
    assert len(discovery_cache) == 0
    assert len(_latest_metrics) == 0
    assert len(_setting_cache) == 0


@pytest.mark.asyncio
async def test_group_details_batch_loads_agent_tokens(db):
    """Befund 5: get_group_details batch loads AgentTokens instead of executing N+1 queries."""
    # 1. Setup group and devices
    group = DeviceGroup(id=1, name="Servers", is_default=False)
    db.add(group)
    await db.commit()

    dev1 = Device(id=101, ip="192.168.1.101", display_name="Web Server", group_id=1, is_online=True)
    dev2 = Device(id=102, ip="192.168.1.102", display_name="Printer", group_id=1, is_online=True)
    db.add_all([dev1, dev2])
    await db.commit()

    # dev1 has an active agent token; dev2 does not
    token1 = AgentToken(
        device_id=101,
        token="valid-token-hash-101",
        agent_version="v0.4.0",
        is_active=True,
    )
    db.add(token1)
    await db.commit()

    # 2. Fetch group details
    details = await get_group_details(group_id=1, db=db)

    assert details.id == 1
    assert details.device_count == 2
    assert len(details.devices) == 2

    # Map by id
    by_id = {d.id: d for d in details.devices}

    assert by_id[101].has_agent is True
    assert by_id[101].agent_info is not None
    assert by_id[101].agent_info.agent_version == "0.4.0"

    assert by_id[102].has_agent is False
    assert by_id[102].agent_info is None
