import asyncio
import ipaddress
import logging
import re
import shutil
import socket
import subprocess
import sys
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from app.scanner.vendor import get_vendor

logger = logging.getLogger(__name__)

async def trigger_arp_probe(ip: str):
    """Send a tiny UDP packet to trigger an ARP entry for the target IP."""
    loop = asyncio.get_running_loop()
    # NetBIOS Name Service (137) is great for triggering responses
    # Also try MDNS (5353) and LLMNR (5355)
    for port in [137, 5353, 5355]:
        try:
            transport, _ = await loop.create_datagram_endpoint(
                lambda: asyncio.DatagramProtocol(),
                remote_addr=(ip, port)
            )
            transport.sendto(b'\x00', (ip, port))
            transport.close()
        except OSError:
            pass

def _decode_output(stdout: bytes) -> str:
    """Decode command output trying common encodings; falls back to empty string."""
    output = ""
    for encoding in ['cp850', 'utf-8', 'latin-1', 'ascii']:
        try:
            output = stdout.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    return output


def _parse_arp_lines(output: str) -> Dict[str, str]:
    """Extract {ip: mac} entries from raw 'arp -a' output, skipping broadcast/multicast."""
    arp_map = {}
    for line in output.splitlines():
        line = line.strip()
        # Match IP and MAC
        ip_match = re.search(r"(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})", line)
        mac_match = re.search(r"([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})", line)

        if ip_match and mac_match:
            ip = ip_match.group(1)
            mac = mac_match.group(1).replace("-", ":").lower()
            # Skip broadcast/multicast
            if not mac.startswith("ff:ff:ff") and not mac.startswith("01:00:5e") and mac != "00:00:00:00:00:00":
                arp_map[ip] = mac
    return arp_map


def _run_arp_command() -> bytes | None:
    """Run 'arp -a' (fallback 'arp -g') and return raw stdout, or None on failure."""
    if not shutil.which("arp"):
        return None
    try:
        return subprocess.check_output(["arp", "-a"], stderr=subprocess.STDOUT, timeout=10.0)
    except subprocess.SubprocessError:
        try:
            return subprocess.check_output(["arp", "-g"], stderr=subprocess.STDOUT, timeout=10.0)
        except subprocess.SubprocessError:
            return None


def get_local_arp_table() -> Dict[str, str]:
    """Read and parse the system ARP table. Returns {ip: mac}."""
    try:
        stdout = _run_arp_command()
        if not stdout:
            return {}
        return _parse_arp_lines(_decode_output(stdout))
    except Exception as e:
        logger.error(f"ARP command failed: {e}")
        return {}

def _extract_neighbor(line: str):
    """Parse a single 'ip neighbor' line into (ip, mac) or None."""
    parts = line.split()
    if len(parts) < 4:
        return None
    ip = parts[0]
    try:
        socket.inet_aton(ip)
    except (socket.error, ValueError):
        return None
    if 'lladdr' not in parts:
        return None
    mac_idx = parts.index('lladdr') + 1
    if mac_idx >= len(parts):
        return None
    mac = parts[mac_idx].lower()
    if len(mac) != 17:
        return None
    return ip, mac


def get_linux_neighbors() -> Dict[str, str]:
    """Get MAC addresses via 'ip neighbor' (Linux native)."""
    if sys.platform == 'win32': return {}
    try:
        output = subprocess.check_output(["ip", "neighbor", "show"], stderr=subprocess.STDOUT, timeout=10.0).decode(errors='ignore')
        mapping = {}
        for line in output.splitlines():
            parsed = _extract_neighbor(line)
            if parsed:
                mapping[parsed[0]] = parsed[1]
        return mapping
    except Exception:
        return {}

def get_powershell_neighbors() -> Dict[str, str]:
    """Get MAC addresses via PowerShell Get-NetNeighbor (Windows native)."""
    if sys.platform != 'win32': return {}
    try:
        ps_cmd = "Get-NetNeighbor | Select-Object IPAddress, LinkLayerAddress | ConvertTo-Json"
        output = subprocess.check_output(["powershell", "-Command", ps_cmd], timeout=10.0).decode('cp850')
        data = json.loads(output)
        if isinstance(data, dict): data = [data]
        
        mapping = {}
        for item in data:
            ip = item.get("IPAddress")
            mac = item.get("LinkLayerAddress")
            if ip and mac and len(mac) >= 11:
                mapping[ip] = mac.replace("-", ":").lower()
        return mapping
    except Exception:
        return {}

async def _collect_arp_maps() -> Dict[str, str]:
    """Gather the ARP/neighbor tables from all platform-specific sources."""
    loop = asyncio.get_running_loop()
    arp_map = await loop.run_in_executor(None, get_local_arp_table)

    if sys.platform == 'win32':
        ps_map = await loop.run_in_executor(None, get_powershell_neighbors)
        arp_map.update(ps_map)
    else:
        linux_map = await loop.run_in_executor(None, get_linux_neighbors)
        arp_map.update(linux_map)
    return arp_map


async def _probe_and_retry_missing(discovered_hosts: List[Dict[str, Any]], arp_map: Dict[str, str]) -> None:
    """Actively probe hosts without a MAC, then merge any fresh entries back."""
    missing_mac_ips = [host["ip"] for host in discovered_hosts if not host.get("mac")]

    if not missing_mac_ips:
        return

    logger.debug(f"Triggering active ARP probes for {len(missing_mac_ips)} hosts...")
    loop = asyncio.get_running_loop()
    probe_tasks = []
    for ip in missing_mac_ips:
        probe_tasks.append(trigger_arp_probe(ip))
        # Simple ping also triggers ARP
        from app.scanner.utils import ping_host_async
        probe_tasks.append(ping_host_async(ip, timeout=0.2))

    await asyncio.gather(*probe_tasks)
    await asyncio.sleep(0.3)

    # Re-read tables after probes
    arp_map_retry = await loop.run_in_executor(None, get_local_arp_table)
    if not arp_map_retry:
        return
    for ip, mac in arp_map_retry.items():
        arp_map[ip] = mac
        for host in discovered_hosts:
            if host["ip"] == ip:
                host["mac"] = mac


