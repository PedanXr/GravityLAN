#!/usr/bin/env python3
"""GravityLAN Agent — Lightweight system metrics collector.

Reads CPU, RAM, disk, temperature, and network metrics from /proc and /sys,
then POSTs them to the GravityLAN server at a configurable interval.

Zero external dependencies — uses only Python stdlib.
Designed for Linux ARM64/x86_64 (Raspberry Pi, servers, VMs).
"""

from __future__ import annotations

import json
import logging
import os
import platform
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Look for config in the same directory as the script
CONFIG_DIR = Path(__file__).parent.absolute()
CONFIG_PATH = CONFIG_DIR / "agent.conf"
VERSION = "1.0.5"

logger = logging.getLogger("gravitylan-agent")
logger.setLevel(logging.INFO)

# File logging for debugging remote deployments
log_file = "/tmp/gravitylan-agent.log"
try:
    file_handler = logging.FileHandler(log_file)
except OSError:
    try:
        log_file = CONFIG_DIR / "gravitylan-agent.log"
        file_handler = logging.FileHandler(log_file)
    except OSError:
        file_handler = None

if file_handler:
    file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logger.addHandler(file_handler)

# Console logging
console_handler = logging.StreamHandler()
console_handler.setFormatter(logging.Formatter('%(levelname)s: %(message)s'))
logger.addHandler(console_handler)


def load_config() -> dict[str, Any]:
    """Load agent configuration from JSON config file.

    Returns:
        Configuration dictionary with server_url, token, interval, etc.

    Raises:
        SystemExit: If config file is missing or invalid.
    """
    if not CONFIG_PATH.exists():
        logger.critical("Config file not found: %s", CONFIG_PATH)
        sys.exit(1)

    with open(CONFIG_PATH, encoding="utf-8") as fh:
        config = json.load(fh)

    required_keys = ("server_url", "token", "device_id")
    for key in required_keys:
        if key not in config:
            logger.critical("Missing required config key: %s", key)
            sys.exit(1)

    # Ensure server_url has a protocol
    if not config["server_url"].startswith(("http://", "https://")):
        logger.info("Adding missing http:// prefix to server_url")
        config["server_url"] = f"http://{config['server_url']}"

    config.setdefault("interval", 30)
    config.setdefault("disk_paths", ["/"])
    config.setdefault("enable_temp", True)
    return config


# Metric Collectors — read directly from /proc and /sys (zero-dependency)
# ---------------------------------------------------------------------------

_prev_cpu: tuple[int, int] | None = None
_prev_lxc_cpu: tuple[float, int] | None = None


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


def collect_cpu(root_path: str = "") -> float:
    """Read CPU utilization percentage from /proc/stat or cgroups inside LXC.

    Uses delta between two readings to calculate accurate usage.
    First call returns 0.0 since there is no previous sample.

    Returns:
        CPU usage percentage (0.0 – 100.0).
    """
    global _prev_cpu, _prev_lxc_cpu

    if is_lxc_container(root_path):
        cpu_ns = get_lxc_cpu_usage_ns(root_path)
        if cpu_ns is not None:
            now_time = time.time()
            if _prev_lxc_cpu is None:
                _prev_lxc_cpu = (now_time, cpu_ns)
                return 0.0

            prev_time, prev_ns = _prev_lxc_cpu
            _prev_lxc_cpu = (now_time, cpu_ns)

            delta_ns = cpu_ns - prev_ns
            delta_time = now_time - prev_time

            if delta_time <= 0 or delta_ns < 0:
                return 0.0

            cpus = get_lxc_cpu_count(root_path)
            delta_time_ns = delta_time * 1e9
            pct = (delta_ns / delta_time_ns) * 100.0 / cpus
            return min(100.0, max(0.0, round(pct, 1)))

    try:
        stat_file = Path(root_path) / "proc/stat"
        with open(stat_file, encoding="utf-8") as fh:
            parts = fh.readline().split()

        # user, nice, system, idle, iowait, irq, softirq, steal
        values = [int(v) for v in parts[1:9]]
        idle = values[3] + values[4]
        total = sum(values)

        if _prev_cpu is None:
            _prev_cpu = (idle, total)
            return 0.0

        prev_idle, prev_total = _prev_cpu
        _prev_cpu = (idle, total)

        delta_idle = idle - prev_idle
        delta_total = total - prev_total

        if delta_total == 0:
            return 0.0

        return round((1.0 - delta_idle / delta_total) * 100, 1)
    except (OSError, ValueError, ZeroDivisionError):
        return 0.0


