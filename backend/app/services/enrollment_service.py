"""Short-lived, single-use enrollment codes for the manual agent installer.

The manual install command (``curl .../install-sh/{id}?code=... | sudo bash``)
runs on a host without a GravityLAN session, so it cannot send admin
credentials. An admin issues a code in the UI; the generated script embeds it
and redeems it exactly once to fetch the agent config, which carries the agent
token. Without this, anyone on the LAN could download any device's token.

Like ``session_service``, this is an in-memory store for the single-process
homelab deployment: codes are lost on restart, which is acceptable for a
30-minute credential. All methods are synchronous and called from the event
loop only, so no locking is needed.
"""

import logging
import re
import secrets
import time
from dataclasses import dataclass
from typing import Callable, Dict

CODE_TTL_SECONDS = 30 * 60

# token_urlsafe output only; anything else is rejected before any lookup, so a
# code can never smuggle shell syntax into the generated install script.
_CODE_FORMAT = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


@dataclass
class _Enrollment:
    device_id: int
    expires_at: float


class EnrollmentStore:
    def __init__(self, ttl_seconds: float = CODE_TTL_SECONDS, clock: Callable[[], float] = time.monotonic):
        self._codes: Dict[str, _Enrollment] = {}
        self.ttl_seconds = ttl_seconds
        self._clock = clock

    def issue(self, device_id: int) -> str:
        """Create a new code for ``device_id`` and return it."""
        self.prune_expired()
        code = secrets.token_urlsafe(24)
        self._codes[code] = _Enrollment(device_id=device_id, expires_at=self._clock() + self.ttl_seconds)
        return code

    def is_valid(self, code: str | None, device_id: int) -> bool:
        """Check a code for ``device_id`` without using it up."""
        if not code or not _CODE_FORMAT.match(code):
            return False
        entry = self._codes.get(code)
        if entry is None:
            return False
        if self._clock() >= entry.expires_at:
            del self._codes[code]
            return False
        return entry.device_id == device_id

    def consume(self, code: str | None, device_id: int) -> bool:
        """Redeem a code once; False if unknown, expired, already used or issued for another device."""
        if not self.is_valid(code, device_id):
            return False
        del self._codes[code]
        return True

    def prune_expired(self) -> None:
        """Drop all expired codes."""
        now = self._clock()
        for code in [c for c, entry in self._codes.items() if now >= entry.expires_at]:
            del self._codes[code]


# Global single-process store instance
enrollment_store = EnrollmentStore()


# Install commands carry the code in their URL (``.../install-sh/5?code=...``) and the
# access log records every request line: masked there, a live code never ends up in a
# log file or in the log viewer.
_CODE_PARAM = re.compile(r"([?&]code=)[^&\s\"']+")


def redact_enrollment_codes(text: str) -> str:
    """Mask the value of every ``code=`` query parameter in ``text``."""
    return _CODE_PARAM.sub(r"\1[redacted]", text)


class EnrollmentCodeLogFilter(logging.Filter):
    """Mask enrollment codes in logged request lines (attached to ``uvicorn.access``)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_enrollment_codes(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_enrollment_codes(a) if isinstance(a, str) else a for a in record.args)
        return True
