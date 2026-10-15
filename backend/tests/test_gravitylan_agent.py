"""Tests for the standalone gravitylan agent (agent/gravitylan-agent.py).

The agent module has a hyphenated filename, so it is loaded via importlib
rather than a normal import statement.
"""

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

AGENT_PATH = Path(__file__).resolve().parent.parent.parent / "agent" / "gravitylan-agent.py"


@pytest.fixture(scope="module")
def agent_mod() -> types.ModuleType:
    """Load the agent script as a module once per test module."""
    spec = importlib.util.spec_from_file_location("gravitylan_agent_under_test", AGENT_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# --- AgentConfig ------------------------------------------------------------

def test_config_load_required_keys(agent_mod, tmp_path):
    cfg = tmp_path / "agent.conf"
    cfg.write_text('{"server_url": "192.168.1.10:8000", "token": "t", "device_id": 3}', encoding="utf-8")
    config = agent_mod.AgentConfig.load(cfg)
    assert config.server_url == "http://192.168.1.10:8000"  # scheme auto-added
    assert config.device_id == 3
    assert config.interval == 30  # default


def test_config_load_missing_key(agent_mod, tmp_path):
    cfg = tmp_path / "agent.conf"
    cfg.write_text('{"server_url": "http://x", "device_id": 1}', encoding="utf-8")
    with pytest.raises(KeyError):
        agent_mod.AgentConfig.load(cfg)


def test_config_load_invalid_json(agent_mod, tmp_path):
    cfg = tmp_path / "agent.conf"
    cfg.write_text("{nope", encoding="utf-8")
    with pytest.raises(ValueError):
        agent_mod.AgentConfig.load(cfg)


def test_config_save_roundtrip(agent_mod, tmp_path):
    cfg = tmp_path / "agent.conf"
    config = agent_mod.AgentConfig(
        server_url="http://x", token="t", device_id=1, interval=15, config_path=cfg
    )
    config.save()
    loaded = agent_mod.AgentConfig.load(cfg)
    assert loaded.interval == 15


# --- is_lxc_container / get_lxc_cpu_count -----------------------------------

def test_is_lxc_container_false(agent_mod, tmp_path):
    assert agent_mod.is_lxc_container(str(tmp_path)) is False


def test_is_lxc_container_systemd_marker(agent_mod, tmp_path):
    marker = tmp_path / "run/systemd/container"
    marker.parent.mkdir(parents=True)
    marker.write_text("lxc", encoding="utf-8")
    assert agent_mod.is_lxc_container(str(tmp_path)) is True


def test_get_lxc_cpu_count_cgroup_v2(agent_mod, tmp_path):
    cpu_max = tmp_path / "sys/fs/cgroup/cpu.max"
    cpu_max.parent.mkdir(parents=True)
    cpu_max.write_text("100000 100000\n", encoding="utf-8")
    assert agent_mod.get_lxc_cpu_count(str(tmp_path)) == 1.0


def test_get_lxc_cpu_count_fallback(agent_mod, tmp_path, monkeypatch):
    monkeypatch.setattr(agent_mod.os, "cpu_count", lambda: 8)
    assert agent_mod.get_lxc_cpu_count(str(tmp_path)) == 8


# Cases below were ported from the removed agent/test_agent.py (it still tested
# the old homelan-agent.py functions; the agent now uses collector classes).

def _mark_lxc_via_cgroup(root):
    cgroup = root / "proc/self/cgroup"
    cgroup.parent.mkdir(parents=True, exist_ok=True)
    cgroup.write_text("12:cpu,cpuacct:/lxc/my-container-id\n", encoding="utf-8")


def test_is_lxc_container_cgroup(agent_mod, tmp_path):
    _mark_lxc_via_cgroup(tmp_path)
    assert agent_mod.is_lxc_container(str(tmp_path)) is True


def test_is_lxc_container_pid1_environ(agent_mod, tmp_path):
    environ = tmp_path / "proc/1/environ"
    environ.parent.mkdir(parents=True)
    environ.write_bytes(b"PATH=/bin\x00container=lxc\x00USER=root\x00")
    assert agent_mod.is_lxc_container(str(tmp_path)) is True


def test_get_lxc_cpu_count_cgroup_v1(agent_mod, tmp_path):
    cpu_v1 = tmp_path / "sys/fs/cgroup/cpu"
    cpu_v1.mkdir(parents=True)
    (cpu_v1 / "cpu.cfs_quota_us").write_text("150000\n", encoding="utf-8")
    (cpu_v1 / "cpu.cfs_period_us").write_text("100000\n", encoding="utf-8")
    assert agent_mod.get_lxc_cpu_count(str(tmp_path)) == 1.5


# --- CPUMetrics / RAMMetrics ------------------------------------------------------

def test_cpu_metrics_proc_stat_delta(agent_mod, tmp_path):
    stat = tmp_path / "proc/stat"
    stat.parent.mkdir(parents=True)
    metrics = agent_mod.CPUMetrics(root_path=str(tmp_path))

    stat.write_text("cpu  100 0 50 1000 0 0 0 0\n", encoding="utf-8")
    assert metrics.collect(_make_config(agent_mod)) == 0.0  # first sample has no delta

    # total +100, idle +50 -> 50 % busy
    stat.write_text("cpu  125 0 75 1050 0 0 0 0\n", encoding="utf-8")
    assert metrics.collect(_make_config(agent_mod)) == 50.0


def test_cpu_metrics_lxc_cgroup_v2(agent_mod, tmp_path, monkeypatch):
    import time as real_time

    _mark_lxc_via_cgroup(tmp_path)
    cgroup = tmp_path / "sys/fs/cgroup"
    cgroup.mkdir(parents=True)
    (cgroup / "cpu.max").write_text("200000 100000\n", encoding="utf-8")  # 2 cores
    (cgroup / "cpu.stat").write_text("usage_usec 1000000\n", encoding="utf-8")
    # A fixed wall clock: with the real one the result depended on how fast the test ran (flaky under load)
    clock = [1000.0]
    fake_time = SimpleNamespace(time=lambda: clock[0], monotonic=real_time.monotonic, sleep=real_time.sleep)
    monkeypatch.setattr(agent_mod, "time", fake_time)
    metrics = agent_mod.CPUMetrics(root_path=str(tmp_path))

    assert metrics.collect(_make_config(agent_mod)) == 0.0

    # +0.5 s CPU time over 1.0 s wall time on 2 cores -> 25 %
    (cgroup / "cpu.stat").write_text("usage_usec 1500000\n", encoding="utf-8")
    clock[0] += 1.0
    assert metrics.collect(_make_config(agent_mod)) == pytest.approx(25.0)


def test_ram_metrics_meminfo(agent_mod, tmp_path):
    meminfo = tmp_path / "proc/meminfo"
    meminfo.parent.mkdir(parents=True)
    meminfo.write_text("MemTotal:        16000000 kB\nMemAvailable:     8000000 kB\n", encoding="utf-8")

    ram = agent_mod.RAMMetrics(root_path=str(tmp_path)).collect(_make_config(agent_mod))
    assert ram == {"total_mb": 15625, "used_mb": 7812, "percent": 50.0}


def test_ram_metrics_lxc_cgroup_v2(agent_mod, tmp_path):
    _mark_lxc_via_cgroup(tmp_path)
    cgroup = tmp_path / "sys/fs/cgroup"
    cgroup.mkdir(parents=True)
    (cgroup / "memory.current").write_text(f"{1024**3}\n", encoding="utf-8")
    (cgroup / "memory.max").write_text(f"{2 * 1024**3}\n", encoding="utf-8")

    ram = agent_mod.RAMMetrics(root_path=str(tmp_path)).collect(_make_config(agent_mod))
    assert ram == {"total_mb": 2048, "used_mb": 1024, "percent": 50.0}


def test_ram_metrics_lxc_cgroup_v1(agent_mod, tmp_path):
    _mark_lxc_via_cgroup(tmp_path)
    memory = tmp_path / "sys/fs/cgroup/memory"
    memory.mkdir(parents=True)
    (memory / "memory.usage_in_bytes").write_text(f"{512 * 1024**2}\n", encoding="utf-8")
    (memory / "memory.limit_in_bytes").write_text(f"{1024**3}\n", encoding="utf-8")

    ram = agent_mod.RAMMetrics(root_path=str(tmp_path)).collect(_make_config(agent_mod))
    assert ram == {"total_mb": 1024, "used_mb": 512, "percent": 50.0}


# --- systemd unit template --------------------------------------------------------

def test_service_unit_matches_deployer_install_dir():
    """agent/gravitylan-agent.service pointed to /opt/gravitylan, the deployer installs to /opt/gravitylan-agent."""
    from app.services import agent_deployer

    unit = (AGENT_PATH.parent / "gravitylan-agent.service").read_text(encoding="utf-8")
    lines = dict(line.split("=", 1) for line in unit.splitlines() if "=" in line)
    assert lines["ExecStart"].split()[-1] == agent_deployer.REMOTE_AGENT_PATH
    assert lines["WorkingDirectory"] == agent_deployer.REMOTE_BASE_DIR


def test_service_units_are_sandboxed():
    """Template and SSH-deploy unit get a private /tmp and a read-only /home (not hidden:
    the disk metrics read /home's real usage); NoNewPrivileges would break 'sudo -n'."""
    from app.services import agent_deployer

    template = (AGENT_PATH.parent / "gravitylan-agent.service").read_text(encoding="utf-8")
    for unit in (template, agent_deployer._generate_service_unit()):
        assert "\nPrivateTmp=true\n" in unit
        assert "\nProtectHome=read-only\n" in unit
        assert "NoNewPrivileges=" not in unit


def test_legacy_homelan_agent_files_are_gone():
    agent_dir = AGENT_PATH.parent
    for name in ("homelan-agent.py", "homelan-agent.service", "test_agent.py"):
        assert not (agent_dir / name).exists(), name


# --- PatchMetrics -----------------------------------------------------------

def _make_config(agent_mod):
    return agent_mod.AgentConfig(
        server_url="http://x", token="t", device_id=1, enable_patch_check=True
    )


def test_patch_metrics_disabled(agent_mod):
    config = _make_config(agent_mod)
    config.enable_patch_check = False
    assert agent_mod.PatchMetrics().collect(config) is None


def test_patch_metrics_apt(agent_mod):

    fake_shutil = SimpleNamespace(
        which=lambda name: "/usr/bin/apt-get" if name == "apt-get" else None
    )
    with patch.object(agent_mod, "_apt_cache_is_stale", return_value=False), \
         patch.object(agent_mod, "subprocess", SimpleNamespace(check_output=lambda *a, **k: b"Inst foo [1.0] (1.1 security) [a]\nInst bar [2.0] [b]\n", run=None, DEVNULL=None)), \
         patch.object(agent_mod.os.path, "exists", return_value=False), \
         patch.object(agent_mod, "shutil", fake_shutil):
        result = agent_mod.PatchMetrics().collect(_make_config(agent_mod))

    assert result["patch_manager"] == "apt"
    assert result["patch_available"] == 2
    assert result["patch_security"] == 1
    assert result["reboot_required"] is False


def test_patch_metrics_apt_reboot_flag(agent_mod):

    fake_shutil = SimpleNamespace(
        which=lambda name: "/usr/bin/apt-get" if name == "apt-get" else None
    )
    with patch.object(agent_mod, "_apt_cache_is_stale", return_value=False), \
         patch.object(agent_mod, "subprocess", SimpleNamespace(check_output=lambda *a, **k: b"", run=None, DEVNULL=None)), \
         patch.object(agent_mod.os.path, "exists", return_value=True), \
         patch.object(agent_mod, "shutil", fake_shutil):
        result = agent_mod.PatchMetrics().collect(_make_config(agent_mod))

    assert result["reboot_required"] is True


def test_patch_metrics_dnf(agent_mod):

    proc = MagicMock()
    proc.stdout = b"pkg1.x86_64 1.0 repo\npkg2.noarch 2.0 repo\n"
    proc_sec = MagicMock()
    proc_sec.stdout = b"Security fix 1\n"

    def fake_run(cmd, **kwargs):
        return proc_sec if "updateinfo" in cmd else proc

    fake_subprocess = SimpleNamespace(
        run=fake_run, check_output=lambda *a, **k: b"", PIPE=-1, DEVNULL=None
    )
    fake_shutil = SimpleNamespace(
        which=lambda name: "/usr/bin/dnf" if name == "dnf" else None
    )
    with patch.object(agent_mod, "subprocess", fake_subprocess), \
         patch.object(agent_mod, "shutil", fake_shutil):
        result = agent_mod.PatchMetrics().collect(_make_config(agent_mod))

    assert result["patch_manager"] == "dnf"
    assert result["patch_available"] == 2
    assert result["patch_security"] == 1


def test_patch_metrics_unknown_manager(agent_mod):

    fake_shutil = SimpleNamespace(which=lambda name: None)
    with patch.object(agent_mod, "shutil", fake_shutil):
        assert agent_mod.PatchMetrics().collect(_make_config(agent_mod)) is None


def _fake_clock(agent_mod, monkeypatch, clock: list) -> None:
    """Swap the agent's time module for one whose monotonic() returns clock[0]."""
    import time as real_time

    fake_time = SimpleNamespace(monotonic=lambda: clock[0], time=real_time.time, sleep=real_time.sleep)
    monkeypatch.setattr(agent_mod, "time", fake_time)


def _apt_only(agent_mod):
    return SimpleNamespace(which=lambda name: "/usr/bin/apt-get" if name == "apt-get" else None)


def test_patch_metrics_caches_package_checks(agent_mod, monkeypatch):
    """Package-manager subprocesses run at most once per cache_ttl, not every report."""
    calls = []

    def fake_check_output(cmd, **kwargs):
        calls.append(cmd)
        return b"Inst foo [1.0] (1.1 security) [a]\n"

    monkeypatch.setattr(agent_mod, "_package_db_mtime", lambda: 100.0)
    clock = [1000.0]
    _fake_clock(agent_mod, monkeypatch, clock)
    with patch.object(agent_mod, "_apt_cache_is_stale", return_value=False), \
         patch.object(agent_mod, "subprocess", SimpleNamespace(check_output=fake_check_output, run=None, DEVNULL=None)), \
         patch.object(agent_mod.os.path, "exists", return_value=False), \
         patch.object(agent_mod, "shutil", _apt_only(agent_mod)):
        metrics = agent_mod.PatchMetrics(cache_ttl=3600)
        first = metrics.collect(_make_config(agent_mod))
        clock[0] += 30
        second = metrics.collect(_make_config(agent_mod))
        assert len(calls) == 1
        assert second == first

        clock[0] += 3600
        metrics.collect(_make_config(agent_mod))
        assert len(calls) == 2


def test_patch_metrics_cache_dropped_when_packages_change(agent_mod, monkeypatch):
    """After an upgrade (package DB touched) the next report re-checks right away."""
    outputs = iter([b"Inst foo [1.0] [a]\nInst bar [2.0] [b]\n", b""])
    db_mtime = [100.0]
    monkeypatch.setattr(agent_mod, "_package_db_mtime", lambda: db_mtime[0])
    with patch.object(agent_mod, "_apt_cache_is_stale", return_value=False), \
         patch.object(agent_mod, "subprocess", SimpleNamespace(check_output=lambda *a, **k: next(outputs), run=None, DEVNULL=None)), \
         patch.object(agent_mod.os.path, "exists", return_value=False), \
         patch.object(agent_mod, "shutil", _apt_only(agent_mod)):
        metrics = agent_mod.PatchMetrics()
        assert metrics.collect(_make_config(agent_mod))["patch_available"] == 2
        db_mtime[0] = 200.0
        assert metrics.collect(_make_config(agent_mod))["patch_available"] == 0


def test_patch_metrics_cached_result_is_a_copy(agent_mod, monkeypatch):
    monkeypatch.setattr(agent_mod, "_package_db_mtime", lambda: 0.0)
    with patch.object(agent_mod, "_apt_cache_is_stale", return_value=False), \
         patch.object(agent_mod, "subprocess", SimpleNamespace(check_output=lambda *a, **k: b"", run=None, DEVNULL=None)), \
         patch.object(agent_mod.os.path, "exists", return_value=False), \
         patch.object(agent_mod, "shutil", _apt_only(agent_mod)):
        metrics = agent_mod.PatchMetrics()
        metrics.collect(_make_config(agent_mod))["patch_available"] = 99
        assert metrics.collect(_make_config(agent_mod))["patch_available"] == 0


# --- NetworkMetrics / ThermalMetrics ------------------------------------------

_NET_DEV_HEADER = (
    "Inter-|   Receive                                                |  Transmit\n"
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
)


def _write_net_dev(root, rx: int, tx: int) -> None:
    dev = root / "proc/net/dev"
    dev.parent.mkdir(parents=True, exist_ok=True)
    dev.write_text(
        _NET_DEV_HEADER
        + "    lo:  500 5 0 0 0 0 0 0  500 5 0 0 0 0 0 0\n"
        + f"  eth0: {rx} 10 0 0 0 0 0 0 {tx} 20 0 0 0 0 0 0\n",
        encoding="utf-8",
    )


def test_network_metrics_first_call_returns_zero(agent_mod, tmp_path):
    _write_net_dev(tmp_path, rx=1000, tx=2000)
    result = agent_mod.NetworkMetrics(root_path=str(tmp_path)).collect(_make_config(agent_mod))
    assert result == {"eth0": {"rx_bytes_sec": 0, "tx_bytes_sec": 0}}


def test_network_metrics_reports_bytes_per_second(agent_mod, tmp_path, monkeypatch):
    clock = [5000.0]
    _fake_clock(agent_mod, monkeypatch, clock)
    metrics = agent_mod.NetworkMetrics(root_path=str(tmp_path))

    _write_net_dev(tmp_path, rx=1000, tx=2000)
    metrics.collect(_make_config(agent_mod))

    # 30 s report interval: +30000 rx / +60000 tx bytes is 1000 / 2000 bytes per second
    clock[0] += 30
    _write_net_dev(tmp_path, rx=31000, tx=62000)
    result = metrics.collect(_make_config(agent_mod))
    assert result["eth0"] == {"rx_bytes_sec": 1000, "tx_bytes_sec": 2000}


def test_network_metrics_counter_reset_is_not_negative(agent_mod, tmp_path, monkeypatch):
    clock = [5000.0]
    _fake_clock(agent_mod, monkeypatch, clock)
    metrics = agent_mod.NetworkMetrics(root_path=str(tmp_path))
    _write_net_dev(tmp_path, rx=90000, tx=90000)
    metrics.collect(_make_config(agent_mod))

    clock[0] += 10
    _write_net_dev(tmp_path, rx=100, tx=100)
    assert metrics.collect(_make_config(agent_mod))["eth0"] == {"rx_bytes_sec": 0, "tx_bytes_sec": 0}


def test_network_metrics_missing_proc_returns_empty(agent_mod, tmp_path):
    assert agent_mod.NetworkMetrics(root_path=str(tmp_path)).collect(_make_config(agent_mod)) == {}


def test_thermal_metrics_reads_mock_root(agent_mod, tmp_path):
    zone = tmp_path / "sys/class/thermal/thermal_zone0"
    zone.mkdir(parents=True)
    (zone / "type").write_text("x86_pkg_temp\n", encoding="utf-8")
    (zone / "temp").write_text("48500\n", encoding="utf-8")

    config = _make_config(agent_mod)
    assert agent_mod.ThermalMetrics(root_path=str(tmp_path)).collect(config) == 48.5
    config.enable_temp = False
    assert agent_mod.ThermalMetrics(root_path=str(tmp_path)).collect(config) is None


def test_thermal_metrics_no_sysfs(agent_mod, tmp_path):
    assert agent_mod.ThermalMetrics(root_path=str(tmp_path)).collect(_make_config(agent_mod)) is None


# --- cleanup_ghosts -----------------------------------------------------------

def test_is_agent_process(agent_mod):
    assert agent_mod._is_agent_process("/usr/bin/python3 /opt/gravitylan/gravitylan-agent.py")
    assert agent_mod._is_agent_process("python3 gravitylan-agent.py")
    assert agent_mod._is_agent_process("/usr/bin/python3.11 -u /opt/gravitylan-agent/gravitylan-agent.py")
    assert not agent_mod._is_agent_process("vim gravitylan-agent.py")
    assert not agent_mod._is_agent_process("tail -f /opt/gravitylan-agent/gravitylan-agent.log")
    assert not agent_mod._is_agent_process("less /opt/gravitylan-agent/gravitylan-agent.py")
    assert not agent_mod._is_agent_process("python3 /opt/other/agent.py")
    assert not agent_mod._is_agent_process("")


def test_cleanup_ghosts_only_kills_other_agent_interpreters(agent_mod, monkeypatch):
    ps_output = (
        "    1 /sbin/init\n"
        "  100 /usr/bin/python3 /opt/gravitylan/gravitylan-agent.py\n"
        "  200 python3 gravitylan-agent.py\n"
        "  300 vim /opt/gravitylan-agent/gravitylan-agent.py\n"
        "  400 tail -f /opt/gravitylan-agent/gravitylan-agent.log\n"
        " 1100 python3 gravitylan-agent.py\n"
        "garbage line\n"
    ).encode()
    killed = []
    monkeypatch.setattr(agent_mod.subprocess, "check_output", lambda *a, **k: ps_output)
    monkeypatch.setattr(agent_mod.os, "getpid", lambda: 200)
    monkeypatch.setattr(agent_mod.os, "kill", lambda pid, sig: killed.append(pid))

    agent_mod.cleanup_ghosts()

    # pid 1100 contains "100" and "200" is our own pid: only exact pid comparisons count
    assert killed == [100, 1100]


def test_cleanup_ghosts_survives_missing_ps(agent_mod, monkeypatch):
    def no_ps(*args, **kwargs):
        raise FileNotFoundError("ps")

    monkeypatch.setattr(agent_mod.subprocess, "check_output", no_ps)
    agent_mod.cleanup_ghosts()  # must not raise


# --- DiskMetrics ------------------------------------------------------------

def test_disk_metrics_uses_zfs_stats(agent_mod, monkeypatch):
    monkeypatch.setattr(
        agent_mod, "_collect_zfs_stats",
        lambda: {"/data": {"used": 10 * 1024**3, "avail": 30 * 1024**3, "refer": 0}},
    )
    config = _make_config(agent_mod)
    config.disk_paths = ["/data"]

    result = agent_mod.DiskMetrics().collect(config)
    assert len(result) == 1
    assert result[0]["path"] == "/data"
    assert result[0]["total_gb"] == 40.0


def test_disk_metrics_statvfs_fallback(agent_mod, monkeypatch):

    monkeypatch.setattr(agent_mod, "_collect_zfs_stats", lambda: {})

    fake_os = SimpleNamespace(
        statvfs=lambda p: MagicMock(
            f_blocks=10 * 1024**3 // 4096,
            f_frsize=4096,
            f_files=1000,
            f_bavail=8 * 1024**3 // 4096,
        ),
        getenv=agent_mod.os.getenv,
    )
    monkeypatch.setattr(agent_mod, "os", fake_os)

    config = _make_config(agent_mod)
    config.disk_paths = ["/mnt"]

    result = agent_mod.DiskMetrics().collect(config)
    assert len(result) == 1
    assert result[0]["total_gb"] == 10.0
    assert result[0]["used_gb"] == 2.0


def test_disk_metrics_skips_unreadable(agent_mod, monkeypatch):

    monkeypatch.setattr(agent_mod, "_collect_zfs_stats", lambda: {})

    def fake_statvfs(path):
        raise PermissionError("nope")

    fake_os = SimpleNamespace(statvfs=fake_statvfs, getenv=agent_mod.os.getenv)
    monkeypatch.setattr(agent_mod, "os", fake_os)

    config = _make_config(agent_mod)
    config.disk_paths = ["/nope"]

    assert agent_mod.DiskMetrics().collect(config) == []


# --- ReportSender / Orchestrator --------------------------------------------

def test_report_sender_success(agent_mod):
    config = _make_config(agent_mod)
    sender = agent_mod.ReportSender(config)
    payload = {"device_id": 1}

    resp = MagicMock()
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    resp.read.return_value = b'{"ok": true}'

    with patch.object(agent_mod.urllib.request, "urlopen", return_value=resp):
        result = sender.send(payload)

    assert result == {"ok": True}
    assert sender.consecutive_failures == 0


def test_report_sender_backoff_on_error(agent_mod):
    from urllib.error import URLError

    config = _make_config(agent_mod)
    sender = agent_mod.ReportSender(config)

    with patch.object(agent_mod.urllib.request, "urlopen", side_effect=URLError("down")):
        assert sender.send({"device_id": 1}) is None

    assert sender.consecutive_failures == 1


def test_orchestrator_collect_all(agent_mod, monkeypatch):

    fake_os = SimpleNamespace(
        statvfs=lambda p: MagicMock(
            f_blocks=10 * 1024**3 // 4096,
            f_frsize=4096,
            f_files=1000,
            f_bavail=8 * 1024**3 // 4096,
        ),
        getenv=agent_mod.os.getenv,
    )
    monkeypatch.setattr(agent_mod, "os", fake_os)
    # Behave like a Linux host with apt on every OS, so an unmocked patch
    # collector would fail here too instead of only on the Linux CI runner.
    monkeypatch.setattr(agent_mod.shutil, "which", lambda name: f"/usr/bin/{name}")

    config = _make_config(agent_mod)
    orch = agent_mod.AgentOrchestrator(config)
    patches = {"patch_available": 3, "patch_security": 1, "patch_manager": "apt"}

    # The patch collector shells out to apt/dnf/yum; never run real package managers in tests.
    with patch.object(orch.collectors["system"], "collect", return_value={"os": "TestOS"}), \
         patch.object(orch.collectors["temperature"], "collect", return_value=None), \
         patch.object(orch.collectors["patches"], "collect", return_value=patches):
        payload = orch.collect_all()

    assert payload["device_id"] == 1
    assert payload["system"] == {"os": "TestOS"}
    assert payload["patches"] == patches
    assert "temperature" not in payload


def test_orchestrator_process_response_updates_config(agent_mod):
    config = _make_config(agent_mod)
    orch = agent_mod.AgentOrchestrator(config)
    orch.config.save = MagicMock()

    orch.process_response({
        "device_id": 42,
        "config": {"interval": 60, "enable_temp": False},
    })

    assert orch.config.device_id == 42
    assert orch.config.interval == 60
    assert orch.config.enable_temp is False
    orch.config.save.assert_called_once()
