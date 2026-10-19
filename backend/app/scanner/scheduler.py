import asyncio
import logging
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, delete
from app.database import async_session
from app.models.setting import Setting
from app.models.device import DeviceHistory
from app.scanner.planner import run_planner_scan, run_arp_only_scan
from app.scanner.dashboard import run_dashboard_scan
from app.scanner.subnets import get_enabled_subnets
from app.scanner.utils import get_auto_scan_subnets
from app.config import settings

logger = logging.getLogger(__name__)

# How often the retention loop checks; _clean_old_history itself prunes at most every 12 h
RETENTION_CHECK_SECONDS = 3600

def _get_auto_scan_subnets():
    """Backwards-compatible alias for :func:`app.scanner.utils.get_auto_scan_subnets`."""
    return get_auto_scan_subnets()

async def _get_setting_value(db, key: str) -> str | None:
    """Read a single setting value (or None when unset)."""
    result = await db.execute(select(Setting).where(Setting.key == key))
    setting = result.scalar_one_or_none()
    return setting.value if setting else None

async def _get_setting_int(db, key: str, default: int) -> int:
    """Read an integer setting, falling back to ``default`` for missing/invalid values."""
    value = await _get_setting_value(db, key)
    return int(value) if value and value.isdigit() else default

async def _get_retention_days(db) -> int:
    """Read the history retention setting with a sane fallback to the app default."""
    value = await _get_setting_value(db, "history_retention_days")
    if value is not None:
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    return settings.history_retention_days

async def _get_scan_subnets(db, auto_subnets: list[str]) -> list[str]:
    """Return the enabled subnets of the Subnet table, falling back to auto-detected local subnets."""
    return await get_enabled_subnets(db) or auto_subnets

