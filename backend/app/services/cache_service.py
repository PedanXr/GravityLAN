import time
import logging
from typing import Any, Dict, List, Optional
from datetime import datetime

logger = logging.getLogger(__name__)

class TopologyCache:
    """
    In-memory cache for topology data to improve dashboard performance.
    Stores devices, links, and racks to avoid expensive DB joins during polling.
    """
    def __init__(self):
        self._devices: Dict[int, Dict[str, Any]] = {}
        self._links: List[Dict[str, Any]] = []
        self._racks: List[Dict[str, Any]] = []
        self._last_updated: float = 0
        self._ttl: int = 30  # Seconds
        self._is_initialized: bool = False

    def is_stale(self) -> bool:
        if not self._is_initialized:
            return True
        return (time.time() - self._last_updated) > self._ttl

    def set_data(self, devices: List[Dict[str, Any]], links: List[Dict[str, Any]], racks: List[Dict[str, Any]]):
        """Update the entire topology cache."""
        self._devices = {d["id"]: d for d in devices}
        self._links = links
        self._racks = racks
        self._last_updated = time.time()
        self._is_initialized = True
        logger.debug("Topology cache updated.")

    def update_device_position(self, device_id: int, x: int, y: int):
        """Update a single device position in cache."""
        if device_id in self._devices:
            self._devices[device_id]["topology_x"] = x
            self._devices[device_id]["topology_y"] = y
            # Don't reset last_updated here to allow periodic DB sync
            logger.debug(f"Cache: Updated device {device_id} position to ({x}, {y})")

    def get_all(self) -> Optional[Dict[str, Any]]:
        """Return the full topology state from cache."""
        if not self._is_initialized:
            return None
            
        return {
            "devices": list(self._devices.values()),
            "links": self._links,
            "racks": self._racks,
            "cached_at": datetime.fromtimestamp(self._last_updated).isoformat()
        }

    def invalidate(self):
        """Force a reload on next request."""
        self._devices.clear()
        self._links.clear()
        self._racks.clear()
        self._is_initialized = False
        logger.debug("Topology cache invalidated.")

    def clear(self):
        self.invalidate()

    def __setitem__(self, key: Any, value: Any):
        self._devices[key] = value
        self._is_initialized = True

    def __getitem__(self, key: Any) -> Any:
        return self._devices[key]

    def __len__(self) -> int:
        return len(self._devices)

# Global Singleton
topology_cache = TopologyCache()

class DashboardCache:
    """Cache for device lists and dashboard statistics."""
    def __init__(self):
        self._data: Dict[str, Any] = {}
        self._ttl: int = 10  # 10 seconds for stats
        self._expiry: Dict[str, float] = {}

    def get(self, key: str) -> Optional[Any]:
        if key in self._data and time.time() < self._expiry.get(key, 0):
            return self._data[key]
        return None

    def set(self, key: str, value: Any):
        self._data[key] = value
        self._expiry[key] = time.time() + self._ttl

    def invalidate_all(self):
        self._data.clear()
        self._expiry.clear()
        logger.debug("Dashboard cache invalidated.")

    def clear(self):
        self.invalidate_all()

    def __setitem__(self, key: str, value: Any):
        self.set(key, value)

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __len__(self) -> int:
        return len(self._data)

dashboard_cache = DashboardCache()

class DiscoveryCache:
    """Cache for the Network Planner (Discovered Hosts)."""
    def __init__(self):
        self._hosts: List[Dict[str, Any]] = []
        self._last_updated: float = 0
        self._ttl: int = 5  # Very short TTL for discovery
        self._is_valid: bool = False

    def get_hosts(self) -> Optional[List[Dict[str, Any]]]:
        if self._is_valid and (time.time() - self._last_updated) < self._ttl:
            return self._hosts
        return None

    def set_hosts(self, hosts: List[Dict[str, Any]]):
        self._hosts = hosts
        self._last_updated = time.time()
        self._is_valid = True

    def invalidate(self):
        self._hosts.clear()
        self._is_valid = False
        logger.debug("Discovery cache invalidated.")

    def clear(self):
        self.invalidate()

    def __setitem__(self, key: Any, value: Any):
        self._hosts.append(value)
        self._is_valid = True

    def __getitem__(self, index: Any) -> Any:
        return self._hosts[index]

    def __len__(self) -> int:
        return len(self._hosts)

discovery_cache = DiscoveryCache()

