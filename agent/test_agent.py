import unittest
import os
import shutil
import tempfile
from pathlib import Path
import time

# Import the agent script
import importlib.util
import sys

# Add the agent directory to path so we can import the script
AGENT_DIR = Path(__file__).parent.absolute()
spec = importlib.util.spec_from_file_location("agent", AGENT_DIR / "homelan-agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class TestAgentCollectors(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.proc_dir = Path(self.test_dir) / "proc"
        self.sys_dir = Path(self.test_dir) / "sys"
        self.proc_dir.mkdir(parents=True)
        self.sys_dir.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_collect_cpu(self):
        # Create mock /proc/stat
        stat_file = self.proc_dir / "stat"
        
        # First sample
        stat_file.write_text("cpu  100 0 50 1000 0 0 0 0\n")
        val1 = agent.collect_cpu(root_path=self.test_dir)
        self.assertEqual(val1, 0.0) # First call always 0.0
        
        # Second sample (increased total by 100, idle by 50 -> 50% usage)
        stat_file.write_text("cpu  125 0 75 1050 0 0 0 0\n")
        val2 = agent.collect_cpu(root_path=self.test_dir)
        self.assertEqual(val2, 50.0)

    def test_collect_ram(self):
        # Create mock /proc/meminfo
        mem_file = self.proc_dir / "meminfo"
        mem_file.write_text(
            "MemTotal:        16000000 kB\n"
            "MemAvailable:     8000000 kB\n"
        )
        
        ram = agent.collect_ram(root_path=self.test_dir)
        self.assertEqual(ram["total_mb"], 15625) # 16000000 / 1024
        self.assertEqual(ram["used_mb"], 7812)   # (16000000 - 8000000) / 1024
        self.assertEqual(ram["percent"], 50.0)

    def test_collect_network(self):
        # Create mock /proc/net/dev
        net_file = self.proc_dir / "net"
        net_file.mkdir(parents=True)
        dev_file = net_file / "dev"
        
        # First sample
        dev_file.write_text(
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
            "  eth0:    1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0\n"
        )
        agent._prev_net = None # Reset global
        first = agent.collect_network(root_path=self.test_dir)
        self.assertEqual(first["eth0"], {"rx_bytes_sec": 0, "tx_bytes_sec": 0})
        # Pretend the first sample was taken 10 s ago
        agent._prev_net_time -= 10
        
        # Second sample (+1000 rx, +2000 tx over 10 s)
        dev_file.write_text(
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
            "  eth0:    2000      11    0    0    0     0          0         0     4000      22    0    0    0     0       0          0\n"
        )
        net = agent.collect_network(root_path=self.test_dir)
        # Rates are per second, not per collection interval
        self.assertAlmostEqual(net["eth0"]["rx_bytes_sec"], 100, delta=1)
        self.assertAlmostEqual(net["eth0"]["tx_bytes_sec"], 200, delta=1)

    def test_collect_temperature(self):
        # Create mock /sys/class/thermal
        thermal_dir = self.sys_dir / "class" / "thermal" / "thermal_zone0"
        thermal_dir.mkdir(parents=True)
        
        (thermal_dir / "type").write_text("cpu-thermal\n")
        (thermal_dir / "temp").write_text("45500\n")
        
        temp = agent.collect_temperature(root_path=self.test_dir)
        self.assertEqual(temp, 45.5)

    def test_is_lxc_container(self):
        # 1. Test not LXC
        self.assertFalse(agent.is_lxc_container(root_path=self.test_dir))

        # 2. Test Method 1: run/systemd/container
        container_path = Path(self.test_dir) / "run" / "systemd"
        container_path.mkdir(parents=True, exist_ok=True)
        (container_path / "container").write_text("lxc\n")
        self.assertTrue(agent.is_lxc_container(root_path=self.test_dir))
        
        # Clean up Method 1
        (container_path / "container").unlink()

        # 3. Test Method 2: proc/self/cgroup
        proc_self = Path(self.test_dir) / "proc" / "self"
        proc_self.mkdir(parents=True, exist_ok=True)
        (proc_self / "cgroup").write_text("12:cpu,cpuacct:/lxc/my-container-id\n")
        self.assertTrue(agent.is_lxc_container(root_path=self.test_dir))

        # Clean up Method 2
        (proc_self / "cgroup").unlink()

        # 4. Test Method 3: proc/1/environ
        proc_1 = Path(self.test_dir) / "proc" / "1"
        proc_1.mkdir(parents=True, exist_ok=True)
        (proc_1 / "environ").write_bytes(b"PATH=/bin\x00container=lxc\x00USER=root\x00")
        self.assertTrue(agent.is_lxc_container(root_path=self.test_dir))

    def test_get_lxc_cpu_count(self):
        # Default fallback (should be at least 1.0 or host cpu count)
        count = agent.get_lxc_cpu_count(root_path=self.test_dir)
        self.assertGreaterEqual(count, 1.0)

        # Cgroup v2 cpu.max
        cgroup_dir = Path(self.test_dir) / "sys" / "fs" / "cgroup"
        cgroup_dir.mkdir(parents=True, exist_ok=True)
        (cgroup_dir / "cpu.max").write_text("200000 100000\n")
        self.assertEqual(agent.get_lxc_cpu_count(root_path=self.test_dir), 2.0)
        (cgroup_dir / "cpu.max").unlink()

        # Cgroup v1 quota/period
        cpu_v1_dir = Path(self.test_dir) / "sys" / "fs" / "cgroup" / "cpu"
        cpu_v1_dir.mkdir(parents=True, exist_ok=True)
        (cpu_v1_dir / "cpu.cfs_quota_us").write_text("150000\n")
        (cpu_v1_dir / "cpu.cfs_period_us").write_text("100000\n")
        self.assertEqual(agent.get_lxc_cpu_count(root_path=self.test_dir), 1.5)

    def test_collect_cpu_lxc(self):
        # Mark as LXC container via cgroup
        proc_self = Path(self.test_dir) / "proc" / "self"
        proc_self.mkdir(parents=True, exist_ok=True)
        (proc_self / "cgroup").write_text("12:cpu,cpuacct:/lxc/my-container-id\n")

        # Cgroup v2 cpu.stat and cpu.max
        cgroup_dir = Path(self.test_dir) / "sys" / "fs" / "cgroup"
        cgroup_dir.mkdir(parents=True, exist_ok=True)
        (cgroup_dir / "cpu.max").write_text("200000 100000\n") # 2 cores

        # First sample: usage_usec is 1000000 (1 sec = 1,000,000,000 ns)
        (cgroup_dir / "cpu.stat").write_text("usage_usec 1000000\n")
        agent._prev_lxc_cpu = None  # Reset state
        
        t0 = time.time()
        val1 = agent.collect_cpu(root_path=self.test_dir)
        self.assertEqual(val1, 0.0)

        # Mock second sample: usage_usec increased by 500000 (0.5 sec = 500,000,000 ns)
        # We override the stored _prev_lxc_cpu to control delta_time precisely (e.g. 1.0 seconds)
        (cgroup_dir / "cpu.stat").write_text("usage_usec 1500000\n")
        agent._prev_lxc_cpu = (t0 - 1.0, 1000000 * 1000)
        
        # Delta usage = 500ms. Delta time = 1.0s. Cores = 2.
        # Usage % = (500ms / 1000ms) * 100 / 2 = 25%
        val2 = agent.collect_cpu(root_path=self.test_dir)
        self.assertEqual(val2, 25.0)

    def test_collect_ram_lxc_v2(self):
        # Mark as LXC container
        proc_self = Path(self.test_dir) / "proc" / "self"
        proc_self.mkdir(parents=True, exist_ok=True)
        (proc_self / "cgroup").write_text("12:cpu,cpuacct:/lxc/my-container-id\n")

        # Cgroup v2 memory config
        cgroup_dir = Path(self.test_dir) / "sys" / "fs" / "cgroup"
        cgroup_dir.mkdir(parents=True, exist_ok=True)
        
        # 1 GB current usage, 2 GB max limit
        (cgroup_dir / "memory.current").write_text("1073741824\n")
        (cgroup_dir / "memory.max").write_text("2147483648\n")

        ram = agent.collect_ram(root_path=self.test_dir)
        self.assertEqual(ram["total_mb"], 2048)
        self.assertEqual(ram["used_mb"], 1024)
        self.assertEqual(ram["percent"], 50.0)

    def test_collect_ram_lxc_v1(self):
        # Mark as LXC container
        proc_self = Path(self.test_dir) / "proc" / "self"
        proc_self.mkdir(parents=True, exist_ok=True)
        (proc_self / "cgroup").write_text("12:cpu,cpuacct:/lxc/my-container-id\n")

        # Cgroup v1 memory config
        cgroup_mem_dir = Path(self.test_dir) / "sys" / "fs" / "cgroup" / "memory"
        cgroup_mem_dir.mkdir(parents=True, exist_ok=True)

        # 512 MB current, 1 GB max limit
        (cgroup_mem_dir / "memory.usage_in_bytes").write_text("536870912\n")
        (cgroup_mem_dir / "memory.limit_in_bytes").write_text("1073741824\n")

        ram = agent.collect_ram(root_path=self.test_dir)
        self.assertEqual(ram["total_mb"], 1024)
        self.assertEqual(ram["used_mb"], 512)
        self.assertEqual(ram["percent"], 50.0)

if __name__ == "__main__":
    unittest.main()
