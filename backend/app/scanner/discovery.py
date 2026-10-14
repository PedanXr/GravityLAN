"""
Host discovery module for GravityLAN.
Provides high-speed Nmap-based scanning with reliable ARP/Ping fallbacks.
"""

import asyncio
import ipaddress
import logging
import re
from typing import Any, Callable, Dict, List, Optional

# Local imports
from app.scanner.utils import check_port_async, ping_host_async
from app.scanner.arp import resolve_mac_addresses, trigger_arp_probe

# Standard Logger setup
logger = logging.getLogger(__name__)

# Common ports to check if a host is alive when ping fails
ALIVE_CHECK_PORTS = [445, 135, 80, 22, 443, 8080, 8443, 1883, 8123, 5000, 8266, 9090]

_NMAP_REPORT_RE = re.compile(r"Nmap scan report for (?:(.+?) \()?((\d{1,3}\.){3}\d{1,3})\)?")


def _parse_nmap_report(line_str: str):
    """Parse a single Nmap report line into (hostname, ip) or None."""
    if "Nmap scan report for" not in line_str:
        return None
    match = _NMAP_REPORT_RE.search(line_str)
    if not match:
        return None
    hostname = match.group(1).strip() if match.group(1) else None
    return hostname, match.group(2)


def _build_networks(target_ips: List[str]) -> Dict[str, List[str]]:
    """Group IPs by /24 (network CIDR -> its target IPs); invalid IPs are logged and skipped."""
    networks: Dict[str, List[str]] = {}
    for ip in target_ips:
        try:
            net = ipaddress.IPv4Interface(f"{ip}/24").network
        except ValueError:
            logger.warning(f"Invalid IP encountered during discovery: {ip}")
            continue
        networks.setdefault(str(net), []).append(ip)
    return networks


def _build_nmap_args(network: str, target_ips: List[str], dns_server: Optional[str]) -> List[str]:
    """Build the nmap command line; small target lists are scanned directly."""
    cmd_args = ["nmap", "-sn"]
    if dns_server:
        cmd_args.extend(["--dns-servers", dns_server])
    if len(target_ips) < 50:
        cmd_args.extend(target_ips)
    else:
        cmd_args.append(network)
    return cmd_args


def _run_sync_nmap(cmd_args: List[str]):
    """Sync subprocess fallback used when async subprocess is unsupported."""
    import subprocess
    res = subprocess.run(cmd_args, capture_output=True, shell=False, text=True, errors='ignore')
    return res.stdout, res.returncode


async def _record_found_host(discovered: List[Dict[str, Any]], ip_addr: str, hostname: Optional[str], host_found_callback):
    """Append a deduplicated host entry and fire the callback for new hosts."""
    if any(h["ip"] == ip_addr for h in discovered):
        return
    host_data = {"ip": ip_addr, "mac": None, "hostname": hostname}
    discovered.append(host_data)
    if host_found_callback:
        await host_found_callback(host_data)


async def _read_nmap_stream(stream: asyncio.StreamReader, discovered: List[Dict[str, Any]], host_found_callback):
    """Read nmap stdout line-by-line, recording every reported host."""
    while True:
        line = await stream.readline()
        if not line:
            break
        parsed = _parse_nmap_report(line.decode(errors='ignore').strip())
        if parsed:
            hostname, ip_addr = parsed
            await _record_found_host(discovered, ip_addr, hostname, host_found_callback)


async def _run_sync_nmap_fallback(cmd_args: List[str], discovered: List[Dict[str, Any]], host_found_callback):
    """Execute the sync nmap path (NotImplementedError/AttributeError fallback)."""
    loop = asyncio.get_event_loop()
    stdout_str, returncode = await loop.run_in_executor(None, _run_sync_nmap, cmd_args)

    if returncode == 0:
        for hostname, ip_addr, _ in _NMAP_REPORT_RE.findall(stdout_str):
            hostname = hostname.strip() if hostname else None
            await _record_found_host(discovered, ip_addr, hostname, host_found_callback)
    else:
        logger.error(f"Sync Nmap scan failed for targets: {cmd_args}")


