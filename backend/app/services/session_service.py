"""In-memory Session Store for GravityLAN.

WARNING: This is an In-Memory Session Store designed strictly as a temporary,
minimal-invasive solution for single-worker / single-process Homelab environments.
It is NOT designed to scale across multiple workers or load-balanced containers.
Active sessions will be lost when the application restarts.

Concurrency Note: Since Python's asyncio event loop is single-threaded, and all
operations in this store are synchronous CPU-bound dictionary operations with no 'await'
statements, context switches cannot occur during store access. Therefore, no locks
(threading or asyncio) are required for safety.
"""

import time
import secrets
from typing import Dict

class Session:
    def __init__(self, session_id: str, created_at: float, user_agent: str | None = None):
        self.session_id = session_id
        self.created_at = created_at
        self.last_seen = created_at
        self.user_agent = user_agent

class SessionStore:
    def __init__(self, session_lifetime_seconds: float = 60 * 60 * 24 * 7):  # Default 7 days
        self._sessions: Dict[str, Session] = {}
        self.session_lifetime = session_lifetime_seconds

    def create_session(self, user_agent: str | None = None) -> str:
        """Create a new session, store it, and return the session ID."""
        session_id = f"session_{secrets.token_hex(32)}"
        now = time.time()
        self._sessions[session_id] = Session(
            session_id=session_id,
            created_at=now,
            user_agent=user_agent
        )
        return session_id

    def get_session(self, session_id: str) -> Session | None:
        """Retrieve a session and update its last_seen timestamp if valid."""
        if not session_id or not session_id.startswith("session_"):
            return None
            
        session = self._sessions.get(session_id)
        if not session:
            return None

        now = time.time()
        # Check absolute expiration (created_at + lifetime)
        if now - session.created_at > self.session_lifetime:
            self.delete_session(session_id)
            return None

        # Update last seen
        session.last_seen = now
        return session

    def delete_session(self, session_id: str) -> bool:
        """Delete a session by ID. Returns True if found and deleted."""
        if session_id in self._sessions:
            del self._sessions[session_id]
            return True
        return False

    def delete_all_except(self, keep_session_id: str | None) -> int:
        """Log out every session but `keep_session_id` (e.g. after a password change). Returns the count."""
        others = [sid for sid in self._sessions if sid != keep_session_id]
        for sid in others:
            self.delete_session(sid)
        return len(others)

    def prune_expired_sessions(self) -> None:
        """Remove all sessions that exceed the lifetime."""
        now = time.time()
        expired_ids = [
            sid for sid, sess in self._sessions.items()
            if now - sess.created_at > self.session_lifetime
        ]
        for sid in expired_ids:
            self.delete_session(sid)


# Global single-process store instance
session_store = SessionStore()
