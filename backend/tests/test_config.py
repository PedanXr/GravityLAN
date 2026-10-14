"""Tests for the application configuration (app/config.py)."""

import socket
from pathlib import Path

import pytest

from app.config import Settings


# --- field validators -------------------------------------------------------

def test_validate_scan_timeout_positive():
    s = Settings(scan_timeout=1.5)
    assert s.scan_timeout == 1.5


def test_validate_scan_timeout_rejects_non_positive():
    with pytest.raises(ValueError):
        Settings(scan_timeout=0)
    with pytest.raises(ValueError):
        Settings(scan_timeout=-1)


def test_validate_scan_workers_bounds():
    assert Settings(scan_workers=1).scan_workers == 1
    assert Settings(scan_workers=200).scan_workers == 200
    with pytest.raises(ValueError):
        Settings(scan_workers=0)
    with pytest.raises(ValueError):
        Settings(scan_workers=201)


def test_validate_scan_interval_non_negative():
    assert Settings(scan_interval_minutes=0).scan_interval_minutes == 0
    with pytest.raises(ValueError):
        Settings(scan_interval_minutes=-1)


def test_validate_history_retention_bounds():
    assert Settings(history_retention_days=1).history_retention_days == 1
    assert Settings(history_retention_days=365).history_retention_days == 365
    with pytest.raises(ValueError):
        Settings(history_retention_days=0)
    with pytest.raises(ValueError):
        Settings(history_retention_days=366)


def test_validate_port_bounds():
    assert Settings(port=8000).port == 8000
    assert Settings(port=1).port == 1
    assert Settings(port=65535).port == 65535
    with pytest.raises(ValueError):
        Settings(port=0)
    with pytest.raises(ValueError):
        Settings(port=65536)


# --- host validation --------------------------------------------------------

@pytest.mark.parametrize("host", ["0.0.0.0", "::", "localhost"])
def test_validate_host_special_values(host):
    assert Settings(host=host).host == host


@pytest.mark.parametrize("host", ["192.168.1.10", "10.0.0.1", "127.0.0.1"])
def test_validate_host_ipv4(host):
    assert Settings(host=host).host == host


@pytest.mark.parametrize("host", ["fe80::1", "2001:db8::1"])
def test_validate_host_ipv6(host):
    assert Settings(host=host).host == host


@pytest.mark.parametrize("host", ["myhost", "my.host.local", "web-01.example.com"])
def test_validate_host_hostname(host):
    assert Settings(host=host).host == host


@pytest.mark.parametrize(
    "host",
    ["", "   ", "bad_host!", "exa mple", "my..host", "-invalid-", "-host", "host-", "my.-host.local", "web.example-", "-"],
)
def test_validate_host_rejects_invalid(host):
    with pytest.raises(ValueError):
        Settings(host=host)


def test_validate_host_trims_whitespace():
    assert Settings(host=" 192.168.1.10 ").host == "192.168.1.10"


# --- effective_database_url -------------------------------------------------

def test_effective_database_url_uses_configured():
    s = Settings(database_url="sqlite+aiosqlite:////tmp/custom.db")
    assert s.effective_database_url == "sqlite+aiosqlite:////tmp/custom.db"


def test_effective_database_url_defaults_to_data_dir(tmp_path):
    s = Settings(data_dir=tmp_path, database_url="")
    assert s.effective_database_url == f"sqlite+aiosqlite:///{tmp_path / 'gravitylan.db'}"


def test_settings_module_singleton():
    from app.config import settings as module_settings
    assert isinstance(module_settings, Settings)
