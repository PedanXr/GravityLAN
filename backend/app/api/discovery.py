"""Discovery API compatibility shim.

Re-exports discovery_cache for backward compatibility.
"""

from app.services.cache_service import discovery_cache

__all__ = ["discovery_cache"]
