"""TCP port scanner for service detection.

Scans discovered hosts for open ports to identify running services.
Supports gentle (stealth) and fast scan modes.
"""

import asyncio
import logging
import random
import socket
import subprocess
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Any

logger = logging.getLogger(__name__)

# Dedicated thread pool for port scanning — bounded to prevent thread exhaustion
# when scanning many hosts concurrently across batches.
_port_scan_executor = ThreadPoolExecutor(max_workers=40, thread_name_prefix="port-scan")

# Default ports to scan, ordered by detection value
DEFAULT_SCAN_PORTS: list[int] = [
    # Remote Access
    22,     # SSH
    3389,   # RDP
    # Web
    80,     # HTTP
    443,    # HTTPS
    8080,   # HTTP Alt
    8443,   # HTTPS Alt
    # File Sharing
    445,    # SMB
    2049,   # NFS
    # Firewall Management
    4444,   # Sophos Admin
    4445,   # Sophos VPN
    11115,  # Securepoint
    # Hypervisors
    8006,   # Proxmox
    902,    # ESXi
    9440,   # Nutanix
    # NAS
    5000,   # Synology HTTP
    5001,   # Synology HTTPS
    # Smart Home
    8123,   # Home Assistant
    8081,   # ioBroker Admin
    8082,   # ioBroker Vis
    # Additional Web
    9443,   # Alt HTTPS
    8000,   # Dev Server
    8008,   # Alt HTTP
    8888,   # Jupyter / Alt
    9090,   # Cockpit / Prometheus
    10000,  # Webmin
]


async def scan_ports(
    ip: str,
    ports: list[int] | None = None,
    timeout: float = 0.5,
    gentle: bool = True,
    cancel_event: asyncio.Event | None = None,
    dns_server: str | None = None,
) -> list[int]:
    """Scan a single host for open TCP ports.

    Args:
        ip: Target IP address.
        ports: List of ports to scan (defaults to DEFAULT_SCAN_PORTS).
        timeout: Socket connect timeout per port.
        gentle: If True, add random delays between probes (ESET bypass).
        cancel_event: Cancellation signal.

    Returns:
        List of open port numbers.
    """
    scan_ports_list = list(ports or DEFAULT_SCAN_PORTS)
    if gentle:
        random.shuffle(scan_ports_list)

    open_ports: list[int] = []
    loop = asyncio.get_running_loop()

    def _check_port(port: int) -> int | None:
        if cancel_event and cancel_event.is_set():
            return None
        try:
            # Standard fast socket check for all ports
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            is_open = sock.connect_ex((ip, port)) == 0
            sock.close()
            
            if is_open:
                return port
        except PermissionError:
            # Fallback to nmap only when local OS permissions restrict raw TCP sockets on port 445
            if port == 445:
                try:
                    nres = subprocess.run(
                        ["nmap", "-p", "445", "-Pn", "-n", "--host-timeout", "1s", ip],
                        capture_output=True, text=True, timeout=1.5
                    )
                    if "445/tcp open" in nres.stdout:
                        return 445
                except (OSError, subprocess.SubprocessError):
                    pass
        except OSError:
            pass
        return None

    tasks = [loop.run_in_executor(_port_scan_executor, _check_port, p) for p in scan_ports_list]
    results = await asyncio.gather(*tasks)

    for result in results:
        if result is not None:
            open_ports.append(result)
            logger.debug("Open port found: %s:%d", ip, result)

    return open_ports


async def scan_hosts_ports(
    hosts: list[dict],
    ports: list[int] | None = None,
    timeout: float = 0.4,
    gentle: bool = True,
    max_concurrent: int = 5,
    cancel_event: asyncio.Event | None = None,
    on_scanned: Callable[[dict], Any] | None = None,
    dns_server: str | None = None,
) -> list[dict]:
    """Scan multiple hosts for open ports with concurrency control.

    Args:
        hosts: List of host dicts (must have 'ip' key).
        ports: Ports to scan per host.
        timeout: Connect timeout.
        gentle: Enable stealth delays.
        max_concurrent: Max hosts scanned simultaneously.
        cancel_event: Cancellation signal.
        on_scanned: Async callback after each host is scanned.

    Returns:
        Updated host dicts with populated 'ports' lists.
    """
    semaphore = asyncio.Semaphore(max_concurrent)

    async def _scan_single(host: dict) -> dict:
        async with semaphore:
            if cancel_event and cancel_event.is_set():
                return host

            found_ports = await scan_ports(
                host["ip"],
                ports=ports,
                timeout=timeout,
                gentle=gentle,
                cancel_event=cancel_event,
                dns_server=dns_server,
            )
            host["ports"] = found_ports

            if on_scanned:
                await on_scanned(host)

            # Inter-host delay in gentle mode
            if gentle:
                await asyncio.sleep(random.uniform(0.3, 1.0))

            return host

    tasks = [_scan_single(host) for host in hosts]
    return await asyncio.gather(*tasks, return_exceptions=False)


