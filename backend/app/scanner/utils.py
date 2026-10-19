"""Utility functions for network discovery and group management."""

import asyncio
import ipaddress
import logging
import os
import re
import socket
import ssl
import subprocess
import sys
import time
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device import DeviceGroup
from app.schemas.scan import SubnetInfo


def ensure_utc(dt: datetime | None) -> datetime | None:
    """Ensure a datetime is timezone-aware (UTC). SQLite stores naive datetimes."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt

logger = logging.getLogger(__name__)


def get_auto_scan_subnets() -> list[str]:
    """Returns a list of CIDR subnets that are suitable for automatic scanning (non-virtual)."""
    all_subnets = get_local_subnets()
    return [s.subnet for s in all_subnets if not s.is_virtual]

DEFAULT_GROUPS = [
    {"name": "Firewalls", "icon": "shield", "sort_order": 0, "is_default": True},
    {"name": "Server", "icon": "server", "sort_order": 1, "is_default": True},
    {"name": "NAS / Storage", "icon": "hard-drive", "sort_order": 2, "is_default": True},
    {"name": "Web Interfaces", "icon": "globe", "sort_order": 3, "is_default": True},
    {"name": "Newly discovered", "icon": "sparkles", "sort_order": 99, "is_default": True},
]

GROUP_TYPE_MAP = {
    "firewall": "Firewalls",
    "server": "Server",
    "nas": "NAS / Storage",
    "webui": "Web Interfaces",
    "unknown": "Newly discovered",
}

async def ensure_default_groups(db: AsyncSession, commit: bool = True) -> dict[str, int]:
    """Create default groups if they don't exist."""
    result = await db.execute(select(DeviceGroup))
    existing = {g.name: g.id for g in result.scalars().all()}
    for group_data in DEFAULT_GROUPS:
        if group_data["name"] not in existing:
            group = DeviceGroup(**group_data)
            db.add(group)
            await db.flush()
            existing[group.name] = group.id
    if commit:
        await db.commit()
    return existing

def get_local_subnets() -> list[SubnetInfo]:
    """
    Ultimate Subnet Detector: Detects local interfaces using a multi-stage fallback.
    Inspired by SchaeferAdminTool's robust network discovery.
    """
    subnets: list[SubnetInfo] = []
    seen_subnets = set()

    # STAGE 1: psutil (Very reliable if installed)
    _collect_psutil_subnets(subnets, seen_subnets)

    # STAGE 2: netifaces (Alternative if psutil is missing)
    if not subnets:
        _collect_netifaces_subnets(subnets, seen_subnets)

    # STAGE 3: PowerShell (Native Windows Truth)
    if not subnets and sys.platform == 'win32':
        _collect_powershell_subnets(subnets, seen_subnets)

    # STAGE 4: Final socket fallback
    if not subnets:
        _collect_socket_subnets(subnets, seen_subnets)

    # LAST RESORT: If no "physical" subnets were found, return all of them
    # so the user isn't stuck with an empty list during setup.
    physical_subnets = [s for s in subnets if not s.is_virtual]
    return physical_subnets if physical_subnets else subnets


# Filter list for common virtual/tunnel interfaces
# We are more selective now:
# 'br-' is usually docker, but 'br0' is often the main physical bridge on Unraid/NAS.
VIRTUAL_IFACE_KEYWORDS = [
    'vbox', 'vmware', 'vEthernet', 'tailscale', 'zerotier',
    'wsl', 'tunnel', 'loopback', 'pseudo', 'veth'
]


def _is_virtual_interface(name: str, ip: str) -> bool:
    """Heuristic detection of virtual/tunnel/Docker interfaces."""
    if any(kw.lower() in name.lower() for kw in VIRTUAL_IFACE_KEYWORDS):
        return True
    # Docker bridges (usually 'docker0' or 'br-XXXXX')
    if name.lower().startswith('docker') or name.lower().startswith('br-'):
        return True
    # Known virtual IP ranges (fallback check): 172.17.0.0/16 is the default docker bridge
    if ip.startswith("172."):
        # If the interface name is generic like 'eth0' but has a 172 IP,
        # and we are NOT in host mode, it's likely a docker bridge.
        if name.lower() == 'eth0' or name.lower().startswith('veth'):
            return True
    return False


