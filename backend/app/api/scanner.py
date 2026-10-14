"""Network scanner API.

Provides endpoints for subnet discovery, health monitoring,
and real-time updates via WebSockets.
"""

import asyncio
import ipaddress
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import or_, select
from fastapi import Depends

from app.api.auth import get_current_admin

from app.database import async_session
from app.models.device import DiscoveredHost
from app.models.setting import Setting
from app.models.network import Subnet
from app.schemas.device import DiscoveredHostResponse, DiscoveredHostUpdate
from app.schemas.scan import ScanProgress, ScanRequest, ScanStatus, SubnetInfo
from app.scanner.planner import run_planner_scan
from app.scanner.dashboard import run_dashboard_scan
from app.scanner.sync import sync_host_to_db
from app.services.cache_service import discovery_cache
from app.scanner.utils import get_local_subnets
from app.scanner.port_scanner import nmap_scan, scan_ports
from app.scanner.discovery import discover_hosts_simple
from app.scanner.arp import resolve_mac_addresses
from app.scanner.hostname import resolve_hostnames

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/scanner", tags=["scanner"])

class ScanStateManager:
    """Manages global scan task state and WebSocket broadcasting."""
    
    def __init__(self):
        self.task: Optional[asyncio.Task] = None
        self.cancel_event = asyncio.Event()
        self.last_progress: Optional[ScanProgress] = None
        self.is_active: bool = False
        self.ws_clients: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def set_active(self, active: bool) -> None:
        async with self._lock:
            self.is_active = active

    async def get_active(self) -> bool:
        async with self._lock:
            return self.is_active

    async def add_client(self, ws: WebSocket) -> None:
        async with self._lock:
            self.ws_clients.append(ws)

    async def remove_client(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self.ws_clients:
                self.ws_clients.remove(ws)

    async def broadcast(self, data: ScanProgress) -> None:
        """Sends scan progress updates to all connected clients."""
        async with self._lock:
            self.last_progress = data
            data_dict = data.model_dump(mode="json")
            clients = list(self.ws_clients)

        disconnected: List[WebSocket] = []
        
        for ws in clients:
            try:
                await ws.send_json(data_dict)
            except Exception:
                disconnected.append(ws)
        
        if disconnected:
            async with self._lock:
                for ws in disconnected:
                    if ws in self.ws_clients:
                        self.ws_clients.remove(ws)

# Initialize global state manager
state = ScanStateManager()

@router.get("/subnets", response_model=List[SubnetInfo], dependencies=[Depends(get_current_admin)])
async def get_subnets() -> List[SubnetInfo]:
    """Get available network interfaces and subnets for scanning."""
    return get_local_subnets()

@router.get("/test", dependencies=[Depends(get_current_admin)])
async def test_scanner() -> Dict[str, str]:
    """Verify scanner API availability."""
    return {"status": "ok", "module": "scanner"}

@router.get("/scan-ip", dependencies=[Depends(get_current_admin)])
async def scan_ip(ip: str) -> Dict[str, Any]:
    """Perform a robust scan on a specific IP address."""
    # Issue 6: Validate IP address
    try:
        ipaddress.IPv4Address(ip)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid IP address format")
        
    logger.info("Manual scan requested for %s", ip)
    
    dns_server = None
    async with async_session() as db:
        dns_q = await db.execute(select(Setting).where(Setting.key == "dns.server"))
        dns_s = dns_q.scalar_one_or_none()
        if dns_s:
            dns_server = dns_s.value

    ports = await nmap_scan(ip, dns_server=dns_server)
    if not ports:
        ports = await scan_ports(ip, gentle=False, timeout=0.5)
    
    return {"ip": ip, "ports": ports, "timestamp": datetime.now(timezone.utc).isoformat()}

@router.post("/quick-subnet-scan", dependencies=[Depends(get_current_admin)])
async def quick_subnet_scan(subnets: str) -> Dict[str, str]:
    """Turbo-fast subnet refresh (ARP + ICMP) via Planner scan."""
    subnet_list = [s.strip() for s in subnets.split(",") if s.strip()]
    await run_planner_scan(subnet_list)
    return {"status": "ok", "message": "Quick scan triggered"}

@router.post("/discover", dependencies=[Depends(get_current_admin)])
async def discover_subnet(request: ScanRequest) -> Dict[str, str]:
    """Trigger a full host discovery on subnets."""
    return await start_scan(request)

@router.get("/status", response_model=ScanProgress, dependencies=[Depends(get_current_admin)])
async def get_scan_status() -> ScanProgress:
    """Get current scan job status."""
    if state.last_progress:
        return state.last_progress
    return ScanProgress(status=ScanStatus.IDLE, message="No scan active")

@router.get("/discovered", response_model=List[DiscoveredHostResponse], dependencies=[Depends(get_current_admin)])
async def get_discovered_hosts() -> List[DiscoveredHost]:
    """Get all hosts from the persistent discovery table."""
    cached = discovery_cache.get_hosts()
    if cached is not None:
        return cached

    async with async_session() as db:
        result = await db.execute(
            select(DiscoveredHost)
            .where(or_(DiscoveredHost.is_online == True, DiscoveredHost.is_monitored == True))
            .order_by(DiscoveredHost.is_monitored.desc(), DiscoveredHost.last_seen.desc())
        )
        hosts = list(result.scalars().all())
        discovery_cache.set_hosts(hosts)
        return hosts

@router.patch("/discovered/{host_id}", response_model=DiscoveredHostResponse, dependencies=[Depends(get_current_admin)])
async def patch_discovered_host(host_id: int, update: DiscoveredHostUpdate) -> DiscoveredHost:
    """Update a discovered host's details."""
    async with async_session() as db:
        host = await db.get(DiscoveredHost, host_id)
        if not host:
            raise HTTPException(status_code=404, detail="Host not found")
            
        update_data = update.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(host, field, value)
            
        await db.commit()
        discovery_cache.invalidate()
        await db.refresh(host)
        return host

@router.delete("/discovered/{host_id}", dependencies=[Depends(get_current_admin)])
async def delete_discovered_host(host_id: int) -> Dict[str, str]:
    """Delete a discovered host from the database."""
    async with async_session() as db:
        host = await db.get(DiscoveredHost, host_id)
        if not host:
            raise HTTPException(status_code=404, detail="Host not found")
        
        await db.delete(host)
        await db.commit()
        discovery_cache.invalidate()
        return {"status": "success", "message": "Host deleted"}

@router.post("/start-dashboard", dependencies=[Depends(get_current_admin)])
async def start_dashboard_scan_api(request: ScanRequest, background_tasks: BackgroundTasks) -> Dict[str, str]:
    """Manually trigger the high-intensity Dashboard scan."""
    if await state.get_active():
        return {"status": "error", "message": "A scan is already in progress"}

    await state.set_active(True)
    state.cancel_event = asyncio.Event()
    state.last_progress = ScanProgress(status=ScanStatus.RUNNING, message="Initializing Dashboard Scan...", progress=0)
    await state.broadcast(state.last_progress)
    
    async def progress_cb(msg: str):
        status = ScanStatus.RUNNING
        if msg == "EVENT:RELOAD_DEVICES":
            status = ScanStatus.DEVICES_UPDATED
            msg = "Host discovered..."
        await state.broadcast(ScanProgress(status=status, message=msg, progress=50))

    async def run_dashboard_task():
        try:
            subnets = request.subnets
            if not subnets:
                async with async_session() as db:
                    res_sub = await db.execute(select(Setting).where(Setting.key == "scan_subnets"))
                    s_set = res_sub.scalar_one_or_none()
                    if s_set and s_set.value:
                        subnets = [s.strip() for s in s_set.value.split(",") if s.strip()]
                    else:
                        subnets = [s.subnet for s in get_local_subnets()]

            found_count = await run_dashboard_scan(subnets, progress_callback=progress_cb)
            await state.broadcast(ScanProgress(
                status=ScanStatus.COMPLETED, 
                message=f"Dashboard scan complete: {found_count} devices updated", 
                devices_found=found_count
            ))
        except Exception as e:
            logger.error("Dashboard scan failed: %s", e, exc_info=True)
            await state.broadcast(ScanProgress(status=ScanStatus.FAILED, message=f"Scan error: {str(e)}"))
        finally:
            await state.set_active(False)

    state.task = asyncio.create_task(run_dashboard_task())
    return {"status": "ok", "message": "Dashboard scan started"}

@router.post("/start", dependencies=[Depends(get_current_admin)])
async def start_scan(request: ScanRequest) -> Dict[str, str]:
    """Trigger a Network Planner scan."""
    if await state.get_active():
        return {"status": "error", "message": "Scan already in progress"}

    await state.set_active(True)
    state.cancel_event = asyncio.Event()
    
    state.last_progress = ScanProgress(status=ScanStatus.RUNNING, message="Initializing Planner Scan...", progress=0)
    await state.broadcast(state.last_progress)
    
    async def progress_cb(msg: str):
        status = ScanStatus.RUNNING
        if msg == "EVENT:RELOAD_DEVICES":
            status = ScanStatus.DEVICES_UPDATED
            msg = "Host discovered..."
        await state.broadcast(ScanProgress(status=status, message=msg, progress=50))

    async def run_scan_task():
        try:
            found_count = await run_planner_scan(request.subnets, progress_callback=progress_cb)
            await state.broadcast(ScanProgress(status=ScanStatus.COMPLETED, message="Scan complete", devices_found=found_count))
        except Exception as e:
            logger.error("Manual scan failed: %s", e, exc_info=True)
            await state.broadcast(ScanProgress(status=ScanStatus.FAILED, message=f"Scan error: {str(e)}"))
        finally:
            await state.set_active(False)

    state.task = asyncio.create_task(run_scan_task())
    return {"status": "ok", "message": "Planner scan started"}

@router.post("/stop", dependencies=[Depends(get_current_admin)])
async def stop_scan() -> Dict[str, str]:
    """Cancel any running scan."""
    state.cancel_event.set()
    return {"status": "cancelling"}

def _normalize_subnet_input(subnet: str) -> str:
    """Normalize a bare IP or CIDR into a proper subnet string."""
    if "/" in subnet:
        return subnet
    return f"{subnet}.0/24" if subnet.count(".") == 2 else f"{subnet}/24"


async def _discover_and_sync_subnet(db, subnet: str, global_dns: str | None) -> list[dict]:
    """Run discovery + MAC/hostname resolution + DB sync for one subnet."""
    res_sub = await db.execute(select(Subnet).where(Subnet.cidr == subnet))
    sub_obj = res_sub.scalar_one_or_none()
    dns_server = sub_obj.dns_server if sub_obj and sub_obj.dns_server else global_dns

    net = ipaddress.ip_network(subnet, strict=False)
    target_ips = [str(ip) for ip in net.hosts()]

    alive_hosts = await discover_hosts_simple(target_ips, dns_server=dns_server, timeout=2.0)
    if alive_hosts:
        alive_hosts = await resolve_mac_addresses(alive_hosts)
        await resolve_hostnames(alive_hosts, dns_server=dns_server)

        for host in alive_hosts:
            await sync_host_to_db(
                ip=host["ip"],
                mac=host.get("mac"),
                hostname=host.get("hostname"),
                vendor=host.get("vendor")
            )
    return alive_hosts


@router.get("/live-discovery", dependencies=[Depends(get_current_admin)])
async def live_discovery(subnets: str) -> List[Dict[str, Any]]:
    """Perform a fast ICMP/ARP discovery and sync results to DB."""
    subnet_list = [s.strip() for s in subnets.split(",") if s.strip()]
    all_hosts = []
    
    async with async_session() as db:
        res_dns = await db.execute(select(Setting).where(Setting.key == "dns.server"))
        dns_s = res_dns.scalar_one_or_none()
        global_dns = dns_s.value if dns_s else None

        for subnet in subnet_list:
            try:
                all_hosts.extend(await _discover_and_sync_subnet(db, _normalize_subnet_input(subnet), global_dns))
            except Exception as e:
                logger.error("Live-discovery error for %s: %s", subnet, e)
            
    return all_hosts

@router.websocket("/ws")
async def scan_websocket(websocket: WebSocket) -> None:
    """WebSocket endpoint for real-time scan progress updates with authentication."""
    from app.api.auth import authenticate_websocket_authorized

    # Scanner info is strictly restricted to browser-sessions, legacy master cookie, master token query params, setup bypass, or API tokens
    auth_info = await authenticate_websocket_authorized(
        websocket, endpoint_type="scanner",
        allowed_levels=("session", "master_legacy", "setup_bypass", "master", "api_token"),
    )
    if not auth_info:
        return

    await websocket.accept()
    await state.add_client(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await state.remove_client(websocket)