async def _scan_network_once(network: str, target_ips: List[str], dns_server: Optional[str], discovered: List[Dict[str, Any]], host_found_callback):
    """Run a single async Nmap pass over one network; sync mode when unsupported."""
    cmd_args = _build_nmap_args(network, target_ips, dns_server)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        await _read_nmap_stream(proc.stdout, discovered, host_found_callback)
        # communicate() returns (stdout, stderr); stdout was already consumed above
        _, stderr_data = await proc.communicate()

        if proc.returncode != 0:
            err_msg = stderr_data.decode(errors='ignore')
            logger.warning(f"Nmap (async) failed with code {proc.returncode}: {err_msg}")

    except (NotImplementedError, AttributeError):
        # FALLBACK: Sync mode if async subprocess is not supported (e.g. some Windows loops)
        await _run_sync_nmap_fallback(cmd_args, discovered, host_found_callback)


async def _nmap_discovery(discovered: List[Dict[str, Any]], target_ips: List[str], dns_server: Optional[str], cancel_event: Optional[asyncio.Event], host_found_callback):
    """Primary discovery phase: async Nmap with sync subprocess fallback."""
    try:
        for network, network_ips in _build_networks(target_ips).items():
            if cancel_event and cancel_event.is_set():
                break

            if network.startswith("169.254."):  # Skip link-local
                continue

            await _scan_network_once(network, network_ips, dns_server, discovered, host_found_callback)
    except Exception as e:
        logger.error(f"Nmap discovery encountered a fatal error: {e}", exc_info=True)


async def _manual_discovery(discovered: List[Dict[str, Any]], target_ips: List[str], timeout: float, max_workers: int, cancel_event: Optional[asyncio.Event]):
    """Fallback phase: parallel Ping/TCP/ARP alive checks for hosts not yet found."""

    async def _check_host(ip: str) -> Optional[Dict[str, Any]]:
        if cancel_event and cancel_event.is_set():
            return None
        if ip.startswith("169.254."):
            return None

        await trigger_arp_probe(ip)

        if await ping_host_async(ip, timeout):
            return {"ip": ip, "mac": None}

        for port in ALIVE_CHECK_PORTS:
            if await check_port_async(ip, port, 0.4):
                return {"ip": ip, "mac": None}
        return None

    sem = asyncio.Semaphore(max_workers)

    async def _sem_check(ip: str):
        async with sem:
            return await _check_host(ip)

    tasks = [_sem_check(ip) for ip in target_ips if not any(h["ip"] == ip for h in discovered)]
    if tasks:
        results = await asyncio.gather(*tasks)
        for r in results:
            if r:
                discovered.append(r)


async def discover_hosts_simple(
    target_ips: List[str],
    timeout: float = 1.0,
    max_workers: int = 30,
    cancel_event: Optional[asyncio.Event] = None,
    mode: str = "gentle",
    dns_server: Optional[str] = None,
    host_found_callback: Optional[Callable[[Dict[str, Any]], Any]] = None
) -> List[Dict[str, Any]]:
    """
    Highly accurate host discovery using Nmap (Fast) + Manual ARP/Ping fallback.

    Args:
        target_ips: List of IP strings to scan.
        timeout: Timeout per host for alive checks.
        max_workers: Maximum parallel workers for fallback scan.
        cancel_event: Event to trigger scan cancellation.
        mode: Scanning intensity mode.
        dns_server: Optional custom DNS server for Nmap.
        host_found_callback: Async callback triggered for each found host.

    Returns:
        A list of dictionaries containing found host data (ip, mac, hostname).
    """
    discovered: List[Dict[str, Any]] = []

    # -- 1. Nmap Discovery (Primary) ------------------------------------------
    await _nmap_discovery(discovered, target_ips, dns_server, cancel_event, host_found_callback)

    if discovered:
        if cancel_event and cancel_event.is_set():
            return discovered
        logger.info(f"Nmap found {len(discovered)} hosts. Resolving MACs via ARP/Neighbors...")
        await resolve_mac_addresses(discovered, target_ips)
        return discovered

    # -- 2. Manual Fallback (Ping/TCP/ARP) ------------------------------------
    # This triggers if Nmap found nothing or failed
    logger.info("Falling back to manual Ping/TCP/ARP discovery loop.")
    await _manual_discovery(discovered, target_ips, timeout, max_workers, cancel_event)

    # Final MAC resolution for all hosts found in fallback
    await resolve_mac_addresses(discovered, target_ips)
    return discovered