#!/usr/bin/env python3
"""
GravityLAN Agent — Modular system metrics collector.

Refactored to apply Separation of Concerns (SoC) and a plugin-like metric architecture
while maintaining zero external dependencies.

Architecture:
- ConfigLoader: Handles validation and default values.
- MetricCollector: Base class for metric plugins.
- ReportSender: Handles network communication with retry logic.
- AgentOrchestrator: Coordinates collection and reporting.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol, Type, Union

# ---------------------------------------------------------------------------
# Constants & Logging
# ---------------------------------------------------------------------------

VERSION = "0.3.8"
AGENT_NAME = "gravitylan-agent"
DEFAULT_CONFIG_FILENAME = "agent.conf"
DEFAULT_LOG_FILENAME = "gravitylan-agent.log"

logger = logging.getLogger(AGENT_NAME)

def setup_logging(config_dir: Path) -> None:
    """Configures logging for both file and console."""
    logger.setLevel(logging.INFO)
    
    log_file = config_dir / DEFAULT_LOG_FILENAME
    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(name)s: %(message)s'))
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter('%(levelname)s: %(message)s'))
    logger.addHandler(console_handler)

# ---------------------------------------------------------------------------
# Configuration Management
# ---------------------------------------------------------------------------

@dataclass
class AgentConfig:
    """Container for agent configuration with validation."""
    server_url: str
    token: str
    device_id: int
    interval: int = 30
    disk_paths: List[str] = field(default_factory=lambda: ["/"])
    enable_temp: bool = True
    enable_patch_check: bool = True
    enable_scanner_relay: bool = False
    config_path: Optional[Path] = None

    @classmethod
    def load(cls, config_path: Path) -> AgentConfig:
        """Loads and validates configuration from a JSON file."""
        if not config_path.exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")

        try:
            with open(config_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in config: {e}")

        # Basic validation
        required = ["server_url", "token", "device_id"]
        for key in required:
            if key not in data:
                raise KeyError(f"Missing required config key: {key}")

        # URL Sanitization
        url = data["server_url"]
        if not url.startswith(("http://", "https://")):
            url = f"http://{url}"
        data["server_url"] = url

        return cls(
            server_url=data["server_url"],
            token=data["token"],
            device_id=int(data["device_id"]),
            interval=data.get("interval", 30),
            disk_paths=data.get("disk_paths", ["/"]),
            enable_temp=data.get("enable_temp", True),
            enable_patch_check=data.get("enable_patch_check", True),
            enable_scanner_relay=data.get("enable_scanner_relay", False),
            config_path=config_path
        )

    def save(self) -> None:
        """Persists current configuration back to disk."""
        if not self.config_path:
            return
        
        try:
            data = asdict(self)
            data.pop("config_path", None) # Don't save the path inside the file
            with open(self.config_path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            logger.info("Configuration persisted to %s", self.config_path)
        except OSError as e:
            logger.error("Failed to save configuration: %s", e)

# ---------------------------------------------------------------------------
# Metric Collection Plugins
# ---------------------------------------------------------------------------

class MetricProvider:
    """Base class for all metric collection logic (Plugin Pattern)."""
    def collect(self, config: AgentConfig) -> Any:
        raise NotImplementedError("Subclasses must implement collect()")

def is_lxc_container(root_path: str = "") -> bool:
    """Detect if running inside an LXC container."""
    # Method 1: Check /run/systemd/container
    try:
        container_path = Path(root_path) / "run/systemd/container"
        if container_path.exists():
            return container_path.read_text(encoding="utf-8").strip() == "lxc"
    except Exception:
        pass

    # Method 2: Check /proc/self/cgroup
    try:
        cgroup_path = Path(root_path) / "proc/self/cgroup"
        if cgroup_path.exists():
            with open(cgroup_path, encoding="utf-8") as fh:
                content = fh.read()
                if "lxc" in content or "/lxc/" in content:
                    return True
    except Exception:
        pass

    # Method 3: Check /proc/1/environ (if readable)
    try:
        environ_path = Path(root_path) / "proc/1/environ"
        if environ_path.exists():
            with open(environ_path, "rb") as fh:
                env = fh.read().split(b"\x00")
                for item in env:
                    if item.startswith(b"container=lxc"):
                        return True
    except Exception:
        pass

    return False


def get_lxc_cpu_count(root_path: str = "") -> float:
    """Get the CPU limit count for the LXC container from cgroups or host count."""
    # 1. Try cgroup v2 cpu.max
    cpu_max_v2 = Path(root_path) / "sys/fs/cgroup/cpu.max"
    if cpu_max_v2.exists():
        try:
            parts = cpu_max_v2.read_text(encoding="utf-8").strip().split()
            if len(parts) == 2 and parts[0] != "max":
                limit = int(parts[0])
                period = int(parts[1])
                if period > 0:
                    return limit / period
        except Exception:
            pass

    # 2. Try cgroup v1 cfs_quota/period
    quota_v1 = Path(root_path) / "sys/fs/cgroup/cpu/cpu.cfs_quota_us"
    period_v1 = Path(root_path) / "sys/fs/cgroup/cpu/cpu.cfs_period_us"
    if quota_v1.exists() and period_v1.exists():
        try:
            quota = int(quota_v1.read_text(encoding="utf-8").strip())
            period = int(period_v1.read_text(encoding="utf-8").strip())
            if quota > 0 and period > 0:
                return quota / period
        except Exception:
            pass

    # Fallback to host CPU count
    return os.cpu_count() or 1.0


def get_lxc_cpu_usage_ns(root_path: str = "") -> int | None:
    """Get LXC CPU total usage time in nanoseconds."""
    # Try cgroup v2
    cpu_stat_v2 = Path(root_path) / "sys/fs/cgroup/cpu.stat"
    if cpu_stat_v2.exists():
        try:
            for line in cpu_stat_v2.read_text(encoding="utf-8").splitlines():
                if line.startswith("usage_usec"):
                    return int(line.split()[1]) * 1000
        except Exception:
            pass

    # Try cgroup v1
    cpu_usage_v1 = Path(root_path) / "sys/fs/cgroup/cpuacct/cpuacct.usage"
    if cpu_usage_v1.exists():
        try:
            return int(cpu_usage_v1.read_text(encoding="utf-8").strip())
        except Exception:
            pass

    return None


class CPUMetrics(MetricProvider):
    """Calculates CPU usage percentage using /proc/stat delta or cgroups inside LXC."""
    def __init__(self, root_path: str = "/"):
        self.root_path = root_path
        self.prev_idle = 0
        self.prev_total = 0
        self.prev_lxc_time = 0.0
        self.prev_lxc_ns = 0

    def collect(self, config: AgentConfig) -> float:
        if is_lxc_container(self.root_path):
            cpu_ns = get_lxc_cpu_usage_ns(self.root_path)
            if cpu_ns is not None:
                now_time = time.time()
                if self.prev_lxc_time == 0.0:
                    self.prev_lxc_time, self.prev_lxc_ns = now_time, cpu_ns
                    return 0.0
                
                delta_ns = cpu_ns - self.prev_lxc_ns
                delta_time = now_time - self.prev_lxc_time
                self.prev_lxc_time, self.prev_lxc_ns = now_time, cpu_ns

                if delta_time <= 0 or delta_ns < 0:
                    return 0.0

                cpus = get_lxc_cpu_count(self.root_path)
                delta_time_ns = delta_time * 1e9
                pct = (delta_ns / delta_time_ns) * 100.0 / cpus
                return min(100.0, max(0.0, round(pct, 1)))

        # Fallback to standard host /proc/stat
        try:
            stat_path = Path(self.root_path) / "proc/stat"
            with open(stat_path, encoding="utf-8") as fh:
                parts = fh.readline().split()
            
            # user, nice, system, idle, iowait, irq, softirq, steal
            values = [int(v) for v in parts[1:9]]
            idle = values[3] + values[4]
            total = sum(values)

            if self.prev_total == 0:
                self.prev_idle, self.prev_total = idle, total
                return 0.0

            delta_idle = idle - self.prev_idle
            delta_total = total - self.prev_total
            self.prev_idle, self.prev_total = idle, total

            if delta_total == 0:
                return 0.0

            return round((1.0 - delta_idle / delta_total) * 100, 1)
        except (OSError, ValueError, ZeroDivisionError):
            return 0.0

class RAMMetrics(MetricProvider):
    """Reads memory utilization from /proc/meminfo or cgroups inside LXC."""
    def __init__(self, root_path: str = "/"):
        self.root_path = root_path

    def collect(self, config: AgentConfig) -> Dict[str, Any]:
        if is_lxc_container(self.root_path):
            ram_data = self._collect_lxc()
            if ram_data is not None:
                return ram_data

        # Fallback to standard /proc/meminfo
        try:
            meminfo: Dict[str, int] = {}
            meminfo_path = Path(self.root_path) / "proc/meminfo"
            with open(meminfo_path, encoding="utf-8") as fh:
                for line in fh:
                    parts = line.split()
                    if len(parts) >= 2:
                        meminfo[parts[0].rstrip(":")] = int(parts[1])
            
            total_kb = meminfo.get("MemTotal", 0)
            available_kb = meminfo.get("MemAvailable", 0)
            used_kb = total_kb - available_kb

            return {
                "total_mb": total_kb // 1024,
                "used_mb": used_kb // 1024,
                "percent": round(used_kb / total_kb * 100, 1) if total_kb > 0 else 0.0
            }
        except (OSError, ValueError):
            return {"total_mb": 0, "used_mb": 0, "percent": 0.0}

    def _collect_lxc(self) -> Dict[str, Any] | None:
        """Collect memory metrics using cgroups inside LXC."""
        used_bytes, total_bytes = self._lxc_memory_limits()

        if used_bytes is None:
            return None

        # Fallback to /proc/meminfo MemTotal if total limit is not set
        if total_bytes is None:
            total_bytes = self._meminfo_total()

        if total_bytes is None or total_bytes == 0:
            return None

        total_mb = total_bytes // (1024 * 1024)
        used_mb = used_bytes // (1024 * 1024)
        percent = round(used_bytes / total_bytes * 100, 1)

        return {
            "total_mb": total_mb,
            "used_mb": used_mb,
            "percent": percent
        }

    def _lxc_memory_limits(self) -> tuple[int | None, int | None]:
        """Read (used_bytes, total_bytes) from cgroups v2, then v1."""
        used_bytes = None
        total_bytes = None

        # Check cgroups v2
        mem_current_v2 = Path(self.root_path) / "sys/fs/cgroup/memory.current"
        mem_max_v2 = Path(self.root_path) / "sys/fs/cgroup/memory.max"
        if mem_current_v2.exists():
            try:
                used_bytes = int(mem_current_v2.read_text(encoding="utf-8").strip())
                if mem_max_v2.exists():
                    max_str = mem_max_v2.read_text(encoding="utf-8").strip()
                    if max_str != "max":
                        total_bytes = int(max_str)
            except Exception:
                pass

        # Check cgroups v1
        if used_bytes is None:
            mem_current_v1 = Path(self.root_path) / "sys/fs/cgroup/memory/memory.usage_in_bytes"
            mem_max_v1 = Path(self.root_path) / "sys/fs/cgroup/memory/memory.limit_in_bytes"
            if mem_current_v1.exists():
                try:
                    used_bytes = int(mem_current_v1.read_text(encoding="utf-8").strip())
                    if mem_max_v1.exists():
                        limit_val = int(mem_max_v1.read_text(encoding="utf-8").strip())
                        if limit_val < 2**60:
                            total_bytes = limit_val
                except Exception:
                    pass

        return used_bytes, total_bytes

    def _meminfo_total(self) -> int | None:
        """Read MemTotal from /proc/meminfo in bytes (or None when unavailable)."""
        try:
            meminfo_path = Path(self.root_path) / "proc/meminfo"
            with open(meminfo_path, encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        return int(line.split()[1]) * 1024
        except Exception:
            pass
        return None

def _collect_zfs_stats() -> Dict[str, Dict[str, int]]:
    """Pre-fetch ZFS dataset stats: {mountpoint: {used, avail, refer}}."""
    zfs_stats: Dict[str, Dict[str, int]] = {}
    try:
        cmd = ["zfs", "list", "-H", "-p", "-o", "mountpoint,used,avail,refer"]
        output = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode()
        for line in output.strip().split("\n"):
            m, used, avail, refer = line.split("\t")
            if m != "none":
                zfs_stats[m] = {
                    "used": int(used),
                    "avail": int(avail),
                    "refer": int(refer)
                }
    except Exception:
        pass
    return zfs_stats


def _discover_mount_targets(default_paths: List[str]) -> set:
    """Auto-discover physical mounts when the default '/' config is used."""
    targets = set(default_paths)
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) < 3:
                    continue
                dev, mount, fstype = parts[0], parts[1], parts[2]
                if fstype in ("ext4", "xfs", "zfs", "btrfs", "ntfs", "fuse.shfs") or mount.startswith("/mnt/"):
                    if any(x in mount for x in ("/docker/", "/container/", "/kubelet/")):
                        continue
                    targets.add(mount)
    except Exception:
        pass
    return targets


class DiskMetrics(MetricProvider):
    """Reads disk usage for configured paths and automatically discovers physical/ZFS mounts."""
    def collect(self, config: AgentConfig) -> List[Dict[str, Any]]:
        # 1. Determine if we should use auto-discovery
        is_default = len(config.disk_paths) == 1 and config.disk_paths[0] == "/"
        targets = set(config.disk_paths)

        # 2. Pre-fetch ZFS stats if available
        zfs_stats = _collect_zfs_stats()

        if is_default:
            targets = _discover_mount_targets(list(targets))

        results = []
        seen_devices = set()

        for path in sorted(list(targets)):
            try:
                # 3. Use ZFS stats if available for this path
                if path in zfs_stats:
                    z = zfs_stats[path]
                    total = z["used"] + z["avail"]
                    used = z["used"]
                else:
                    # 4. Fallback to statvfs
                    st = os.statvfs(path)
                    fs_id = f"{st.f_blocks}-{st.f_files}"
                    if fs_id in seen_devices and path != "/":
                        continue
                    seen_devices.add(fs_id)
                    total = st.f_blocks * st.f_frsize
                    used = total - (st.f_bavail * st.f_frsize)

                if total == 0:
                    continue

                results.append({
                    "path": path,
                    "total_gb": round(total / (1024**3), 1),
                    "used_gb": round(used / (1024**3), 1),
                    "percent": round(used / total * 100, 1)
                })
            except (OSError, PermissionError):
                continue

        return results

class NetworkMetrics(MetricProvider):
    """Calculates network throughput (bytes per second) per interface from /proc/net/dev."""
    def __init__(self, root_path: str = "/"):
        self.root_path = root_path
        self.prev_counters: Dict[str, tuple[int, int]] = {}
        self.prev_time: float = 0.0

    def collect(self, config: AgentConfig) -> Dict[str, Dict[str, int]]:
        current: Dict[str, tuple[int, int]] = {}
        try:
            with open(Path(self.root_path) / "proc/net/dev", encoding="utf-8") as fh:
                for line in fh:
                    if ":" not in line: continue
                    iface, data = line.split(":", 1)
                    iface = iface.strip()
                    if iface == "lo": continue
                    parts = data.split()
                    if len(parts) >= 9:
                        current[iface] = (int(parts[0]), int(parts[8]))
        except (OSError, ValueError):
            return {}

        now = time.monotonic()
        delta_time = now - self.prev_time
        first_run = self.prev_time == 0.0 or delta_time <= 0

        result = {}
        for iface, (rx, tx) in current.items():
            if first_run:
                result[iface] = {"rx_bytes_sec": 0, "tx_bytes_sec": 0}
                continue
            prev_rx, prev_tx = self.prev_counters.get(iface, (rx, tx))
            result[iface] = {
                "rx_bytes_sec": int(max(0, rx - prev_rx) / delta_time),
                "tx_bytes_sec": int(max(0, tx - prev_tx) / delta_time),
            }

        self.prev_counters = current
        self.prev_time = now
        return result

class SystemInfoProvider(MetricProvider):
    """Provides static system metadata (hostname, OS, architecture, kernel)."""
    def collect(self, config: AgentConfig) -> Dict[str, str]:
        info = {
            "hostname": socket.gethostname(),
            "os": f"{platform.system()} {platform.release()}",
            "arch": platform.machine(),
            "kernel": platform.release(),
        }
        try:
            release: Dict[str, str] = {}
            for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
                if "=" in line:
                    key, _, value = line.partition("=")
                    release[key.strip()] = value.strip().strip('"').strip("'")
            if release:
                pretty = release.get("PRETTY_NAME") or ""
                fallback = f"{release.get('NAME', '')} {release.get('VERSION_ID', '')}".strip()
                info["os"] = pretty or fallback or info["os"]
                info["os_name"] = release.get("NAME") or platform.system()
                info["os_version"] = release.get("VERSION_ID") or platform.release()
                if release.get("VERSION_CODENAME"):
                    info["os_codename"] = release["VERSION_CODENAME"]
        except (OSError, UnicodeDecodeError):
            pass
        return info

class ThermalMetrics(MetricProvider):
    """Reads CPU temperature from sysfs thermal zones."""
    def __init__(self, root_path: str = "/"):
        self.root_path = root_path

    def collect(self, config: AgentConfig) -> Optional[float]:
        if not config.enable_temp:
            return None

        base_path = Path(self.root_path) / "sys/class/thermal"
        if not base_path.exists():
            return None

        for zone in sorted(base_path.glob("thermal_zone*")):
            try:
                temp_c = int((zone / "temp").read_text().strip()) / 1000.0
                z_type = (zone / "type").read_text().strip().lower()
                if any(kw in z_type for kw in ("cpu", "soc", "x86", "acpi")):
                    return round(temp_c, 1)
            except (ValueError, OSError):
                continue
        return None

def _apt_cache_is_stale(max_age_seconds: int = 3600) -> bool:
    """True when the local apt package-list cache is older than max_age."""
    lists_dir = Path("/var/lib/apt/lists")
    if not lists_dir.is_dir():
        return True
    try:
        newest = 0.0
        for p in lists_dir.iterdir():
            if p.name.endswith("_Packages"):
                newest = max(newest, p.stat().st_mtime)
        return time.time() - newest > max_age_seconds
    except OSError:
        return True


def _run_apt_update(timeout: int = 90) -> bool:
    """Refresh apt package lists; falls back to `sudo -n` when not root."""
    for cmd in (
        ["apt-get", "update", "-o", "Acquire::Retries=1"],
        ["sudo", "-n", "apt-get", "update", "-o", "Acquire::Retries=1"],
    ):
        try:
            res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
            if res.returncode == 0:
                return True
        except subprocess.SubprocessError:
            continue
    return False


# Package databases; their mtime changes whenever packages are installed or upgraded.
_PACKAGE_DB_PATHS = (
    "/var/lib/dpkg/status",
    "/var/lib/rpm/rpmdb.sqlite",
    "/var/lib/rpm/Packages",
    "/usr/lib/sysimage/rpm/rpmdb.sqlite",
)


def _package_db_mtime() -> float:
    """Newest mtime of the local package database (0.0 when none is found)."""
    newest = 0.0
    for path in _PACKAGE_DB_PATHS:
        try:
            newest = max(newest, Path(path).stat().st_mtime)
        except OSError:
            continue
    return newest


class PatchMetrics(MetricProvider):
    """Calculates package updates, security updates, and reboot requirement.

    The package-manager checks start several subprocesses (and may refresh the
    package lists), so the result is cached for ``cache_ttl`` seconds. The cache
    is dropped early when the package database changes, so finished updates show
    up in the next report instead of after up to an hour.
    """

    def __init__(self, cache_ttl: int = 3600):
        self.cache_ttl = cache_ttl
        self._last_check: float = 0.0
        self._cached_result: Optional[Dict[str, Any]] = None
        self._cached_db_mtime: float = 0.0

    def collect(self, config: AgentConfig) -> Optional[Dict[str, Any]]:
        if not getattr(config, "enable_patch_check", True):
            return None

        now = time.monotonic()
        db_mtime = _package_db_mtime()
        cache_valid = (
            self._last_check != 0.0
            and now - self._last_check < self.cache_ttl
            and db_mtime == self._cached_db_mtime
        )
        if cache_valid:
            return dict(self._cached_result) if self._cached_result else None

        result = self._check_packages()
        self._last_check = now
        self._cached_db_mtime = db_mtime
        self._cached_result = result
        return dict(result) if result else None

    def _check_packages(self) -> Optional[Dict[str, Any]]:
        """Run the package-manager checks for the first manager found."""
        result: Dict[str, Any] = {
            "patch_available": 0,
            "patch_security": 0,
            "patch_manager": None,
            "reboot_required": False,
            "major_upgrade_available": None
        }

        # 1. Debian/Ubuntu (apt)
        if shutil.which("apt-get"):
            result["patch_manager"] = "apt"
            self._collect_apt(result)

        # 2. Fedora/CentOS/RHEL (dnf/yum)
        elif shutil.which("dnf"):
            result["patch_manager"] = "dnf"
            self._collect_dnf(result)

        elif shutil.which("yum"):
            result["patch_manager"] = "yum"
            self._collect_yum(result)

        if result["patch_manager"]:
            return result
        return None

    @staticmethod
    def _count_apt_upgrades(out: str) -> tuple[int, int]:
        """Count total and security upgrades from 'apt-get -s upgrade' output."""
        available = 0
        security = 0
        for line in out.splitlines():
            if line.startswith("Inst "):
                available += 1
                if "-security" in line.lower() or "security" in line.lower():
                    security += 1
        return available, security

    def _collect_apt(self, result: Dict[str, Any]) -> None:
        """Populate patch counts via the apt package manager."""
        try:
            # Refresh package lists if the local cache is stale (>= 1h).
            # Without this, `apt-get -s upgrade` only sees stale data and
            # reports 0 updates until someone runs apt-get update manually.
            if _apt_cache_is_stale() and not _run_apt_update():
                logger.warning("apt-get update failed; using stale package cache")

            # Run simulate upgrade without locks
            cmd = ["apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade"]
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=10).decode("utf-8")

            available, security = self._count_apt_upgrades(out)
            result["patch_available"] = available
            result["patch_security"] = security
        except Exception:
            pass

        # Check if reboot is required
        result["reboot_required"] = os.path.exists("/var/run/reboot-required")

        # Check for major release upgrade (e.g. Ubuntu 22.04 -> 24.04)
        if shutil.which("do-release-upgrade"):
            self._collect_major_upgrade(result)

    def _collect_major_upgrade(self, result: Dict[str, Any]) -> None:
        """Detect a major release upgrade (e.g. Ubuntu 22.04 -> 24.04) via do-release-upgrade."""
        try:
            cmd = ["do-release-upgrade", "-c"]
            out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=10).decode("utf-8")
            for line in out.splitlines():
                if "New release" in line and "available" in line:
                    parts = line.split("'")
                    if len(parts) >= 3:
                        result["major_upgrade_available"] = parts[1]
        except Exception:
            pass

    def _collect_dnf(self, result: Dict[str, Any]) -> None:
        """Populate patch counts via the dnf package manager."""
        try:
            cmd = ["dnf", "check-update", "--quiet"]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
            out = proc.stdout.decode("utf-8")

            lines = [l.strip() for l in out.splitlines() if l.strip()]
            pkg_count = 0
            for line in lines:
                parts = line.split()
                if len(parts) >= 3 and not line.startswith("Last metadata"):
                    pkg_count += 1
            result["patch_available"] = pkg_count

            # Security count
            cmd_sec = ["dnf", "updateinfo", "list", "security", "--quiet"]
            proc_sec = subprocess.run(cmd_sec, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
            out_sec = proc_sec.stdout.decode("utf-8")
            sec_count = 0
            for line in out_sec.splitlines():
                if line.strip() and not line.startswith("Last metadata"):
                    sec_count += 1
            result["patch_security"] = sec_count
        except Exception:
            pass

        if shutil.which("needs-restarting"):
            try:
                res = subprocess.run(["needs-restarting", "-r"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if res.returncode == 1:
                    result["reboot_required"] = True
            except Exception:
                pass

    def _collect_yum(self, result: Dict[str, Any]) -> None:
        """Populate patch counts via the yum package manager."""
        try:
            cmd = ["yum", "check-update", "--quiet"]
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
            out = proc.stdout.decode("utf-8")
            lines = [l.strip() for l in out.splitlines() if l.strip()]
            pkg_count = 0
            for line in lines:
                parts = line.split()
                if len(parts) >= 3:
                    pkg_count += 1
            result["patch_available"] = pkg_count
        except Exception:
            pass

class ArpNeighborCollector(MetricProvider):
    """Collects Layer-2 ARP neighbors from /proc/net/arp when enable_scanner_relay is True."""

    def __init__(self):
        self.last_probe_time = 0.0

    def collect(self, config: AgentConfig) -> Optional[List[Dict[str, str]]]:
        if not getattr(config, "enable_scanner_relay", False):
            return None

        # Periodically refresh ARP cache via lightweight broadcast / subnet probe (every 5 minutes)
        now = time.time()
        if now - self.last_probe_time > 300:
            self._probe_local_subnets()
            self.last_probe_time = now

        return self._read_arp_table()

    def _read_arp_table(self) -> List[Dict[str, str]]:
        arp_path = Path("/proc/net/arp")
        if not arp_path.exists():
            return []

        neighbors: List[Dict[str, str]] = []
        try:
            with open(arp_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            # Header: IP address HW type Flags HW address Mask Device
            for line in lines[1:]:
                parts = line.split()
                if len(parts) >= 6:
                    ip = parts[0]
                    flags = parts[2]
                    mac = parts[3].lower()
                    dev = parts[5]

                    # 0x2 = ATF_COM (completed ARP resolution)
                    # Ignore incomplete entries or broadcast/null MACs
                    if flags == "0x2" and mac and mac != "00:00:00:00:00:00":
                        neighbors.append({
                            "ip": ip,
                            "mac": mac,
                            "interface": dev
                        })
        except Exception as e:
            logger.debug("Failed to read /proc/net/arp: %s", e)

        return neighbors

    def _probe_local_subnets(self) -> None:
        """Triggers quick ping broadcast/probes to refresh local kernel ARP entries."""
        try:
            # Send single ping to local broadcast
            subprocess.run(
                ["ping", "-b", "-c", "1", "-W", "1", "255.255.255.255"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2
            )
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Reporting & Communication
# ---------------------------------------------------------------------------

class ReportSender:
    """Handles reporting with retry and exponential backoff."""
    def __init__(self, config: AgentConfig):
        self.config = config
        self.base_url = f"{config.server_url}/api/agent/report"
        self.consecutive_failures = 0

    def send(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Sends payload with a simple retry/backoff mechanism."""
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.base_url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.config.token}",
                "X-Agent-Version": VERSION,
            },
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                self.consecutive_failures = 0
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout) as e:
            self.consecutive_failures += 1
            wait_time = min(self.consecutive_failures * 5, 60)
            logger.warning("Report delivery failed (%s). Backing off for %ds.", e, wait_time)
            return None
        except Exception as e:
            logger.error("Unexpected error in ReportSender: %s", e)
            return None

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

