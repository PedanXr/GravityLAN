"""Run the GravityLAN backend with demo data and without touching your network.

Meant for UI work (e.g. the redesign branch): serves the API on
http://127.0.0.1:8000 from a throw-away SQLite database in ``.demo-data/``
with example devices, services, agents, metrics and history. Simulated
agents keep reporting every 10 s, so live views update like in production.

Safety:
- the scan scheduler never starts, and every endpoint that would scan the
  LAN or open an SSH session (scanner start/discover/scan-ip, device
  refresh, add-from-ip, agent deploy/uninstall/patches) answers 403;
- the browser SSH terminal always lands on a built-in fake shell on
  127.0.0.1 (any user/password/key works), whatever host it targets;
- the server only listens on 127.0.0.1;
- the database URL is set explicitly, so a real database is never used.

Usage (repository root, backend virtualenv):
    backend/.venv/Scripts/python scripts/dev_demo.py        # Windows
    backend/.venv/bin/python scripts/dev_demo.py            # Linux/macOS
    ... --reset    wipe the demo database and seed it again
    ... --fresh    start like a new install (separate empty database, setup wizard)

Then start the frontend (``cd frontend && npm run dev``), open
http://localhost:5173 and log in with the password ``demo``.
"""

import argparse
import asyncio
import json
import math
import os
import random
import re
import secrets
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO_DIR = ROOT / ".demo-data"
DEMO_PASSWORD = "demo"
HOST, PORT = "127.0.0.1", 8000
REPORT_INTERVAL_S = 10

# Endpoints that would scan the LAN or SSH into hosts.
_BLOCKED_PATHS = re.compile(
    r"^/api/("
    r"scanner/(scan-ip|quick-subnet-scan|discover|start-dashboard|start|live-discovery)"
    r"|devices/(refresh-all|add-from-ip|\d+/refresh-(info|services))"
    r"|agent/(deploy|uninstall|patches)/"
    r")"
)

# name, ip, type, group, flags, services [(name, protocol, port, up)], agent profile (os, ram GB, base cpu %, version)
DEVICES = [
    ("UniFi Gateway", "192.168.100.1", "firewall", "Firewalls", {}, [("SSH", "ssh", 22, True), ("UniFi OS", "https", 443, True)], None),
    ("Core Switch", "192.168.100.2", "webui", "Netzwerk", {}, [("Web UI", "https", 443, True)], None),
    ("AP Obergeschoss", "192.168.100.3", "webui", "Netzwerk", {"is_ap": True}, [("Web UI", "https", 443, True)], None),
    ("AP Erdgeschoss", "192.168.100.4", "webui", "Netzwerk", {"is_ap": True}, [("Web UI", "https", 443, True)], None),
    ("Proxmox", "192.168.100.10", "server", "Server", {"is_host": True}, [("Proxmox", "https", 8006, True), ("SSH", "ssh", 22, True)], ("Debian GNU/Linux 12 (bookworm)", 64, 42, "0.3.5")),
    ("Unraid", "192.168.100.11", "server", "Server", {"is_host": True}, [("Web UI", "http", 80, True), ("SMB", "smb", 445, True), ("SSH", "ssh", 22, True)], ("Slackware 15.0 (Unraid 7.1)", 32, 58, "0.3.4")),
    ("Synology NAS", "192.168.100.12", "nas", "NAS / Storage", {}, [("DSM", "https", 5001, True), ("SMB", "smb", 445, True), ("NFS", "nfs", 2049, True)], ("Synology DSM 7.2", 8, 35, "0.3.4")),
    ("Pi-hole", "192.168.100.13", "server", "Server", {}, [("DNS", "dns", 53, True), ("Admin", "http", 80, True)], ("Raspberry Pi OS 12", 4, 18, "0.3.5")),
    ("Docker VM", "192.168.100.20", "server", "Server", {"virtual_type": "vm", "parent": "Proxmox"}, [("Portainer", "https", 9443, True), ("SSH", "ssh", 22, True)], ("Ubuntu 24.04 LTS", 16, 81, "0.3.5")),
    ("Home Assistant", "192.168.100.21", "webui", "Smart Home", {"virtual_type": "vm", "parent": "Proxmox"}, [("Home Assistant", "http", 8123, True)], None),
    ("Nextcloud", "192.168.100.22", "webui", "Web Interfaces", {"virtual_type": "docker", "parent": "Unraid"}, [("Nextcloud", "https", 443, True)], None),
    ("Grafana", "192.168.100.23", "webui", "Web Interfaces", {"virtual_type": "docker", "parent": "Docker VM"}, [("Grafana", "http", 3000, False)], None),
    ("Drucker", "192.168.100.50", "unknown", "Clients", {}, [("IPP", "ipp", 631, True), ("Web UI", "http", 80, True)], None),
    ("MacBook", "192.168.100.100", "unknown", "Clients", {"is_wlan": True, "old_ip": "192.168.100.140"}, [], None),
    ("iPhone", "192.168.100.101", "unknown", "Clients", {"is_wlan": True, "offline": True}, [], None),
    ("Hue Bridge", "192.168.110.10", "webui", "Smart Home", {}, [("Hue API", "http", 80, True)], None),
    ("Shelly Plug Büro", "192.168.110.11", "webui", "Smart Home", {"is_wlan": True, "offline": True}, [("Web UI", "http", 80, False)], None),
]

