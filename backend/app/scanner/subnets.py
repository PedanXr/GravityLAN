"""Which subnets the scanners cover: the enabled rows of the Subnet table.

The Subnet table is the only place scan targets are configured. The settings page,
the setup wizard and the network overview all write to it, and the overview shows
one tab per row. Only while it holds no enabled row do the scanners fall back to the
container's own (non-virtual) interfaces.
"""

import ipaddress
import logging
from collections.abc import Iterable

from sqlalchemy import select

from app.models.network import Subnet
from app.schemas.network import normalize_cidr

logger = logging.getLogger(__name__)


def _canonical(cidr: str) -> str | None:
    """Canonical IPv4 form of a stored or entered subnet, or None when it is not one."""
    try:
        return normalize_cidr(cidr)
    except ValueError:
        return None


async def get_enabled_subnets(db) -> list[str]:
    """CIDRs of the enabled Subnet rows, as stored (lookups by cidr keep matching).

    Rows that are not a valid IPv4 network are skipped.
    """
    result = await db.execute(
        select(Subnet.cidr).where(Subnet.is_enabled.is_(True)).order_by(Subnet.id)
    )
    cidrs = []
    for cidr in result.scalars().all():
        try:
            if ipaddress.ip_network(cidr, strict=False).version != 4:
                raise ValueError(cidr)
        except ValueError:
            logger.warning("Scan subnets: skipping invalid subnet entry '%s'", cidr)
            continue
        if cidr not in cidrs:
            cidrs.append(cidr)
    return cidrs


async def get_scan_subnets(db) -> list[str]:
    """Subnets to scan: the enabled Subnet rows, else the auto-detected local subnets."""
    configured = await get_enabled_subnets(db)
    if configured:
        return configured
    from app.scanner.utils import get_auto_scan_subnets
    return get_auto_scan_subnets()


async def find_subnet(db, cidr: str, exclude_id: int | None = None) -> Subnet | None:
    """The row describing the same network as ``cidr`` (compared in canonical form), if any."""
    wanted = _canonical(cidr)
    if wanted is None:
        return None
    result = await db.execute(select(Subnet))
    for row in result.scalars().all():
        if row.id != exclude_id and _canonical(row.cidr) == wanted:
            return row
    return None


async def merge_subnets(
    db,
    cidrs: Iterable[str],
    names: dict[str, str] | None = None,
    enable_existing: bool = False,
) -> list[str]:
    """Add the given subnets to the Subnet table unless an equal network is already there.

    Entries are compared in canonical form, so '192.168.1' matches a stored
    '192.168.1.0/24'. ``names`` maps a canonical CIDR to the name a new row gets
    (default 'Network <cidr>'); ``enable_existing`` re-enables rows that already exist.
    Invalid entries are logged and skipped. Flushes but does not commit; returns the
    CIDRs that were added.
    """
    names = names or {}
    result = await db.execute(select(Subnet))
    existing: dict[str, Subnet] = {}
    for row in result.scalars().all():
        key = _canonical(row.cidr)
        if key:
            existing.setdefault(key, row)

    added = []
    for raw in cidrs:
        cidr = _canonical(raw)
        if cidr is None:
            logger.warning("Scan subnets: ignoring invalid subnet '%s'", raw.strip())
            continue
        row = existing.get(cidr)
        if row is not None:
            if enable_existing and not row.is_enabled:
                row.is_enabled = True
            continue
        row = Subnet(cidr=cidr, name=names.get(cidr) or f"Network {cidr}", is_enabled=True)
        db.add(row)
        existing[cidr] = row
        added.append(cidr)

    await db.flush()
    return added
