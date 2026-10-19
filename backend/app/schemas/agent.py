"""Pydantic schemas for agent-related API requests and responses."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Agent Report (incoming from agent)
# ---------------------------------------------------------------------------

class AgentRamReport(BaseModel):
    """RAM metrics as reported by the agent."""

    total_mb: int
    used_mb: int
    percent: float


class AgentDiskReport(BaseModel):
    """Single disk mount metrics as reported by the agent."""

    path: str
    total_gb: float
    used_gb: float
    percent: float


class AgentPatchesReport(BaseModel):
    """Package patches info as reported by the agent."""

    patch_available: int
    patch_security: int
    patch_manager: str | None = None
    reboot_required: bool
    major_upgrade_available: str | None = None


class AgentArpNeighbor(BaseModel):
    """Layer-2 ARP neighbor entry reported by an agent probe."""

    ip: str
    mac: str
    interface: str | None = None


class AgentReportPayload(BaseModel):
    """Full metrics payload received from an agent.

    This is the JSON body the agent POSTs to /api/agent/report.
    """

    device_id: int | None = None
    agent_version: str
    timestamp: float
    cpu_percent: float = Field(ge=0.0, le=100.0)
    ram: AgentRamReport
    disk: list[AgentDiskReport] = []
    temperature: float | None = None
    network: dict[str, dict[str, int]] = {}
    system: dict[str, str] = {}
    patches: AgentPatchesReport | None = None
    arp_table: list[AgentArpNeighbor] = []



# ---------------------------------------------------------------------------
# API Responses
# ---------------------------------------------------------------------------

class AgentReportResponse(BaseModel):
    """Response sent back to the agent after a successful report.

    Contains an optional config block to push settings updates.
    Also includes the current device_id to help agents re-sync after a server reset.
    """

    status: str = "ok"
    config: dict | None = None
    config_version: int = 0
    device_id: int | None = None


class AgentStatusResponse(BaseModel):
    """Status of an agent deployment for a specific device."""

    device_id: int
    is_installed: bool = False
    is_active: bool = False
    is_healthy: bool = False
    agent_version: str | None = None
    latest_version: str | None = None
    last_seen: datetime | None = None
    latest_metrics: dict | None = None
    message: str | None = None


class MetricsSnapshot(BaseModel):
    """Single point-in-time metrics snapshot for API responses."""

    cpu_percent: float
    ram: AgentRamReport
    disk: list[AgentDiskReport] = []
    temperature: float | None = None
    network: dict[str, dict[str, int]] = {}
    timestamp: datetime

    model_config = {"from_attributes": True}


class MetricsHistoryResponse(BaseModel):
    """Collection of recent metrics snapshots for chart rendering."""

    device_id: int
    snapshots: list[MetricsSnapshot] = []
    retention_days: int | None = None
    available_ranges: list[str] | None = None


# ---------------------------------------------------------------------------
# SSH Deployment & Patching
# ---------------------------------------------------------------------------

class AgentDeployRequest(BaseModel):
    """SSH credentials for one-time agent deployment or package updates.

    These credentials are used once and then immediately discarded.
    Can be manual (password/key) or reference a stored key (key_id) or profile (profile_id).
    """

    ssh_user: str = Field(..., min_length=1, max_length=50)
    ssh_password: str | None = Field(None, min_length=1)
    ssh_key: str | None = None
    ssh_port: int = Field(22, ge=1, le=65535)
    key_id: int | None = None
    key_passphrase: str | None = None
    profile_id: int | None = None


class AgentInstallRequest(AgentDeployRequest):
    """Agent deploy/uninstall: typed-in credentials as above, or a saved SSH connection.

    With ``profile_id`` (a saved key connection of the device, browser sessions
    only) host, user, port and key come from that connection. ``sudo_password``
    is only needed for a non-root user whose sudo asks for a password; like
    every credential here it is used for this request only and never stored.
    The endpoint checks that one of ``ssh_user`` / ``profile_id`` / ``key_id`` is given, so a
    422 response never echoes the secrets of the request.
    """

    ssh_user: str | None = Field(None, min_length=1, max_length=50)
    profile_id: int | None = None
    sudo_password: str | None = None


class AgentDeployResponse(BaseModel):
    """Result of an agent deployment attempt."""

    status: str  # "success", "failed"
    message: str
    agent_version: str | None = None


class AgentEnrollmentResponse(BaseModel):
    """Single-use code that authorises the manual install script for one device."""

    code: str
    expires_in: int  # seconds


class PackageUpdateInfo(BaseModel):
    """Detailed info for an upgradeable package."""
    package: str
    current_version: str
    new_version: str
    repo: str | None = None


class DevicePatchesResponse(BaseModel):
    """Detailed list of available patches on a device."""
    device_id: int
    patch_manager: str | None
    packages: list[PackageUpdateInfo] = []
    major_upgrade_available: str | None = None


class PatchActionRequest(BaseModel):
    """Credentials and parameters for applying patches."""
    ssh_user: str = Field(..., min_length=1, max_length=50)
    ssh_password: str | None = Field(None, min_length=1)
    ssh_key: str | None = None
    ssh_port: int = Field(22, ge=1, le=65535)
    mode: str = Field("upgrade")  # "upgrade" or "security-only"
    key_id: int | None = None
    key_passphrase: str | None = None
    profile_id: int | None = None


# ---------------------------------------------------------------------------
# Agent Configuration (editable from UI)
# ---------------------------------------------------------------------------

class AgentConfigUpdate(BaseModel):
    """Schema for updating agent configuration from the Device Manager."""

    interval: int | None = Field(None, ge=5, le=300)
    disk_paths: list[str] | None = None
    enable_temp: bool | None = None
    enable_patch_check: bool | None = None
    enable_scanner_relay: bool | None = None


class AgentConfigResponse(BaseModel):
    """Current agent configuration for a device."""

    device_id: int
    interval: int = 30
    disk_paths: list[str] = ["/"]
    enable_temp: bool = True
    enable_patch_check: bool = True
    enable_scanner_relay: bool = False


# ---------------------------------------------------------------------------
# Agents Overview (for Agents Tab)
# ---------------------------------------------------------------------------

class AgentSummary(BaseModel):
    """Detailed summary for the Agents Tab list."""
    device_id: int
    hostname: str
    ip: str
    is_online: bool
    agent_version: str | None = None
    os_pretty: str | None = None
    os_name: str | None = None
    os_version: str | None = None
    os_codename: str | None = None
    os_arch: str | None = None
    os_kernel: str | None = None
    last_seen: datetime | None = None
    cpu_usage: float = 0.0
    ram_usage: float = 0.0
    temp: float | None = None
    uptime_pct: float = 100.0
    uptime_history: list[float] = []
    metrics_count: int = 0
    has_pending_token: bool = False
    pending_at: datetime | None = None
    patch_available: int = 0
    patch_security: int = 0
    patch_manager: str | None = None
    reboot_required: bool = False
    major_upgrade_available: str | None = None

class AgentsOverviewResponse(BaseModel):
    """Aggregation of all agents and global stats."""
    agents: list[AgentSummary]
    total_agents: int
    active_agents: int
    total_data_points: int
    avg_cpu: float
    avg_ram: float

# ---------------------------------------------------------------------------
# Global Metrics History
# ---------------------------------------------------------------------------

class GlobalMetricPoint(BaseModel):
    """Network-wide average for a specific point in time."""
    timestamp: datetime
    avg_cpu: float
    avg_ram: float
    data_points: int

class GlobalMetricsResponse(BaseModel):
    """History of global performance across the last 24 hours."""
    history: list[GlobalMetricPoint]