EXTRA_GROUPS = [("Netzwerk", "network", 1), ("Smart Home", "home", 5), ("Clients", "laptop", 6)]
UNKNOWN_HOSTS = ["192.168.100.60", "192.168.100.61", "192.168.100.142", "192.168.110.30", "192.168.110.31"]
LINKS = [("UniFi Gateway", "Core Switch", "10GbE"), ("Core Switch", "Proxmox", "10GbE"), ("Core Switch", "Unraid", "10GbE"),
         ("Core Switch", "Synology NAS", "2.5GbE"), ("Core Switch", "Pi-hole", "1GbE"), ("Core Switch", "AP Obergeschoss", "1GbE"),
         ("Core Switch", "AP Erdgeschoss", "1GbE"), ("Core Switch", "Drucker", "1GbE")]


def _utcnow() -> datetime:
    """Naive UTC, matching what the report endpoint stores in SQLite."""
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def _prepare_environment(reset: bool, fresh: bool) -> Path:
    # --fresh uses its own throw-away database that starts empty every run
    data_dir = DEMO_DIR / "fresh" if fresh else DEMO_DIR
    if (reset or fresh) and data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    # Must be set before app.config is imported; the explicit URL also wins over any .env file.
    os.environ["GRAVITYLAN_DATA_DIR"] = str(data_dir)
    os.environ["GRAVITYLAN_DATABASE_URL"] = f"sqlite+aiosqlite:///{(data_dir / 'gravitylan-demo.db').as_posix()}"
    sys.path.insert(0, str(ROOT / "backend"))
    return data_dir


def _metrics_sample(profile: tuple, t: float) -> dict:
    """Plausible, slowly varying metrics for one simulated agent at time t (seconds)."""
    _, ram_gb, base_cpu, _ = profile
    cpu = max(1.0, min(99.0, base_cpu + 12 * math.sin(t / 1800) + random.uniform(-4, 4)))
    ram_total = ram_gb * 1024
    ram_pct = max(5.0, min(97.0, 40 + base_cpu / 3 + 6 * math.sin(t / 5400) + random.uniform(-1, 1)))
    return {
        "cpu_percent": round(cpu, 1),
        "ram": {"total_mb": ram_total, "used_mb": int(ram_total * ram_pct / 100), "percent": round(ram_pct, 1)},
        "disk": [
            {"path": "/", "total_gb": 256.0, "used_gb": round(256 * (0.3 + base_cpu / 300), 1), "percent": round(30 + base_cpu / 3, 1)},
            {"path": "/mnt/data", "total_gb": 4000.0, "used_gb": 2710.0, "percent": 67.8},
        ],
        "temperature": round(38 + cpu / 4 + random.uniform(-1, 1), 1),
        "network": {"eth0": {"rx_bytes_sec": random.randint(20_000, 4_000_000), "tx_bytes_sec": random.randint(10_000, 1_500_000)}},
    }


