"""Agent bearer tokens: one place for generating, storing and checking them.

The database never holds a usable agent token. Stored values carry the prefix
``sha256:`` followed by the SHA-256 hex digest of the token the agent sends.
The plaintext exists only once: when it is generated and handed to the agent
(config download or SSH deploy).

Why the prefix: new tokens are ``secrets.token_hex(32)``, 64 hex characters,
exactly the shape of a SHA-256 hex digest. 0.3.20 to 0.3.24 stored the digest
without a marker, so the server could not tell a stored hash from a stored
plaintext token and also accepted the stored value itself as a token. Anyone
holding the database file (or a volume backup) could log in as the agent with
it. A tagged value is only ever compared against the hash of what the client
sends, never against the raw input.

Untagged rows are legacy and are upgraded on first successful use (and at
startup by :func:`normalize_stored_token`):

* not shaped like a SHA-256 hex digest (e.g. the 32-char ``uuid4().hex`` of
  SSH deploys): it cannot be a hash, so it is a plaintext token;
* 64 hex characters and ``last_seen`` set: treated as a hash. In 0.3.20+ every
  successful report hashed the token during lookup, before ``last_seen`` was
  written, so a reported row is a hash. The leftover case (a plaintext 64-char
  token whose agent last reported before 0.3.20, or one adopted moments before
  the upgrade) is locked out instead of leaving every hash usable as a token;
  that agent falls back to the pending-token adoption flow;
* 64 hex characters and never reported: either a config that was downloaded
  but not yet installed (plaintext) or, rarely, a hash whose first report
  failed. Both readings are accepted until the first successful use resolves
  the row.
"""

import hashlib
import hmac
import logging
import re
import secrets
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent import AgentToken

logger = logging.getLogger(__name__)

HASH_PREFIX = "sha256:"
_DIGEST_RE = re.compile(r"[0-9a-f]{64}")


def _digest(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def hash_agent_token(raw_token: str) -> str:
    """Storage form of an agent token: ``sha256:<hex digest>``."""
    return HASH_PREFIX + _digest(raw_token)


def is_hashed(stored: str | None) -> bool:
    """True for a value in storage form (tagged hash)."""
    return bool(stored) and stored.startswith(HASH_PREFIX)


def _looks_like_digest(value: str) -> bool:
    return _DIGEST_RE.fullmatch(value) is not None


def new_agent_token() -> tuple[str, str]:
    """Fresh token as ``(plaintext for the agent, value to store)``."""
    raw = secrets.token_hex(32)
    return raw, hash_agent_token(raw)


def match_agent_token(stored: str | None, presented: str | None, last_seen: datetime | None) -> str | None:
    """Check a presented token against a stored value.

    Returns the value the row should hold from now on (the tagged hash, which
    may differ from ``stored`` for a legacy row), or None when the token does
    not match. A stored value is never accepted as the token itself unless it
    is a legacy plaintext token.
    """
    if not stored or not presented:
        return None
    digest = _digest(presented)

    if is_hashed(stored):
        return stored if _equal(HASH_PREFIX + digest, stored) else None

    if _looks_like_digest(stored):
        if _equal(digest, stored):
            return HASH_PREFIX + stored
        if last_seen is None and _equal(presented, stored):
            return HASH_PREFIX + digest
        return None

    return HASH_PREFIX + digest if _equal(presented, stored) else None


async def verify_agent_token(session: AsyncSession, token_obj: AgentToken, presented: str) -> bool:
    """Check ``presented`` against ``token_obj`` and upgrade a legacy row to a tagged hash."""
    new_value = match_agent_token(token_obj.token, presented, token_obj.last_seen)
    if new_value is None:
        return False
    if new_value != token_obj.token:
        logger.info("Upgrading legacy agent token of device %s to a tagged SHA-256 hash", token_obj.device_id)
        token_obj.token = new_value
        await session.commit()
    return True


async def find_agent_token(session: AsyncSession, presented: str, device_id: int | None = None) -> AgentToken | None:
    """Active token row the presented token authenticates, or None."""
    if not presented:
        return None
    digest = _digest(presented)
    # Tagged hash, untagged legacy hash, untagged legacy plaintext: the match
    # rules in match_agent_token decide which of these may actually log in.
    stmt = select(AgentToken).where(
        AgentToken.token.in_([HASH_PREFIX + digest, digest, presented]),
        AgentToken.is_active.is_(True),
    )
    if device_id is not None:
        stmt = stmt.where(AgentToken.device_id == device_id)
    for token_obj in (await session.execute(stmt)).scalars().all():
        if await verify_agent_token(session, token_obj, presented):
            return token_obj
    return None


def pending_storage_form(value: str | None) -> str | None:
    """Storage form of a pending (not yet adopted) token.

    A pending token is always what an agent presented, so an untagged value is
    plaintext and gets hashed.
    """
    if not value or is_hashed(value):
        return value
    return hash_agent_token(value)


def normalize_stored_token(stored: str | None, last_seen: datetime | None) -> str | None:
    """Startup migration of a stored token. Returns the new value, or None to leave it.

    Ambiguous rows (64 hex characters, never reported) stay untagged until the
    first successful use tells the two readings apart; see the module docstring.
    """
    if not stored or is_hashed(stored):
        return None
    if not _looks_like_digest(stored):
        return hash_agent_token(stored)
    if last_seen is not None:
        return HASH_PREFIX + stored
    return None


async def normalize_agent_tokens(session: AsyncSession) -> int:
    """Tag or hash every unambiguous legacy agent token and pending token. Returns the count changed."""
    changed = 0
    for token_obj in (await session.execute(select(AgentToken))).scalars().all():
        new_token = normalize_stored_token(token_obj.token, token_obj.last_seen)
        if new_token is not None:
            token_obj.token = new_token
            changed += 1
        new_pending = pending_storage_form(token_obj.pending_token)
        if new_pending != token_obj.pending_token:
            token_obj.pending_token = new_pending
            changed += 1
    if changed:
        await session.commit()
        logger.info("Migration: upgraded %d legacy agent token value(s) to tagged SHA-256 hashes", changed)
    return changed
