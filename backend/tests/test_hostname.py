"""Tests for hostname resolution helpers (app/scanner/hostname.py)."""

import sys

import pytest

import app.scanner.hostname as hostname


# --- is_ip_like -------------------------------------------------------------

def test_is_ip_like_empty_is_true():
    assert hostname.is_ip_like(None) is True
    assert hostname.is_ip_like("") is True


def test_is_ip_like_ip_and_placeholders():
    assert hostname.is_ip_like("192.168.1.1") is True
    assert hostname.is_ip_like("unbekannt") is True
    assert hostname.is_ip_like("unknown") is True


def test_is_ip_like_real_hostname():
    assert hostname.is_ip_like("my-router") is False
    assert hostname.is_ip_like("printer.local") is False


# --- mask_ip ----------------------------------------------------------------

def test_mask_ip_masks_host_part():
    assert hostname.mask_ip("192.168.1.42") == "192.168.x.x"


def test_mask_ip_handles_malformed():
    assert hostname.mask_ip(None) == ""
    assert hostname.mask_ip("abc") == "x.x.x.x"


# --- _parse_ping_hostname ---------------------------------------------------

def test_parse_ping_hostname_extracts():
    out = (
        "Windows IP Configuration\n\n"
        "Pinging my-router [192.168.1.1] with 32 bytes of data:\n"
        "Reply from 192.168.1.1: bytes=32 time<1ms TTL=64\n"
    )
    assert hostname._parse_ping_hostname(out, "192.168.1.1") == "my-router"


def test_parse_ping_hostname_ignores_own_ip():
    assert hostname._parse_ping_hostname("Pinging 192.168.1.1 [192.168.1.1]", "192.168.1.1") is None


def test_parse_ping_hostname_no_match():
    assert hostname._parse_ping_hostname("no useful output", "10.0.0.1") is None


# --- _try_dig / _resolve_linux_shell ----------------------------------------

class _FakeRun:
    """subprocess.run double that records each command and returns the given stdout."""

    def __init__(self, stdout=""):
        self.calls = []
        self.stdout = stdout

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        return type("Result", (), {"returncode": 0, "stdout": self.stdout})()


def test_try_dig_asks_configured_dns_server(monkeypatch):
    run = _FakeRun("nas.lan.\n")
    monkeypatch.setattr(hostname.subprocess, "run", run)

    assert hostname._try_dig("192.168.1.50", dns_server="192.168.1.2") == "nas.lan"
    assert run.calls == [["dig", "@192.168.1.2", "+short", "-x", "192.168.1.50"]]


def test_try_dig_without_dns_server_uses_system_resolver(monkeypatch):
    run = _FakeRun("")
    monkeypatch.setattr(hostname.subprocess, "run", run)

    assert hostname._try_dig("192.168.1.50") is None
    assert run.calls == [["dig", "+short", "-x", "192.168.1.50"]]


def test_linux_shell_fallback_no_longer_spawns_nmap(monkeypatch):
    """A host without a DNS name used to cost an extra 'nmap -sn' (up to 3 s) per IP."""
    run = _FakeRun("")
    monkeypatch.setattr(hostname.subprocess, "run", run)

    assert hostname._resolve_linux_shell("192.168.1.50", dns_server="192.168.1.2") is None
    assert [cmd[0] for cmd in run.calls] == ["avahi-resolve", "dig"]
    assert "@192.168.1.2" in run.calls[1]


# --- _resolve_shell ---------------------------------------------------------

def test_resolve_shell_linux_delegates(monkeypatch):
    monkeypatch.setattr(hostname.sys, "platform", "linux")
    seen = []
    monkeypatch.setattr(hostname, "_resolve_linux_shell", lambda ip, dns_server=None: seen.append(dns_server) or "linux-name")
    assert hostname._resolve_shell("192.168.1.1", dns_server="192.168.1.2") == "linux-name"
    assert seen == ["192.168.1.2"]


def test_resolve_shell_win32_delegates(monkeypatch):
    monkeypatch.setattr(hostname.sys, "platform", "win32")
    monkeypatch.setattr(hostname, "_resolve_ping_win32", lambda ip: "win-name")
    assert hostname._resolve_shell("192.168.1.1") == "win-name"
