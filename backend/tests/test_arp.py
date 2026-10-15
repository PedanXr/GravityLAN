"""Tests for ARP table collection and MAC resolution (app/scanner/arp.py)."""

import asyncio
import sys
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio

import app.scanner.arp as arp


# --- _parse_arp_lines -------------------------------------------------------

def test_parse_arp_lines_basic():
    output = (
        "Interface: 192.168.1.1 --- 0x1\n"
        "  Internet Address      Physical Address      Type\n"
        "  192.168.1.10          aa-bb-cc-dd-ee-ff     dynamic\n"
        "  192.168.1.11          11:22:33:44:55:66     dynamic\n"
        "  192.168.1.255         ff-ff-ff-ff-ff-ff     static\n"
    )
    result = arp._parse_arp_lines(output)
    assert result == {
        "192.168.1.10": "aa:bb:cc:dd:ee:ff",
        "192.168.1.11": "11:22:33:44:55:66",
    }


def test_parse_arp_lines_skips_broadcast_and_zero():
    output = (
        "  192.168.1.1          00-00-00-00-00-00     static\n"
        "  224.0.0.1            01-00-5e-00-00-01     static\n"
    )
    assert arp._parse_arp_lines(output) == {}


def test_parse_arp_lines_empty():
    assert arp._parse_arp_lines("") == {}
    assert arp._parse_arp_lines("no useful data here") == {}


# --- _decode_output ---------------------------------------------------------

def test_decode_output_common_encodings():
    assert arp._decode_output("abc".encode("utf-8")) == "abc"
    assert arp._decode_output("äöü".encode("cp850")) == "äöü"


def test_decode_output_falls_through_encodings():
    # Bytes that fail utf-8 but decode via cp850 (the second candidate)
    raw = "äöü".encode("cp850")
    assert arp._decode_output(raw) == "äöü"


# --- _run_arp_command -------------------------------------------------------

def test_run_arp_command_uses_arp_a_then_g(monkeypatch):
    fake_shutil = MagicMock()
    fake_shutil.which.return_value = "/usr/bin/arp"
    monkeypatch.setattr(arp.shutil, "which", fake_shutil.which)

    calls = []

    def fake_check_output(cmd, **kwargs):
        calls.append(cmd)
        if cmd == ["arp", "-a"]:
            raise subprocess_error("boom")
        return b"ok"

    class subprocess_error(Exception):
        pass

    monkeypatch.setattr(arp.subprocess, "check_output", fake_check_output)
    monkeypatch.setattr(arp.subprocess, "SubprocessError", subprocess_error)

    assert arp._run_arp_command() == b"ok"
    assert calls == [["arp", "-a"], ["arp", "-g"]]


def test_run_arp_command_missing_binary(monkeypatch):
    fake_shutil = MagicMock()
    fake_shutil.which.return_value = None
    monkeypatch.setattr(arp.shutil, "which", fake_shutil.which)

    assert arp._run_arp_command() is None


def test_run_arp_command_both_fail(monkeypatch):
    fake_shutil = MagicMock()
    fake_shutil.which.return_value = "/usr/bin/arp"
    monkeypatch.setattr(arp.shutil, "which", fake_shutil.which)

    class subprocess_error(Exception):
        pass

    def fake_check_output(cmd, **kwargs):
        raise subprocess_error("boom")

    monkeypatch.setattr(arp.subprocess, "check_output", fake_check_output)
    monkeypatch.setattr(arp.subprocess, "SubprocessError", subprocess_error)

    assert arp._run_arp_command() is None


# --- get_local_arp_table ----------------------------------------------------

def test_get_local_arp_table_success(monkeypatch):
    monkeypatch.setattr(
        arp, "_run_arp_command",
        lambda: b"  192.168.1.10  aa-bb-cc-dd-ee-ff  dynamic\n",
    )
    assert arp.get_local_arp_table() == {"192.168.1.10": "aa:bb:cc:dd:ee:ff"}


def test_get_local_arp_table_empty_output(monkeypatch):
    monkeypatch.setattr(arp, "_run_arp_command", lambda: b"")
    assert arp.get_local_arp_table() == {}


def test_get_local_arp_table_exception(monkeypatch):
    def boom():
        raise OSError("arp missing")

    monkeypatch.setattr(arp, "_run_arp_command", boom)
    assert arp.get_local_arp_table() == {}


# --- _extract_neighbor ------------------------------------------------------

def test_extract_neighbor_valid():
    assert arp._extract_neighbor("192.168.1.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE") == \
        ("192.168.1.10", "aa:bb:cc:dd:ee:ff")


def test_extract_neighbor_short_line():
    assert arp._extract_neighbor("192.168.1.10 dev eth0") is None


def test_extract_neighbor_invalid_ip():
    assert arp._extract_neighbor("not-an-ip dev eth0 lladdr aa:bb:cc:dd:ee:ff") is None


def test_extract_neighbor_missing_lladdr():
    assert arp._extract_neighbor("192.168.1.10 dev eth0 REACHABLE") is None


def test_extract_neighbor_bad_mac_length():
    assert arp._extract_neighbor("192.168.1.10 dev eth0 lladdr aa:bb:cc REACHABLE") is None


# --- get_linux_neighbors ----------------------------------------------------

def test_get_linux_neighbors_parses(monkeypatch):
    monkeypatch.setattr(arp.sys, "platform", "linux")
    monkeypatch.setattr(
        arp.subprocess, "check_output",
        lambda *a, **k: b"192.168.1.10 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n",
    )
    assert arp.get_linux_neighbors() == {"192.168.1.10": "aa:bb:cc:dd:ee:ff"}


