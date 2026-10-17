"""Tests for the vendor OUI lookup (app/scanner/vendor.py)."""

import json

import app.scanner.vendor as vendor


def test_get_vendor_invalid_inputs():
    assert vendor.get_vendor(None) == ""
    assert vendor.get_vendor("-") == ""
    assert vendor.get_vendor("N/A") == ""
    assert vendor.get_vendor("") == ""


def test_get_vendor_too_short_mac():
    assert vendor.get_vendor("00:11") == ""


def test_get_vendor_static_fallback():
    assert vendor.get_vendor("00:11:32:AA:BB:CC") == "Synology Inc."
    assert vendor.get_vendor("b8:27:eb:12:34:56") == "Raspberry Pi Foundation"
    assert vendor.get_vendor("08:00:27:00:00:01") == "Oracle Corporation (VirtualBox)"


def test_get_vendor_hyphen_normalization():
    assert vendor.get_vendor("00-11-32-AA-BB-CC") == "Synology Inc."


def test_get_vendor_from_cache(monkeypatch):
    monkeypatch.setattr(vendor, "_vendor_cache", {"AA:BB:CC": "Cached Vendor"})
    monkeypatch.setattr(vendor, "_cache_loaded", True)
    assert vendor.get_vendor("AA:BB:CC:DD:EE:FF") == "Cached Vendor"


def test_get_vendor_api_lookup_hit(monkeypatch):
    monkeypatch.setattr(vendor, "_vendor_cache", {})
    monkeypatch.setattr(vendor, "_cache_loaded", True)
    monkeypatch.setattr(vendor, "_api_lookup", lambda mac: "Cool Vendor Inc.")

    result = vendor.get_vendor("DE:AD:BE:EF:00:01")
    assert result == "Cool Vendor Inc."
    assert vendor._vendor_cache.get("DE:AD:BE") == "Cool Vendor Inc."


def test_get_vendor_api_lookup_miss(monkeypatch):
    monkeypatch.setattr(vendor, "_vendor_cache", {})
    monkeypatch.setattr(vendor, "_cache_loaded", True)
    monkeypatch.setattr(vendor, "_api_lookup", lambda mac: "")

    assert vendor.get_vendor("DE:AD:BE:EF:00:01") == ""


def test_load_cache_parses_file(monkeypatch, tmp_path):
    cache_file = tmp_path / "mac_cache.json"
    cache_file.write_text(json.dumps({"00:11:22": "Test Vendor"}), encoding="utf-8")
    monkeypatch.setattr(vendor, "CACHE_FILE", str(cache_file))
    monkeypatch.setattr(vendor, "_cache_loaded", False)
    monkeypatch.setattr(vendor, "_vendor_cache", {})

    vendor._load_cache()
    assert vendor._vendor_cache == {"00:11:22": "Test Vendor"}
    assert vendor._cache_loaded is True


def test_load_cache_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(vendor, "CACHE_FILE", str(tmp_path / "nope.json"))
    monkeypatch.setattr(vendor, "_cache_loaded", False)
    monkeypatch.setattr(vendor, "_vendor_cache", {})

    vendor._load_cache()
    assert vendor._vendor_cache == {}
    assert vendor._cache_loaded is True


def test_load_cache_invalid_json(monkeypatch, tmp_path):
    cache_file = tmp_path / "mac_cache.json"
    cache_file.write_text("{broken", encoding="utf-8")
    monkeypatch.setattr(vendor, "CACHE_FILE", str(cache_file))
    monkeypatch.setattr(vendor, "_cache_loaded", False)
    monkeypatch.setattr(vendor, "_vendor_cache", {})

    vendor._load_cache()
    assert vendor._vendor_cache == {}
    assert vendor._cache_loaded is True


def test_save_cache_writes_file(monkeypatch, tmp_path):
    data_dir = tmp_path / "cache"
    cache_file = data_dir / "mac_cache.json"
    monkeypatch.setattr(vendor, "_DATA_DIR", str(data_dir))
    monkeypatch.setattr(vendor, "CACHE_FILE", str(cache_file))
    monkeypatch.setattr(vendor, "_vendor_cache", {"AA:BB:CC": "Vendor X"})

    vendor._save_cache()
    loaded = json.loads(cache_file.read_text(encoding="utf-8"))
    assert loaded == {"AA:BB:CC": "Vendor X"}