def collect_ram(root_path: str = "") -> dict[str, int]:
    """Read RAM usage from /proc/meminfo or cgroups inside LXC.

    Returns:
        Dictionary with 'total_mb', 'used_mb', and 'percent' keys.
    """
    if is_lxc_container(root_path):
        ram_data = _collect_ram_lxc(root_path)
        if ram_data is not None:
            return ram_data

    try:
        meminfo: dict[str, int] = {}
        mem_file = Path(root_path) / "proc/meminfo"
        with open(mem_file, encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                key = parts[0].rstrip(":")
                meminfo[key] = int(parts[1])

        total_kb = meminfo.get("MemTotal", 0)
        available_kb = meminfo.get("MemAvailable", 0)
        used_kb = total_kb - available_kb

        total_mb = total_kb // 1024
        used_mb = used_kb // 1024
        percent = round(used_kb / total_kb * 100, 1) if total_kb > 0 else 0.0

        return {"total_mb": total_mb, "used_mb": used_mb, "percent": percent}
    except (OSError, ValueError):
        return {"total_mb": 0, "used_mb": 0, "percent": 0.0}


def _collect_ram_lxc(root_path: str = "") -> dict[str, int] | None:
    """Collect memory metrics using cgroups inside LXC."""
    used_bytes = None
    total_bytes = None

    # Check cgroups v2
    mem_current_v2 = Path(root_path) / "sys/fs/cgroup/memory.current"
    mem_max_v2 = Path(root_path) / "sys/fs/cgroup/memory.max"
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
        mem_current_v1 = Path(root_path) / "sys/fs/cgroup/memory/memory.usage_in_bytes"
        mem_max_v1 = Path(root_path) / "sys/fs/cgroup/memory/memory.limit_in_bytes"
        if mem_current_v1.exists():
            try:
                used_bytes = int(mem_current_v1.read_text(encoding="utf-8").strip())
                if mem_max_v1.exists():
                    limit_val = int(mem_max_v1.read_text(encoding="utf-8").strip())
                    if limit_val < 2**60:
                        total_bytes = limit_val
            except Exception:
                pass

    if used_bytes is None:
        return None

    # Fallback to /proc/meminfo MemTotal if total limit is not set
    if total_bytes is None:
        try:
            meminfo_path = Path(root_path) / "proc/meminfo"
            with open(meminfo_path, encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        total_bytes = int(line.split()[1]) * 1024
                        break
        except Exception:
            pass

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


def collect_disk(paths: list[str]) -> list[dict[str, Any]]:
    """Read disk usage for the given mount paths.

    Uses 'df' command on Linux for better accuracy with ZFS/Unraid pools,
    falling back to os.statvfs if needed.
    """
    results: list[dict[str, Any]] = []

    for mount_path in paths:
        try:
            # Try 'df' first for better accuracy with ZFS pools/quotas
            # -B1 gives output in bytes
            cmd = ["df", "-B1", mount_path]
            output = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode()
            lines = output.strip().split("\n")
            if len(lines) > 1:
                # We take the last line and parse from the end to be safe with long names
                parts = lines[-1].split()
                if len(parts) >= 4:
                    # df -B1 output: Filesystem 1B-blocks Used Available Use% Mounted
                    # We take the last 5 elements to identify size components correctly
                    # regardless of how many spaces the filesystem name has.
                    # Correct mapping from end: 
                    # [-1]: mountpoint, [-2]: percent, [-3]: avail, [-4]: used, [-5]: total
                    fs_name = parts[0]
                    total = int(parts[-5])
                    used = int(parts[-4])
                    avail = int(parts[-3])
                    
                    # Special handling for ZFS: Unraid UI shows Pool stats, but df shows Dataset stats.
                    # We try to use 'zfs list' to get the full pool usage if it's a zfs mount.
                    try:
                        # Check if it's ZFS (df -T or just check if zfs command exists)
                        zfs_cmd = ["zfs", "list", "-H", "-o", "used,avail", "-p", fs_name]
                        zfs_output = subprocess.check_output(zfs_cmd, stderr=subprocess.DEVNULL).decode()
                        zfs_parts = zfs_output.strip().split()
                        if len(zfs_parts) >= 2:
                            # zfs 'used' includes all datasets/snapshots in the pool/hierarchy
                            z_used = int(zfs_parts[0])
                            z_avail = int(zfs_parts[1])
                            total = z_used + z_avail
                            used = z_used
                    except Exception:
                        pass # Not ZFS or zfs command missing, stay with df values
                    
                    # Use base 1000 for GB to match Unraid/Consumer OS display
                    total_gb = round(total / (1000 ** 3), 1)
                    used_gb = round(used / (1000 ** 3), 1)
                    percent = round(used / total * 100, 1) if total > 0 else 0.0

                    results.append({
                        "path": mount_path,
                        "total_gb": total_gb,
                        "used_gb": used_gb,
                        "percent": percent,
                    })
                    continue

        except Exception as exc:
            logger.debug("df failed for %s: %s", mount_path, exc)

        try:
            st = os.statvfs(mount_path)
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            used = total - free
            # Use base 1000 for GB to match Unraid/Consumer OS display
            total_gb = round(total / (1000 ** 3), 1)
            used_gb = round(used / (1000 ** 3), 1)
            percent = round(used / total * 100, 1) if total > 0 else 0.0

            results.append({
                "path": mount_path,
                "total_gb": total_gb,
                "used_gb": used_gb,
                "percent": percent,
            })
        except OSError as exc:
            logger.warning("Cannot read disk for %s: %s", mount_path, exc)

    return results


def collect_temperature(root_path: str = "") -> float | None:
    """Read CPU temperature from /sys/class/thermal.

    Scans thermal zones for CPU-related entries. Returns None if
    temperature monitoring is not available (e.g. in virtual machines).

    Returns:
        Temperature in Celsius or None if unavailable.
    """
    thermal_base = Path(root_path) / "sys/class/thermal"

    if not thermal_base.exists():
        return None

    for zone in sorted(thermal_base.glob("thermal_zone*")):
        temp_file = zone / "temp"
        type_file = zone / "type"

        if not temp_file.exists():
            continue

        try:
            temp_raw = temp_file.read_text().strip()
            temp_c = int(temp_raw) / 1000.0

            # Prefer CPU-related thermal zones
            if type_file.exists():
                zone_type = type_file.read_text().strip().lower()
                if any(kw in zone_type for kw in ("cpu", "soc", "x86", "acpi")):
                    return round(temp_c, 1)

            # Fallback: return first valid reading
            return round(temp_c, 1)
        except (ValueError, OSError):
            continue

    return None


_prev_net: dict[str, tuple[int, int]] | None = None
_prev_net_time: float = 0.0


def collect_network(root_path: str = "") -> dict[str, dict[str, int]]:
    """Read network I/O counters from /proc/net/dev.

    Calculates bytes/sec delta between calls for each interface.
    First call returns zero rates since there is no previous sample.

    Returns:
        Dict mapping interface names to {'rx_bytes_sec', 'tx_bytes_sec'}.
    """
    global _prev_net, _prev_net_time

    current: dict[str, tuple[int, int]] = {}

    net_dev_path = Path(root_path) / "proc/net/dev"
    with open(net_dev_path, encoding="utf-8") as fh:
        for line in fh:
            if ":" not in line:
                continue
            iface, data = line.split(":", 1)
            iface = iface.strip()
            if iface == "lo":
                continue
            parts = data.split()
            rx_bytes = int(parts[0])
            tx_bytes = int(parts[8])
            current[iface] = (rx_bytes, tx_bytes)

    now = time.monotonic()
    delta_time = now - _prev_net_time
    if _prev_net is None or delta_time <= 0:
        _prev_net, _prev_net_time = current, now
        return {iface: {"rx_bytes_sec": 0, "tx_bytes_sec": 0} for iface in current}

    result: dict[str, dict[str, int]] = {}
    for iface, (rx, tx) in current.items():
        prev_rx, prev_tx = _prev_net.get(iface, (rx, tx))
        result[iface] = {
            "rx_bytes_sec": int(max(0, rx - prev_rx) / delta_time),
            "tx_bytes_sec": int(max(0, tx - prev_tx) / delta_time),
        }

    _prev_net, _prev_net_time = current, now
    return result


def collect_system_info() -> dict[str, str]:
    """Collect static system information (hostname, OS, architecture).

    Returns:
        Dictionary with 'hostname', 'os', 'arch', 'kernel' keys.
    """
    info = {
        "hostname": socket.gethostname(),
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "kernel": platform.release(),
    }
    try:
        release: dict[str, str] = {}
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


# ---------------------------------------------------------------------------
# Report Sender
# ---------------------------------------------------------------------------

def send_report(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
    """POST metrics payload to GravityLAN server.

    Args:
        config: Agent configuration containing server_url and token.
        payload: Metrics data to send.

    Returns:
        Server response as dict, or None on failure.
    """
    url = f"{config['server_url']}/api/agent/report"
    data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['token']}",
            "X-Agent-Version": VERSION,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        logger.error("Server returned %d: %s", exc.code, exc.reason)
    except urllib.error.URLError as exc:
        logger.warning("Cannot reach server: %s", exc.reason)
    except Exception as exc:
        logger.error("Unexpected error sending report: %s", exc)

    return None


# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------

_running = True


def _handle_signal(signum: int, frame: Any) -> None:
    """Handle SIGTERM/SIGINT for graceful shutdown."""
    global _running
    logger.info("Received signal %d, shutting down...", signum)
    _running = False


def _cleanup_old_processes() -> None:
    """Find and kill other running agent processes to prevent conflicts."""
    try:
        my_pid = os.getpid()
        # Look for processes running scripts with 'agent.py' in the name
        cmd = ["pgrep", "-f", "agent.py"]
        output = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode().split()
        
        for pid_str in output:
            pid = int(pid_str)
            if pid != my_pid:
                logger.info("Found stale agent process (PID %d), terminating...", pid)
                try:
                    os.kill(pid, signal.SIGTERM)
                    # Give it a moment to die gracefully
                    time.sleep(0.5)
                except OSError:
                    pass
    except Exception:
        # pgrep might not be available or no processes found
        pass


def main() -> None:
    """Agent main entry point — collect and report metrics in a loop."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    # First, clean up any old instances to avoid 401/conflict errors
    _cleanup_old_processes()

    logger.info("GravityLAN Agent v%s starting...", VERSION)
    config = load_config()
    logger.info(
        "Reporting to %s every %ds (device_id=%s)",
        config["server_url"],
        config["interval"],
        config["device_id"],
    )

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    # Initial CPU reading (needs two samples for delta)
    collect_cpu()
    time.sleep(1)

    while _running:
        try:
            payload: dict[str, Any] = {
                "device_id": config["device_id"],
                "agent_version": VERSION,
                "timestamp": time.time(),
                "cpu_percent": collect_cpu(),
                "ram": collect_ram(),
                "disk": collect_disk(config.get("disk_paths", ["/"])),
                "network": collect_network(),
                "system": collect_system_info(),
            }

            if config.get("enable_temp", True):
                temp = collect_temperature()
                if temp is not None:
                    payload["temperature"] = temp

            response = send_report(config, payload)

            if response:
                # Server can push config updates (e.g. new interval)
                if "config" in response:
                    new_conf = response["config"]
                    if "interval" in new_conf:
                        config["interval"] = new_conf["interval"]
                    if "disk_paths" in new_conf:
                        config["disk_paths"] = new_conf["disk_paths"]
                    if "enable_temp" in new_conf:
                        config["enable_temp"] = new_conf["enable_temp"]
                    logger.info("Config updated from server")

        except Exception as exc:
            logger.error("Error in collection loop: %s", exc)

        # Sleep in small increments for responsive shutdown
        for _ in range(config["interval"]):
            if not _running:
                break
            time.sleep(1)

    logger.info("GravityLAN Agent stopped.")


if __name__ == "__main__":
    main()