async def _seed() -> dict[str, tuple[int, str, tuple]]:
    """Fill an empty demo database. Returns {device name: (id, agent token, profile)} for agents."""
    from sqlalchemy import select

    from app.database import async_session, init_db
    from app.models.agent import AgentConfig, AgentToken, DeviceMetrics
    from app.models.device import Device, DeviceGroup, DeviceHistory, DiscoveredHost, Service
    from app.models.network import Subnet
    from app.models.setting import Setting
    from app.models.topology import Rack, TopologyLink
    from app.scanner.utils import ensure_default_groups
    from app.services.auth_service import hash_password

    from app.database.migrations import run_migrations

    await init_db()
    # Existing demo databases need new columns before the first ORM query
    async with async_session() as db:
        await run_migrations(db)
    async with async_session() as db:
        if (await db.execute(select(Device).limit(1))).scalar_one_or_none():
            rows = (await db.execute(select(AgentToken, Device).join(Device, AgentToken.device_id == Device.id))).all()
            profiles = {d[0]: d[6] for d in DEVICES if d[6]}
            return {dev.display_name: (dev.id, tok.token, profiles[dev.display_name]) for tok, dev in rows if dev.display_name in profiles}

        now = _utcnow()
        for key, value in {
            "setup.complete": "true",
            "api.admin_password": hash_password(DEMO_PASSWORD),
            "api.master_token": secrets.token_hex(32),
            "scan_interval": "0",
            "quick_scan_interval": "0",
            "server.url": f"http://{HOST}:{PORT}",
        }.items():
            db.add(Setting(key=key, value=value, category="system"))

        groups = await ensure_default_groups(db, commit=False)
        for name, icon, order in EXTRA_GROUPS:
            group = DeviceGroup(name=name, icon=icon, sort_order=order)
            db.add(group)
            await db.flush()
            groups[name] = group.id

        db.add_all([Subnet(cidr="192.168.100.0/24", name="Home LAN"), Subnet(cidr="192.168.110.0/24", name="IoT")])
        rack = Rack(name="Keller-Rack", units=24)
        db.add(rack)
        await db.flush()

        by_name: dict[str, Device] = {}
        agents: dict[str, tuple[int, str, tuple]] = {}
        for index, (name, ip, dtype, group, flags, services, profile) in enumerate(DEVICES):
            offline = flags.get("offline", False)
            device = Device(
                ip=ip, display_name=name, hostname=name.lower().replace(" ", "-") + ".lan", device_type=dtype,
                group_id=groups[group], is_online=not offline, is_host=flags.get("is_host", False),
                is_ap=flags.get("is_ap", False), is_wlan=flags.get("is_wlan", False),
                virtual_type=flags.get("virtual_type"), sort_order=index, has_agent=profile is not None,
                old_ip=flags.get("old_ip"), ip_changed_at=now - timedelta(hours=3) if flags.get("old_ip") else None,
                last_seen=now - timedelta(hours=2) if offline else now, status_changed_at=now - timedelta(hours=2),
            )
            if flags.get("parent"):
                device.parent_id = by_name[flags["parent"]].id
            if dtype in ("firewall", "server", "nas") and not flags.get("virtual_type"):
                device.rack_id, device.rack_unit, device.rack_height = rack.id, 20 - index, 2 if flags.get("is_host") else 1
            db.add(device)
            await db.flush()
            by_name[name] = device

            for order, (sname, proto, port, up) in enumerate(services):
                db.add(Service(device_id=device.id, name=sname, protocol=proto, port=port, is_up=up and not offline, sort_order=order))
            db.add(DiscoveredHost(ip=ip, hostname=device.hostname, is_online=not offline, is_monitored=True))
            if offline:
                db.add(DeviceHistory(device_id=device.id, status="offline", message="Device went offline", timestamp=now - timedelta(hours=2)))

            if profile:
                token = secrets.token_hex(32)
                db.add(AgentToken(device_id=device.id, token=token, agent_version=profile[3], last_seen=now,
                                  os_pretty=profile[0], os_arch="x86_64"))
                db.add(AgentConfig(device_id=device.id))
                agents[name] = (device.id, token, profile)
                # 24 h of history, one sample every 5 minutes
                for step in range(288):
                    ts = now - timedelta(minutes=5 * (288 - step))
                    sample = _metrics_sample(profile, ts.timestamp())
                    db.add(DeviceMetrics(
                        device_id=device.id, cpu_percent=sample["cpu_percent"], ram_used_mb=sample["ram"]["used_mb"],
                        ram_total_mb=sample["ram"]["total_mb"], ram_percent=sample["ram"]["percent"],
                        disk_json=json.dumps(sample["disk"]), temperature=sample["temperature"],
                        net_json=json.dumps(sample["network"]), timestamp=ts,
                        patch_available=7 if profile[3] == "0.3.4" else 0, patch_security=2 if profile[3] == "0.3.4" else 0,
                        patch_manager="apt", reboot_required=name == "Unraid",
                    ))

        for ip in UNKNOWN_HOSTS:
            db.add(DiscoveredHost(ip=ip, vendor="Espressif Inc." if ip.startswith("192.168.110") else None, is_online=True))
        for source, target, link_type in LINKS:
            db.add(TopologyLink(source_id=by_name[source].id, target_id=by_name[target].id, link_type=link_type))
        db.add(DeviceHistory(device_id=by_name["Grafana"].id, status="down", message="Service Grafana (3000) is down",
                             timestamp=now - timedelta(minutes=25)))
        await db.commit()
        return agents