def _add_subnet(subnets: list[SubnetInfo], seen_subnets: set, name: str, ip: str, mask: str) -> None:
    """Append a unique subnet entry, skipping loopback/link-local and virtual interfaces."""
    if not ip or ip.startswith("127.") or ip.startswith("169.254."):
        return

    is_virtual = _is_virtual_interface(name, ip)

    try:
        network = ipaddress.IPv4Network(f"{ip}/{mask}", strict=False)
        subnet_str = str(network)
        if subnet_str not in seen_subnets:
            subnets.append(SubnetInfo(
                interface_name=name,
                ip_address=ip,
                subnet=subnet_str,
                netmask=mask,
                is_virtual=is_virtual
            ))
            seen_subnets.add(subnet_str)
    except (ValueError, OSError):
        pass


def _is_usable_psutil_interface(name: str, stats) -> bool:
    """Return False for disabled or loopback interfaces."""
    if name in stats and not stats[name].isup:
        return False
    if "loopback" in name.lower() or name.startswith("lo"):
        return False
    return True


def _collect_psutil_subnets(subnets: list[SubnetInfo], seen_subnets: set) -> None:
    """STAGE 1: Collect subnets via psutil (very reliable if installed)."""
    try:
        import psutil
        interfaces = psutil.net_if_addrs()
        stats = psutil.net_if_stats()
        for name, addrs in interfaces.items():
            if not _is_usable_psutil_interface(name, stats):
                continue
            for addr in addrs:
                if addr.family == socket.AF_INET:
                    _add_subnet(subnets, seen_subnets, name, addr.address, addr.netmask or "255.255.255.0")
    except Exception:
        pass


def _collect_netifaces_subnets(subnets: list[SubnetInfo], seen_subnets: set) -> None:
    """STAGE 2: Collect subnets via netifaces (alternative if psutil is missing)."""
    try:
        import netifaces
        for iface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(iface)
            if netifaces.AF_INET not in addrs:
                continue
            for addr_info in addrs[netifaces.AF_INET]:
                _add_subnet(subnets, seen_subnets, iface, addr_info.get("addr"), addr_info.get("netmask", "255.255.255.0"))
    except Exception:
        pass


def _collect_powershell_subnets(subnets: list[SubnetInfo], seen_subnets: set) -> None:
    """STAGE 3: Collect subnets via PowerShell (native Windows truth)."""
    try:
        import json
        ps_cmd = "Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength | ConvertTo-Json"
        output = subprocess.check_output(["powershell", "-Command", ps_cmd], timeout=10.0).decode('cp850')
        data = json.loads(output)
        if isinstance(data, dict):
            data = [data]
        for item in data:
            ip = item.get("IPAddress")
            prefix = item.get("PrefixLength")
            name = item.get("InterfaceAlias", "Windows Adapter")
            if ip and prefix:
                # Convert prefix to mask
                mask = str(ipaddress.IPv4Network(f"0.0.0.0/{prefix}").netmask)
                _add_subnet(subnets, seen_subnets, name, ip, mask)
    except Exception:
        pass


def _collect_socket_subnets(subnets: list[SubnetInfo], seen_subnets: set) -> None:
    """STAGE 4: Final socket fallback via hostname resolution."""
    try:
        hostname = socket.gethostname()
        _, _, ip_list = socket.gethostbyname_ex(hostname)
        for ip in ip_list:
            _add_subnet(subnets, seen_subnets, "default", ip, "255.255.255.0")
    except OSError:
        pass

async def check_port_async(ip: str, port: int, timeout: float = 0.4) -> bool:
    """Async check if a TCP port is open."""
    try:
        conn = asyncio.open_connection(ip, port)
        _, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        await writer.wait_closed()
        return True
    except (TimeoutError, OSError, ConnectionRefusedError):
        return False