def test_get_linux_neighbors_win32_returns_empty(monkeypatch):
    monkeypatch.setattr(arp.sys, "platform", "win32")
    assert arp.get_linux_neighbors() == {}


def test_get_linux_neighbors_exception(monkeypatch):
    monkeypatch.setattr(arp.sys, "platform", "linux")
    def boom(*a, **k):
        raise OSError("ip missing")
    monkeypatch.setattr(arp.subprocess, "check_output", boom)
    assert arp.get_linux_neighbors() == {}


# --- _merge_into_hosts ------------------------------------------------------

def test_merge_into_hosts_backfills_existing():
    hosts = [{"ip": "192.168.1.10", "mac": None, "vendor": None}]
    arp._merge_into_hosts(hosts, {"192.168.1.10": "aa:bb:cc:dd:ee:ff"}, None)
    assert hosts[0]["mac"] == "aa:bb:cc:dd:ee:ff"
    assert hosts[0]["vendor"] is not None  # get_vendor("aa:bb:cc:dd:ee:ff") -> vendor string


def test_merge_into_hosts_appends_new():
    hosts = []
    arp._merge_into_hosts(hosts, {"10.0.0.5": "11:22:33:44:55:66"}, None)
    assert len(hosts) == 1
    assert hosts[0]["ip"] == "10.0.0.5"
    assert hosts[0]["mac"] == "11:22:33:44:55:66"
    assert hosts[0]["hostname"] is None


def test_merge_into_hosts_respects_target_filter():
    hosts = [{"ip": "192.168.1.10", "mac": None, "vendor": None}]
    arp._merge_into_hosts(hosts, {"10.0.0.5": "11:22:33:44:55:66"}, ["10.0.0.5"])
    # 10.0.0.5 passes the filter and gets appended
    assert len(hosts) == 2
    assert hosts[1]["ip"] == "10.0.0.5"


def test_merge_into_hosts_filter_excludes():
    hosts = [{"ip": "192.168.1.10", "mac": None, "vendor": None}]
    arp._merge_into_hosts(hosts, {"10.0.0.5": "11:22:33:44:55:66"}, ["192.168.1.10"])
    assert len(hosts) == 1


# --- resolve_mac_addresses --------------------------------------------------

@pytest_asyncio.fixture
def patch_executor(monkeypatch):
    """Route run_in_executor calls directly to the sync function."""
    def fake_run_in_executor(loop, fn, *args, **kwargs):
        return fn(*args)

    monkeypatch.setattr(arp.asyncio, "get_running_loop", lambda: MagicMock(
        run_in_executor=fake_run_in_executor,
    ))


@pytest.mark.asyncio
async def test_resolve_mac_addresses_assigns_known(monkeypatch):
    hosts = [{"ip": "192.168.1.10", "mac": None, "hostname": "h"}]
    monkeypatch.setattr(
        arp, "_collect_arp_maps",
        lambda: _async_value({"192.168.1.10": "aa:bb:cc:dd:ee:ff"}),
    )
    monkeypatch.setattr(arp, "_probe_and_retry_missing", AsyncMock_passthrough())
    monkeypatch.setattr(arp, "_merge_into_hosts", lambda h, m, t: None)

    result = await arp.resolve_mac_addresses(hosts)
    assert result[0]["mac"] == "aa:bb:cc:dd:ee:ff"


@pytest.mark.asyncio
async def test_resolve_mac_addresses_no_arp_map(monkeypatch):
    hosts = [{"ip": "192.168.1.10", "mac": None}]
    monkeypatch.setattr(arp, "_collect_arp_maps", lambda: _async_value({}))
    result = await arp.resolve_mac_addresses(hosts)
    assert result == hosts


def AsyncMock_passthrough():
    async def _passthrough(*args, **kwargs):
        return None
    return _passthrough


def _async_value(value):
    """Return a coroutine resolving to ``value`` (for async mock targets)."""
    async def _resolve():
        return value
    return _resolve()


# --- _filter_gateway_and_proxy_macs -----------------------------------------

def test_filter_gateway_macs_preserves_unique():
    raw = {
        "192.168.1.10": "aa:bb:cc:dd:ee:01",
        "192.168.1.11": "aa:bb:cc:dd:ee:02",
    }
    filtered = arp._filter_gateway_and_proxy_macs(raw)
    assert filtered == raw


def test_filter_gateway_macs_strips_from_remote_routed_hosts():
    gateway_mac = "00:11:22:33:44:55"
    raw = {
        "192.168.1.1": gateway_mac,    # Local gateway
        "192.168.20.10": gateway_mac,  # Remote routed host (IoT)
        "192.168.20.11": gateway_mac,  # Another remote host
        "192.168.1.50": "aa:bb:cc:11:22:33",  # Local unique host
    }
    local_subnets = ["192.168.1.0/24"]
    filtered = arp._filter_gateway_and_proxy_macs(raw, local_subnets=local_subnets)

    # Local gateway keeps its MAC
    assert filtered.get("192.168.1.1") == gateway_mac
    # Local unique host keeps its MAC
    assert filtered.get("192.168.1.50") == "aa:bb:cc:11:22:33"
    # Remote routed hosts must NOT inherit the gateway MAC
    assert "192.168.20.10" not in filtered
    assert "192.168.20.11" not in filtered


def test_filter_gateway_macs_empty():
    assert arp._filter_gateway_and_proxy_macs({}) == {}