async def _simulate_agents(server, agents: dict[str, tuple[int, str, tuple]]) -> None:
    """Post a metrics report for every demo agent through the real /api/agent/report endpoint."""
    import httpx

    while not server.started:
        await asyncio.sleep(0.2)
    async with httpx.AsyncClient(base_url=f"http://{HOST}:{PORT}", timeout=5) as client:
        while not server.should_exit:
            now = datetime.now(timezone.utc).timestamp()
            for name, (device_id, token, profile) in agents.items():
                payload = {"device_id": device_id, "agent_version": profile[3], "timestamp": now,
                           "system": {"os": profile[0], "arch": "x86_64"},
                           "patches": {"patch_available": 7 if profile[3] == "0.3.4" else 0,
                                       "patch_security": 2 if profile[3] == "0.3.4" else 0,
                                       "patch_manager": "apt", "reboot_required": name == "Unraid"},
                           **_metrics_sample(profile, now)}
                try:
                    await client.post("/api/agent/report", json=payload, headers={"Authorization": f"Bearer {token}"})
                except httpx.HTTPError as exc:
                    print(f"[demo] report for {name} failed: {exc}")
            await asyncio.sleep(REPORT_INTERVAL_S)


_DEMO_SHELL_COMMANDS = {
    "help": "Demo commands: uname -a, uptime, whoami, hostname, ls, df -h, clear, exit",
    "uname": "Linux gravitylan-demo 6.1.0-28-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.119-1 x86_64 GNU/Linux",
    "uptime": " 21:42:07 up 23 days,  4:12,  1 user,  load average: 0.42, 0.37, 0.31",
    "whoami": "root",
    "hostname": "gravitylan-demo",
    "ls": "backups  docker-compose.yml  notes.txt",
    "df": "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        98G   41G   52G  45% /",
}


def _demo_shell(channel) -> None:
    """A tiny line-editing shell so the browser terminal can be tried without any real host."""
    prompt = "\x1b[1;32mroot@gravitylan-demo\x1b[0m:\x1b[1;34m~\x1b[0m# "
    channel.send("GravityLAN demo shell - nothing here reaches a real machine. Type 'help'.\r\n\r\n" + prompt)
    line = ""
    while True:
        data = channel.recv(1024)
        if not data:
            return
        for ch in data.decode(errors="ignore"):
            if ch in "\r\n":
                cmd, line = line.strip(), ""
                channel.send("\r\n")
                if cmd in ("exit", "logout"):
                    channel.send("logout\r\n")
                    channel.send_exit_status(0)
                    channel.close()
                    return
                if cmd == "clear":
                    channel.send("\x1b[2J\x1b[H")
                elif cmd:
                    out = _DEMO_SHELL_COMMANDS.get(cmd.split()[0], f"{cmd.split()[0]}: command not found (demo shell)")
                    channel.send(out + "\r\n")
                channel.send(prompt)
            elif ch in "\x7f\b":
                if line:
                    line = line[:-1]
                    channel.send("\b \b")
            elif ch == "\x03":
                line = ""
                channel.send("^C\r\n" + prompt)
            elif ch >= " ":
                line += ch
                channel.send(ch)