class ScanScheduler:
    def __init__(self):
        self._task = None
        self._quick_task = None
        self._arp_task = None
        self._docker_task = None
        self._retention_task = None
        self._health_probe_task = None
        self._running = False
        self._last_cleanup_time = None

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        self._quick_task = asyncio.create_task(self._quick_loop())
        self._arp_task = asyncio.create_task(self._arp_loop())
        self._docker_task = asyncio.create_task(self._docker_loop())
        self._retention_task = asyncio.create_task(self._retention_loop())
        self._health_probe_task = asyncio.create_task(self._health_probe_loop())
        logger.info("Scan scheduler started (Full + Quick + ARP Turbo + Docker Sync + Retention + Health Probe)")

    async def stop(self):
        self._running = False
        tasks = [self._task, self._quick_task, self._arp_task, self._docker_task, self._retention_task, self._health_probe_task]
        for task in tasks:
            if task:
                task.cancel()

        # Wait for tasks to exit
        await asyncio.gather(*(t for t in tasks if t), return_exceptions=True)
        logger.info("Scan scheduler stopped")

    async def _is_setup_complete(self) -> bool:
        """Checks if the system setup is marked as complete."""
        try:
            async with async_session() as db:
                result = await db.execute(select(Setting).where(Setting.key == "setup.complete"))
                setting = result.scalar_one_or_none()
                return setting is not None and setting.value == "true"
        except Exception:
            return False

    async def _loop(self):
        while self._running:
            try:
                if not await self._is_setup_complete():
                    await asyncio.sleep(10)
                    continue

                async with async_session() as db:
                    # Get interval from settings (in minutes)
                    interval = await _get_setting_int(db, "scan_interval", 0)

                    if interval > 0:
                        logger.info(f"Scheduled scan starting (Interval: {interval}m)")

                        # Get subnets to scan (fallback to all if not set)
                        subnets = await _get_scan_subnets(db, _get_auto_scan_subnets())

                        if subnets:
                            logger.info(f"Scheduled Full Scan (Dashboard) starting for: {subnets}")
                            await run_dashboard_scan(subnets)

                        # Wait for the next interval
                        await asyncio.sleep(interval * 60)
                    else:
                        await asyncio.sleep(60)

            except Exception as e:
                logger.error(f"Error in scan scheduler loop: {e}")
                await asyncio.sleep(60)

    async def _arp_loop(self) -> None:
        """Passive ARP monitoring loop (Turbo Mode: 10s interval)."""
        logger.info("ARP Turbo loop started (Interval: 10s)")
        while self._running:
            if not await self._is_setup_complete():
                await asyncio.sleep(10)
                continue
            try:
                await run_arp_only_scan()
            except Exception as e:
                logger.error(f"ARP loop error: {e}")
            
            await asyncio.sleep(10)

    async def _quick_loop(self):
        """High-frequency status check for known devices."""
        while self._running:
            if not await self._is_setup_complete():
                await asyncio.sleep(10)
                continue
            try:
                # Get quick scan interval (default 300s / 5m)
                async with async_session() as db:
                    interval = await _get_setting_int(db, "quick_scan_interval", 300)
                    subnets = await _get_scan_subnets(db, _get_auto_scan_subnets())

                if interval > 0:
                    logger.info(f"Scheduled Quick Scan (Planner) starting (Interval: {interval}s)")

                    if subnets:
                        await run_planner_scan(subnets)

                    await asyncio.sleep(interval)
                else:
                    await asyncio.sleep(60)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in quick scan loop: {e}")
                await asyncio.sleep(60)

    async def _docker_loop(self):
        """Sync local Docker container status (1m interval)."""
        from app.services.docker_service import docker_service
        from app.scanner.sync import sync_docker_containers
        
        while self._running:
            if not await self._is_setup_complete():
                await asyncio.sleep(10)
                continue
            try:
                if docker_service.is_available():
                    containers = docker_service.get_local_containers()
                    if containers:
                        logger.info(f"Docker Sync: Syncing {len(containers)} local containers...")
                        await sync_docker_containers(containers)
                
                # Sleep for 1 minute
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in docker sync loop: {e}")
                await asyncio.sleep(60)

    async def _retention_loop(self) -> None:
        """Prune history and metrics on its own schedule.

        The cleanup used to run inside the full-scan loop, i.e. once per scan
        interval: with a long interval (e.g. weekly) agent metrics piled up far
        beyond history_retention_days.
        """
        while self._running:
            if await self._is_setup_complete():
                await self._clean_old_history()  # catches its own errors, rate-limited to 12 h
            await asyncio.sleep(RETENTION_CHECK_SECONDS)

    async def _health_probe_loop(self) -> None:
        """High-precision latency and service health probe loop (default 60s)."""
        logger.info("Health probe loop started (Interval: 60s)")
        while self._running:
            if not await self._is_setup_complete():
                await asyncio.sleep(10)
                continue
            try:
                from app.scanner.health_probe import run_health_probe_pass
                await run_health_probe_pass()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Health probe loop error: {e}", exc_info=True)

            try:
                async with async_session() as db:
                    interval = await _get_setting_int(db, "scanner.health_probe_interval", 60)
                await asyncio.sleep(max(15, interval))
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(60)

    async def _clean_old_history(self, force: bool = False):
        """Delete history and metrics records older than the configured retention period."""
        try:
            # Enforce 12-hour rate limit on cleanup unless forced (e.g. in tests)
            now = datetime.now(timezone.utc)
            if not force and self._last_cleanup_time and (now - self._last_cleanup_time).total_seconds() < 43200:
                return

            self._last_cleanup_time = now

            from app.models.agent import DeviceMetrics
            
            async with async_session() as db:
                # Get retention period (in days)
                days = await _get_retention_days(db)

                # Guardrail: only clean up if days is a positive value within 1-365
                if 1 <= days <= 365:
                    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
                    cutoff_naive = cutoff.replace(tzinfo=None)
                    
                    from app.models.device import DeviceHealthSample
                    await db.execute(delete(DeviceHistory).where(DeviceHistory.timestamp < cutoff_naive))
                    await db.execute(delete(DeviceMetrics).where(DeviceMetrics.timestamp < cutoff_naive))
                    await db.execute(delete(DeviceHealthSample).where(DeviceHealthSample.timestamp < cutoff_naive))
                    await db.commit()
                    logger.info(f"Cleaned up history, metrics and health samples older than {days} days")
        except Exception as e:
            logger.error(f"Failed to clean up old history/metrics: {e}", exc_info=True)

# Global instance
scheduler = ScanScheduler()