class AgentOrchestrator:
    """Coordinates metric collection and reporting loop."""
    def __init__(self, config: AgentConfig):
        self.config = config
        self.running = True
        self.reporter = ReportSender(config)
        
        # Initialize collectors (Plugin Registry)
        self.collectors: Dict[str, MetricProvider] = {
            "cpu_percent": CPUMetrics(),
            "ram": RAMMetrics(),
            "disk": DiskMetrics(),
            "network": NetworkMetrics(),
            "system": SystemInfoProvider(),
            "temperature": ThermalMetrics(),
            "patches": PatchMetrics(),
            "arp_table": ArpNeighborCollector()
        }

        # Setup Signal Handlers
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)

    def stop(self, *args) -> None:
        """Triggers graceful shutdown."""
        logger.info("Shutdown signal received. Stopping agent...")
        self.running = False

    def collect_all(self) -> Dict[str, Any]:
        """Runs all registered collectors."""
        payload = {
            "device_id": self.config.device_id,
            "agent_version": VERSION,
            "timestamp": time.time(),
        }
        
        for key, collector in self.collectors.items():
            value = collector.collect(self.config)
            if value is not None:
                payload[key] = value
        
        return payload

    def process_response(self, response: Dict[str, Any]) -> None:
        """Updates internal config based on server feedback."""
        changed = False
        
        # Device ID Sync
        if response.get("device_id") and response["device_id"] != self.config.device_id:
            logger.info("Updating Device ID to %s", response["device_id"])
            self.config.device_id = response["device_id"]
            changed = True
        
        # Runtime Config Updates
        remote_conf = response.get("config")
        if remote_conf and isinstance(remote_conf, dict):
            if "interval" in remote_conf and self.config.interval != remote_conf["interval"]:
                self.config.interval = remote_conf["interval"]
                changed = True
            if "disk_paths" in remote_conf and self.config.disk_paths != remote_conf["disk_paths"]:
                self.config.disk_paths = remote_conf["disk_paths"]
                changed = True
            if "enable_temp" in remote_conf and self.config.enable_temp != remote_conf["enable_temp"]:
                self.config.enable_temp = remote_conf["enable_temp"]
                changed = True
            if "enable_patch_check" in remote_conf and self.config.enable_patch_check != remote_conf["enable_patch_check"]:
                self.config.enable_patch_check = remote_conf["enable_patch_check"]
                changed = True
            if "enable_scanner_relay" in remote_conf and self.config.enable_scanner_relay != remote_conf["enable_scanner_relay"]:
                self.config.enable_scanner_relay = bool(remote_conf["enable_scanner_relay"])
                changed = True

        if changed:
            self.config.save()

    def run(self) -> None:
        """Main execution loop."""
        logger.info("%s v%s started. Monitoring every %ds.", AGENT_NAME, VERSION, self.config.interval)
        
        # Warm up delta collectors
        self.collectors["cpu_percent"].collect(self.config)
        self.collectors["network"].collect(self.config)
        time.sleep(1)

        while self.running:
            try:
                payload = self.collect_all()
                response = self.reporter.send(payload)
                if response:
                    self.process_response(response)
            except Exception as e:
                logger.error("Error in orchestrator loop: %s", e)

            # Responsive sleep
            for _ in range(self.config.interval):
                if not self.running: break
                time.sleep(1)

        logger.info("%s stopped.", AGENT_NAME)

# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

def _is_agent_process(args: str) -> bool:
    """True for a Python interpreter running gravitylan-agent.py (not an editor or `tail` on its files)."""
    argv = args.split()
    if not argv or not Path(argv[0]).name.startswith("python"):
        return False
    return any(Path(arg).name == f"{AGENT_NAME}.py" for arg in argv[1:])


def cleanup_ghosts() -> None:
    """Kills other running instances of the agent to avoid conflicts."""
    try:
        my_pid = os.getpid()
        output = subprocess.check_output(["ps", "-eo", "pid=,args="]).decode()
    except (OSError, subprocess.SubprocessError):
        return

    for line in output.splitlines():
        try:
            pid_str, args = line.strip().split(None, 1)
            pid = int(pid_str)
        except ValueError:
            continue
        if pid == my_pid or not _is_agent_process(args):
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            logger.info("Cleaned up ghost process %d", pid)
        except OSError:
            continue

def main() -> None:
    """Application entry point."""
    script_dir = Path(__file__).parent.absolute()
    config_path = script_dir / DEFAULT_CONFIG_FILENAME
    
    setup_logging(script_dir)
    cleanup_ghosts()

    try:
        config = AgentConfig.load(config_path)
        agent = AgentOrchestrator(config)
        agent.run()
    except Exception as e:
        logger.critical("Fatal startup error: %s", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