def _start_demo_ssh_server(data_dir: Path) -> int:
    """Serve the demo shell over real SSH on 127.0.0.1 (any user, any password or key); returns the port."""
    import socket
    import threading

    import paramiko

    key_file = data_dir / "demo_ssh_host_key"
    if key_file.exists():
        host_key = paramiko.RSAKey.from_private_key_file(str(key_file))
    else:
        host_key = paramiko.RSAKey.generate(2048)
        host_key.write_private_key_file(str(key_file))

    class DemoServer(paramiko.ServerInterface):
        def check_auth_password(self, username, password):
            return paramiko.AUTH_SUCCESSFUL

        def check_auth_publickey(self, username, key):
            return paramiko.AUTH_SUCCESSFUL

        def get_allowed_auths(self, username):
            return "publickey,password"

        def check_channel_request(self, kind, chanid):
            return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

        def check_channel_pty_request(self, *args):
            return True

        def check_channel_window_change_request(self, *args):
            return True

        def check_channel_shell_request(self, channel):
            threading.Thread(target=_demo_shell, args=(channel,), daemon=True).start()
            return True

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)

    def serve() -> None:
        while True:
            conn, _ = listener.accept()
            transport = paramiko.Transport(conn)
            transport.add_server_key(host_key)
            try:
                transport.start_server(server=DemoServer())
            except Exception:
                transport.close()

    threading.Thread(target=serve, name="demo-ssh", daemon=True).start()
    return listener.getsockname()[1]


async def main(reset: bool, fresh: bool) -> None:
    data_dir = _prepare_environment(reset, fresh)

    import uvicorn
    from fastapi.responses import JSONResponse

    from app.main import app
    from app.scanner.scheduler import scheduler

    async def _noop(*_args, **_kwargs) -> None:
        return None

    scheduler.start = _noop  # the lifespan awaits scheduler.start(); no background scans in demo mode
    scheduler.stop = _noop

    # Every SSH terminal session lands on the built-in fake shell instead of the target host
    import socket
    import app.services.ssh_terminal as ssh_terminal

    demo_ssh_port = _start_demo_ssh_server(data_dir)
    ssh_terminal._open_socket = lambda _host, _port: socket.create_connection(("127.0.0.1", demo_ssh_port), timeout=5)

    @app.middleware("http")
    async def _demo_guard(request, call_next):
        if _BLOCKED_PATHS.match(request.url.path):
            return JSONResponse({"detail": "Disabled in demo mode (no LAN scans, no SSH)."}, status_code=403)
        return await call_next(request)

    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=PORT, log_level="warning"))

    if fresh:
        # Like a new install: no data and no completed setup, so the UI opens the setup wizard
        from app.database import init_db

        await init_db()
        print(f"[demo] fresh install, database: {data_dir} - the setup wizard sets the password")
        print(f"[demo] API on http://{HOST}:{PORT} - start the UI with `cd frontend && npm run dev`")
        await server.serve()
        return

    agents = await _seed()
    print(f"[demo] {len(agents)} simulated agents, database: {data_dir}")
    print(f"[demo] API on http://{HOST}:{PORT} - start the UI with `cd frontend && npm run dev`, log in with the demo password (see README)")
    await asyncio.gather(server.serve(), _simulate_agents(server, agents))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--reset", action="store_true", help="wipe the demo database and seed it again")
    parser.add_argument("--fresh", action="store_true", help="start like a new install (empty database, setup wizard)")
    args = parser.parse_args()
    asyncio.run(main(args.reset, args.fresh))
