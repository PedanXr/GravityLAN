"""
Vendor lookup module using OUI-based identification and local caching.
Supports static fallbacks, local file cache, and online API lookup.
"""

import json
import logging
import os
import threading
import time
import urllib.request
import urllib.error
from typing import Dict, Optional

from app.config import settings

# Standard Logger setup
logger = logging.getLogger(__name__)

# -- Global State for Rate Limiting ------------------------------------------
_last_429_time = 0.0
_COOLDOWN_SECONDS = 300  # 5 minutes

# -- Configuration -----------------------------------------------------------
_DATA_DIR = os.path.join(settings.data_dir, "cache")
CACHE_FILE = os.path.join(_DATA_DIR, "mac_cache.json")

# -- Static Fallback Database (Common HomeLab Vendors) -----------------------
COMMON_VENDORS = {
    "00:11:32": "Synology Inc.",
    "00:15:5D": "Microsoft Corporation (Hyper-V)",
    "08:00:27": "Oracle Corporation (VirtualBox)",
    "00:0C:29": "VMware, Inc.",
    "00:50:56": "VMware, Inc.",
    "B8:27:EB": "Raspberry Pi Foundation",
    "DC:A6:32": "Raspberry Pi Foundation",
    "E4:5F:01": "Raspberry Pi Foundation",
    "74:83:C2": "Ubiquiti Networks",
    "FC:EC:DA": "Ubiquiti Networks",
    "00:15:6D": "Ubiquiti Networks",
    "AC:86:74": "Apple, Inc.",
    "D8:49:2F": "Apple, Inc.",
    "00:01:C0": "CompuLab",
    "00:22:6B": "Cisco Systems",
    "00:E0:4C": "Realtek Semiconductor Corp.",
    "00:16:3E": "Xensource, Inc. (Xen)",
    "52:54:00": "QEMU/KVM Virtual Machine",
}

# -- Module-level state ------------------------------------------------------
_vendor_cache: Dict[str, str] = {}
_cache_loaded: bool = False
_cache_lock = threading.Lock()

def _load_cache() -> None:
    """
    Loads the vendor cache from the local JSON file.
    Uses a thread lock to ensure thread safety during initialization.
    """
    global _vendor_cache, _cache_loaded
    if _cache_loaded:
        return
    
    with _cache_lock:
        if _cache_loaded:  # Double-check pattern
            return
            
        if not os.path.exists(CACHE_FILE):
            _cache_loaded = True
            return

        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                _vendor_cache = json.load(f)
            logger.debug(f"Loaded {len(_vendor_cache)} vendors from cache.")
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse vendor cache file {CACHE_FILE}: {e}")
            _vendor_cache = {}
        except IOError as e:
            logger.error(f"Failed to read vendor cache file {CACHE_FILE}: {e}")
            _vendor_cache = {}
        finally:
            _cache_loaded = True

def _save_cache() -> None:
    """
    Saves the current module-level vendor cache to the local JSON file.
    This is intended to be run in a separate thread.
    """
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_vendor_cache, f, ensure_ascii=False, indent=2)
    except (IOError, OSError, PermissionError) as e:
        logger.warning(f"Failed to persist vendor cache to {CACHE_FILE}: {e}")
    except Exception as e:
        logger.warning(f"Unexpected error saving vendor cache: {e}")

def get_vendor(mac: Optional[str], use_cache: bool = True) -> str:
    """
    Identifies the hardware vendor based on the MAC address OUI.
    
    Args:
        mac: The MAC address to look up.
        use_cache: Whether to use and update the local file cache.
        
    Returns:
        The vendor name as a string, or an empty string if not identified.
    """
    if not mac or mac == "-" or "N/A" in mac.upper():
        return ""

    mac_normalized = mac.replace("-", ":").upper()
    if len(mac_normalized) < 8:
        return ""

    oui = mac_normalized[:8]

    # 1. Check static fallback (Fastest)
    if oui in COMMON_VENDORS:
        return COMMON_VENDORS[oui]

    # 2. Check local cache
    if use_cache:
        _load_cache()
        if oui in _vendor_cache:
            return _vendor_cache[oui]

    # 3. API Lookup (Last resort)
    vendor = _api_lookup(mac_normalized)

    if vendor:
        if use_cache:
            _vendor_cache[oui] = vendor
            # Run save in background to not block the main scanning process
            threading.Thread(target=_save_cache, daemon=True).start()
        return vendor

    return ""

def _api_lookup(mac: str) -> str:
    """
    Fallback API lookup for unknown OUIs using native urllib.
    
    Args:
        mac: The normalized MAC address.
        
    Returns:
        The vendor name if found, else an empty string.
    """
    global _last_429_time
    
    # Check cooldown
    if time.time() - _last_429_time < _COOLDOWN_SECONDS:
        return ""

    try:
        # Use only the first 6 hex chars (3 bytes) for the API
        mac_query = mac.replace(":", "").replace("-", "")[:6]
        url = f"https://api.macvendors.com/{mac_query}"
        
        headers = {
            "User-Agent": "GravityLAN/1.1 (github.com/SleeperXr/GravityLAN)",
            "Accept": "text/plain"
        }
        
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                vendor = response.read().decode('utf-8').strip()
                if vendor and "errors" not in vendor.lower() and "not found" not in vendor.lower():
                    return vendor
            elif response.status == 429:
                _last_429_time = time.time()
                logger.warning(f"API rate limit hit for vendor lookup. Entering {(_COOLDOWN_SECONDS // 60)}m cooldown.")
    except urllib.error.HTTPError as e:
        if e.code == 429:
            _last_429_time = time.time()
            logger.warning(f"API rate limit hit (HTTP {e.code}). Entering {(_COOLDOWN_SECONDS // 60)}m cooldown.")
        elif e.code != 404:  # 404 is "Not Found", which is expected for unknown OUIs
            logger.debug("API vendor lookup HTTP error: %d", e.code)
    except Exception as e:
        # Network issues are common with this API
        logger.debug("API vendor lookup network failure: %s", e)

    return ""
