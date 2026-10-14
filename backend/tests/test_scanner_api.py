"""Tests for the scan job state in app.api.scanner."""

from unittest.mock import AsyncMock, patch

import pytest

from app.api import scanner
from app.schemas.scan import ScanRequest, ScanStatus


@pytest.fixture(autouse=True)
def reset_scan_state():
    """The scan state is module-global; give every test a fresh one."""
    original = scanner.state
    scanner.state = scanner.ScanStateManager()
    yield
    scanner.state = original


@pytest.mark.asyncio
async def test_failed_planner_scan_reports_failed_and_frees_the_slot():
    with patch.object(scanner, "run_planner_scan", AsyncMock(side_effect=RuntimeError("nmap missing"))):
        res = await scanner.start_scan(ScanRequest(subnets=["10.0.0.0/24"]))
        assert res["status"] == "ok"
        await scanner.state.task

    assert scanner.state.last_progress.status == ScanStatus.FAILED
    assert "nmap missing" in scanner.state.last_progress.message
    assert await scanner.state.get_active() is False


@pytest.mark.asyncio
async def test_failed_dashboard_scan_reports_failed_and_frees_the_slot():
    with patch.object(scanner, "run_dashboard_scan", AsyncMock(side_effect=RuntimeError("boom"))):
        res = await scanner.start_dashboard_scan_api(ScanRequest(subnets=["10.0.0.0/24"]), background_tasks=None)
        assert res["status"] == "ok"
        await scanner.state.task

    assert scanner.state.last_progress.status == ScanStatus.FAILED
    assert "boom" in scanner.state.last_progress.message
    assert await scanner.state.get_active() is False