def test_api_lookup_rate_limit_cooldown(monkeypatch):
    monkeypatch.setattr(vendor, "_last_429_time", 1e18)  # far in the future
    assert vendor._api_lookup("AA:BB:CC:DD:EE:FF") == ""


def test_api_lookup_http_429(monkeypatch):
    monkeypatch.setattr(vendor, "_last_429_time", 0.0)
    import urllib.error

    def fake_urlopen(req, timeout=5):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(vendor.urllib.request, "urlopen", fake_urlopen)
    result = vendor._api_lookup("AA:BB:CC:DD:EE:FF")
    assert result == ""
    assert vendor._last_429_time > 0


def test_api_lookup_http_404_quiet(monkeypatch):
    monkeypatch.setattr(vendor, "_last_429_time", 0.0)
    import urllib.error

    def fake_urlopen(req, timeout=5):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(vendor.urllib.request, "urlopen", fake_urlopen)
    assert vendor._api_lookup("AA:BB:CC:DD:EE:FF") == ""
    assert vendor._last_429_time == 0.0


def test_api_lookup_network_error(monkeypatch):
    monkeypatch.setattr(vendor, "_last_429_time", 0.0)

    def fake_urlopen(req, timeout=5):
        raise OSError("no network")

    monkeypatch.setattr(vendor.urllib.request, "urlopen", fake_urlopen)
    assert vendor._api_lookup("AA:BB:CC:DD:EE:FF") == ""


def test_api_lookup_success(monkeypatch):
    monkeypatch.setattr(vendor, "_last_429_time", 0.0)

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"Synology Inc."

    def fake_urlopen(req, timeout=5):
        return FakeResponse()

    monkeypatch.setattr(vendor.urllib.request, "urlopen", fake_urlopen)
    assert vendor._api_lookup("00:11:32:AA:BB:CC") == "Synology Inc."


def test_get_vendor_negative_caching(monkeypatch):
    """Verify that unresolvable OUIs are negatively cached as empty string and not re-queried."""
    lookup_count = 0

    def mock_lookup(mac):
        nonlocal lookup_count
        lookup_count += 1
        return ""

    monkeypatch.setattr(vendor, "_vendor_cache", {})
    monkeypatch.setattr(vendor, "_cache_loaded", True)
    monkeypatch.setattr(vendor, "_api_lookup", mock_lookup)

    res1 = vendor.get_vendor("12:34:56:78:9A:BC")
    assert res1 == ""
    assert lookup_count == 1
    assert vendor._vendor_cache.get("12:34:56") == ""

    # Second call for the same OUI must hit cache and NOT invoke _api_lookup
    res2 = vendor.get_vendor("12:34:56:AA:BB:CC")
    assert res2 == ""
    assert lookup_count == 1


def test_save_cache_permission_error(monkeypatch, caplog):
    """Verify that PermissionError during cache persistence is caught cleanly with an actionable warning."""
    import logging

    def raise_perm_error(*args, **kwargs):
        raise PermissionError(13, "Permission denied", "mac_cache.json")

    monkeypatch.setattr("builtins.open", raise_perm_error)
    monkeypatch.setattr(vendor, "_permission_warned", False)
    monkeypatch.setattr(vendor, "_vendor_cache", {"00:11:22": "Test"})

    with caplog.at_level(logging.WARNING):
        vendor._save_cache()

    assert any("chown -R 1000:1000" in record.message for record in caplog.records)


def test_is_locally_administered_mac():
    """Verify IEEE 802 locally administered / randomized MAC detection."""
    # Universally administered (bit 1 of byte 0 is 0)
    assert vendor.is_locally_administered_mac("00:11:32:AA:BB:CC") is False
    assert vendor.is_locally_administered_mac("B8:27:EB:12:34:56") is False
    assert vendor.is_locally_administered_mac("AC:86:74:12:34:56") is False

    # Locally administered / private / randomized (bit 1 of byte 0 is 1)
    assert vendor.is_locally_administered_mac("02:00:00:00:00:00") is True
    assert vendor.is_locally_administered_mac("DA:A1:19:12:34:56") is True
    assert vendor.is_locally_administered_mac("FE:ED:FA:CE:00:01") is True

    # Invalid / short inputs
    assert vendor.is_locally_administered_mac("") is False
    assert vendor.is_locally_administered_mac("invalid") is False