def _is_valid_ipv4(ip: str) -> bool:
    try:
        ipaddress.IPv4Address(ip)
        return True
    except (ValueError, AttributeError):
        return False


def _filter_gateway_and_proxy_macs(
    arp_map: Dict[str, str],
    local_subnets: Optional[List[Any]] = None
) -> Dict[str, str]:
    """Filter out router/gateway and proxy-ARP MACs mistakenly assigned to routed remote IPs.

    When scanning across VLAN boundaries through a router/firewall, the local ARP cache
    frequently associates remote IPs with the local gateway's MAC address (or proxy-ARP).
    Allowing remote devices to inherit the gateway's MAC leads to massive device collisions,
    false IP migrations, and vendor misclassifications in sync_hosts_batch.
    """
    if not arp_map:
        return {}

    mac_to_ips: Dict[str, List[str]] = {}
    for ip, mac in arp_map.items():
        if mac:
            mac_to_ips.setdefault(mac.lower(), []).append(ip)

    local_nets = []
    if local_subnets is None:
        try:
            from app.scanner.utils import get_local_subnets
            local_subnets = get_local_subnets()
        except Exception:
            local_subnets = []

    for s in local_subnets:
        cidr = getattr(s, "subnet", s)
        try:
            local_nets.append(ipaddress.ip_network(cidr, strict=False))
        except (ValueError, TypeError):
            pass

    sanitized: Dict[str, str] = {}
    for ip, mac in arp_map.items():
        mac_lower = mac.lower()
        shared_ips = mac_to_ips.get(mac_lower, [])

        # Unique MAC on a single IP is always trusted
        if len(shared_ips) <= 1:
            sanitized[ip] = mac
            continue

        try:
            ip_obj = ipaddress.ip_address(ip)
        except ValueError:
            sanitized[ip] = mac
            continue

        is_ip_local = any(ip_obj in net for net in local_nets) if local_nets else False
        has_any_local_shared = any(
            any(ipaddress.ip_address(other) in net for net in local_nets)
            for other in shared_ips
            if _is_valid_ipv4(other)
        ) if local_nets else False

        # If this MAC belongs to a local IP (e.g. gateway 192.168.1.1),
        # remote IPs (outside local_nets) must NOT inherit it!
        if has_any_local_shared and not is_ip_local:
            logger.debug(
                "Filter gateway MAC: stripping shared gateway MAC %s from remote routed IP %s",
                mac, ip
            )
            continue

        # If a MAC is shared across multiple distinct /24 subnets, it is a router/proxy-ARP
        distinct_subnets = set()
        for other in shared_ips:
            try:
                distinct_subnets.add(str(ipaddress.ip_network(f"{other}/24", strict=False)))
            except ValueError:
                pass

        if len(distinct_subnets) > 1 and not is_ip_local:
            logger.debug(
                "Filter proxy-ARP MAC: stripping cross-subnet MAC %s from IP %s",
                mac, ip
            )
            continue

        sanitized[ip] = mac

    return sanitized


def _merge_into_hosts(discovered_hosts: List[Dict[str, Any]], arp_map: Dict[str, str], all_target_ips: Optional[List[str]]) -> None:
    """Consolidate the ARP table into the discovered hosts list (append new, backfill existing)."""
    for ip, mac in arp_map.items():
        if all_target_ips is not None and len(all_target_ips) > 0 and ip not in all_target_ips:
            continue

        existing = next((h for h in discovered_hosts if h["ip"] == ip), None)
        if not existing:
            discovered_hosts.append({
                "ip": ip,
                "mac": mac,
                "hostname": None,
                "vendor": get_vendor(mac)
            })
        else:
            if not existing.get("mac"):
                existing["mac"] = mac
            if not existing.get("vendor"):
                existing["vendor"] = get_vendor(mac)


async def resolve_mac_addresses(discovered_hosts: List[Dict[str, Any]], all_target_ips: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """
    Robust MAC address resolution using multiple methods, active probing,
    and gateway/proxy-ARP filtering.
    
    Args:
        discovered_hosts: List of host dicts to update with MACs.
        all_target_ips: Optional filter to only include these IPs in the result.
    """
    try:
        # 1. Collect ARP/Neighbor tables from all sources
        raw_arp_map = await _collect_arp_maps()

        if not raw_arp_map:
            return discovered_hosts

        # 2. Check which hosts are still missing a MAC
        for host in discovered_hosts:
            if host["ip"] in raw_arp_map:
                host["mac"] = raw_arp_map[host["ip"]]

        # 3. ACTIVE PROBING: Trigger ARP for missing entries
        await _probe_and_retry_missing(discovered_hosts, raw_arp_map)

        # 4. Filter gateway and proxy-ARP MACs from routed/remote IPs
        arp_map = _filter_gateway_and_proxy_macs(raw_arp_map)

        # Sync back to discovered_hosts (clearing any stripped gateway MACs)
        for host in discovered_hosts:
            host_ip = host["ip"]
            if host_ip in arp_map:
                host["mac"] = arp_map[host_ip]
            elif host.get("mac") and host["mac"].lower() not in [m.lower() for m in arp_map.values()]:
                host["mac"] = None

        # 5. Consolidate results
        _merge_into_hosts(discovered_hosts, arp_map, all_target_ips)

    except Exception as e:
        logger.error(f"Error during ARP resolution: {e}")
    
    return discovered_hosts
