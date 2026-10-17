"""Gateway address of each subnet: configured, detected from the routing table, or suggested.

A router that is the gateway of several VLANs answers on one address per VLAN. Knowing
which address is the gateway of which subnet lets the sync treat those addresses as
interfaces of one device instead of an IP change, and lets the dashboard list them.
"""

import ipaddress
import logging
import sys
from dataclasses import dataclass

logger = logging.getLogger(__name__)

PROC_NET_ROUTE = "/proc/net/route"
_RTF_GATEWAY = 0x2

# Where an effective gateway address comes from, most trustworthy first
SOURCE_CONFIGURED = "configured"
SOURCE_DETECTED = "detected"
SOURCE_SUGGESTED = "suggested"


@dataclass(frozen=True)
class EffectiveGateway:
    ip: str
    source: str


def suggest_gateway(cidr: str) -> str | None:
    """First usable host of the network (the usual router address), None for /31, /32 or garbage."""
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except (ValueError, TypeError):
        return None
    if net.num_addresses < 4:
        return None
    return str(net.network_address + 1)


def _hex_to_ipv4(value: str) -> str | None:
    """/proc/net/route stores addresses as little-endian hex."""
    try:
        return str(ipaddress.IPv4Address(int(value, 16).to_bytes(4, "little")))
    except (ValueError, OverflowError):
        return None


def parse_proc_net_route(text: str) -> list[str]:
    """Gateway addresses of the default routes in a /proc/net/route dump."""
    gateways = []
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 4 or fields[1] != "00000000":
            continue
        try:
            flags = int(fields[3], 16)
        except ValueError:
            continue
        gateway = _hex_to_ipv4(fields[2])
        if flags & _RTF_GATEWAY and gateway and gateway != "0.0.0.0" and gateway not in gateways:
            gateways.append(gateway)
    return gateways


def detect_default_gateways() -> list[str]:
    """Default-route gateways of this host/container (Linux only; empty elsewhere or on error)."""
    if sys.platform == "win32":
        return []
    try:
        with open(PROC_NET_ROUTE, encoding="ascii", errors="ignore") as fh:
            return parse_proc_net_route(fh.read())
    except OSError as e:
        logger.debug(f"Gateways: could not read {PROC_NET_ROUTE}: {e}")
        return []


def _detected_in(cidr: str, detected: list[str]) -> str | None:
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except (ValueError, TypeError):
        return None
    for ip in detected:
        try:
            if ipaddress.ip_address(ip) in net:
                return ip
        except ValueError:
            continue
    return None


def effective_gateway(subnet, detected: list[str]) -> EffectiveGateway | None:
    """The gateway to use for a Subnet row: stored value, then the default route, then `.1`."""
    stored = (getattr(subnet, "gateway_ip", None) or "").strip()
    if stored:
        return EffectiveGateway(stored, SOURCE_CONFIGURED)
    found = _detected_in(subnet.cidr, detected)
    if found:
        return EffectiveGateway(found, SOURCE_DETECTED)
    suggestion = suggest_gateway(subnet.cidr)
    if suggestion:
        return EffectiveGateway(suggestion, SOURCE_SUGGESTED)
    return None


def gateway_prefill(cidr: str, detected: list[str] | None = None) -> EffectiveGateway | None:
    """Prefill for a subnet form: the detected default route if it lies in the network, else `.1`."""
    detected = detect_default_gateways() if detected is None else detected
    found = _detected_in(cidr, detected)
    if found:
        return EffectiveGateway(found, SOURCE_DETECTED)
    suggestion = suggest_gateway(cidr)
    return EffectiveGateway(suggestion, SOURCE_SUGGESTED) if suggestion else None