def _parse_nmap_greppable(output: str) -> list[int]:
    """Extract open TCP ports from nmap greppable (-oG -) output."""
    ports = []
    match = re.search(r"Ports: (.*)", output)
    if match:
        port_entries = match.group(1).split(",")
        for entry in port_entries:
            if "/open/tcp/" in entry:
                port_num = entry.strip().split("/")[0]
                if port_num.isdigit():
                    ports.append(int(port_num))
    return ports


def _build_nmap_command(ip: str, dns_server: str | None) -> list[str]:
    """Build the nmap argument list (never interpolate into a shell string)."""
    cmd = ["nmap", "-Pn", "--top-ports", "1000", "-oG", "-"]
    if dns_server:
        cmd += ["--dns-servers", dns_server]
    cmd.append(ip)
    return cmd


async def _wait_for_cancel(cancel_event: asyncio.Event | None, proc) -> None:
    """Terminate the running nmap process when the cancellation event fires."""
    if not cancel_event:
        return
    await cancel_event.wait()
    if proc.returncode is None:
        logger.info(f"Terminating Nmap due to cancellation")
        try:
            proc.terminate()
            await asyncio.sleep(0.2)
            if proc.returncode is None:
                proc.kill()
        except Exception:
            pass


async def _run_nmap_async(cmd: list[str], cancel_event: asyncio.Event | None, ip: str):
    """Run nmap via async subprocess; returns (stdout, stderr, returncode)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except NotImplementedError:
        return await _run_nmap_fallback(cmd)

    cancel_task = asyncio.create_task(_wait_for_cancel(cancel_event, proc))
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45.0)
    except Exception as e:
        logger.warning(f"Nmap communication error for {ip}: {e}")
        stdout, stderr = b"", b""
    finally:
        cancel_task.cancel()

    return stdout, stderr, proc.returncode


async def _run_nmap_fallback(cmd: list[str]):
    """FALLBACK: Run nmap via ThreadPoolExecutor (e.g. Windows without Proactor)."""
    import subprocess
    from concurrent.futures import ThreadPoolExecutor

    logger.info("Async subprocess not supported, falling back to ThreadPool")

    def _run_sync_nmap():
        try:
            res = subprocess.run(cmd, capture_output=True, shell=False, text=False, timeout=45)
            return res.stdout, res.stderr, res.returncode
        except subprocess.TimeoutExpired:
            return b"", b"Timeout", 1
        except Exception as e:
            return b"", str(e).encode(), 1

    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor() as pool:
        return await loop.run_in_executor(pool, _run_sync_nmap)


async def nmap_scan(ip: str, cancel_event: asyncio.Event | None = None, dns_server: str | None = None) -> list[int]:
    """Execute a robust nmap -Pn scan and parse the results."""
    logger.info(f"Starting async nmap -Pn scan for {ip} (DNS: {dns_server or 'System'})...")
    try:
        cmd = _build_nmap_command(ip, dns_server)
        stdout, stderr, returncode = await _run_nmap_async(cmd, cancel_event, ip)

        if returncode != 0:
            err_msg = stderr.decode(errors='ignore').strip()
            logger.debug(f"Nmap {ip} finished with code {returncode}: {err_msg}")
            # Even if it failed/was terminated, we might have partial output
        output = stdout.decode(errors='ignore')

        # Parse greppable output
        ports = _parse_nmap_greppable(output)

        logger.info(f"Nmap scan finished for {ip}. Found {len(ports)} ports.")
        return ports

    except asyncio.TimeoutError:
        logger.warning(f"Nmap scan for {ip} timed out")
        return []
    except Exception as e:
        logger.error(f"Error during nmap scan for {ip}: {str(e)}", exc_info=True)
        return []