async def ping_host_async(ip: str, timeout: float = 0.6) -> bool:
    """Run a single ICMP ping using async-compatible subprocess execution."""
    try:
        param = '-n' if os.name == 'nt' else '-c'
        timeout_val = str(int(timeout * 1000)) if os.name == 'nt' else str(max(1, int(timeout)))
        timeout_param = '-w' if os.name == 'nt' else '-W'
        
        command = ['ping', param, '1', timeout_param, timeout_val, ip]
        
        def _run_ping():
            # Use subprocess.run for Windows compatibility (avoids SelectorEventLoop issues)
            return subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                errors='ignore',
                timeout=timeout + 1.5,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )

        loop = asyncio.get_running_loop()
        proc = await loop.run_in_executor(None, _run_ping)
        
        if proc.returncode == 0:
            # Windows ping returns 0 even if target is unreachable, check for TTL
            if "TTL=" in proc.stdout.upper():
                return True
        return False
    except Exception:
        return False


_PING_TIME_RE = re.compile(r"(?:time|zeit)[=<]([0-9]+(?:\.[0-9]+)?)\s*ms", re.IGNORECASE)


async def measure_ping_latency_ms(ip: str, timeout: float = 0.8) -> float | None:
    """Run an ICMP ping and parse the round-trip time in milliseconds.

    Returns the measured RTT in ms, or None if host is unreachable / ping timed out.
    """
    try:
        param = '-n' if os.name == 'nt' else '-c'
        timeout_val = str(int(timeout * 1000)) if os.name == 'nt' else str(max(1, int(timeout)))
        timeout_param = '-w' if os.name == 'nt' else '-W'
        command = ['ping', param, '1', timeout_param, timeout_val, ip]

        t0 = time.perf_counter()

        def _run_ping():
            return subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                errors='ignore',
                timeout=timeout + 1.5,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )

        loop = asyncio.get_running_loop()
        proc = await loop.run_in_executor(None, _run_ping)
        elapsed_perf = (time.perf_counter() - t0) * 1000.0

        if proc.returncode == 0:
            stdout_txt = proc.stdout or ""
            # On Windows unreachable responses may exit 0 with "Destination host unreachable"
            if "TTL=" in stdout_txt.upper():
                # Parse exact ping time reported by ping binary
                match = _PING_TIME_RE.search(stdout_txt)
                if match:
                    val = float(match.group(1))
                    if "<" in match.group(0):
                        return 0.5
                    return round(val, 2)
                # If TTL is confirmed but string regex failed, fallback to measured wall time
                return round(elapsed_perf, 2)
        return None
    except Exception:
        return None


async def measure_tcp_latency_ms(ip: str, port: int, timeout: float = 1.0) -> float | None:
    """Measure the round-trip connect time of a TCP handshake in milliseconds."""
    try:
        t0 = time.perf_counter()
        conn = asyncio.open_connection(ip, port)
        _, writer = await asyncio.wait_for(conn, timeout=timeout)
        rtt_ms = (time.perf_counter() - t0) * 1000.0
        writer.close()
        await writer.wait_closed()
        return round(rtt_ms, 2)
    except Exception:
        return None


async def check_ssl_expiry_days(ip: str, port: int = 443, hostname: str | None = None, timeout: float = 2.0) -> int | None:
    """Fetch the TLS certificate for a service and calculate remaining validity days.

    Does not enforce hostname verification so internal / self-signed homelab certs
    still report their expiry date accurately.
    """
    def _fetch_cert():
        try:
            import cryptography.x509
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            server_hostname = hostname if (hostname and not hostname.replace('.', '').isdigit()) else None
            with socket.create_connection((ip, port), timeout=timeout) as sock:
                with ctx.wrap_socket(sock, server_hostname=server_hostname) as ssock:
                    der_cert = ssock.getpeercert(binary_form=True)
                    if not der_cert:
                        return None
                    cert = cryptography.x509.load_der_x509_certificate(der_cert)
                    not_after = cert.not_valid_after_utc
                    now = datetime.now(UTC)
                    remaining = (not_after - now).total_seconds() / 86400.0
                    return int(remaining)
        except Exception:
            return None

    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _fetch_cert)
    except Exception:
        return None

