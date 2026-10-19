"""Pydantic schemas for unified health summary API responses."""

from datetime import datetime
from pydantic import BaseModel

class HealthDevicesSummary(BaseModel):
    total: int
    online: int
    offline: int

class HealthAgentsSummary(BaseModel):
    total: int
    high_cpu: int
    high_temp: int
    offline_agents: int

class HealthIssuesSummary(BaseModel):
    active: int
    by_type: dict[str, int]

class HealthNotificationsSummary(BaseModel):
    unread: int
    fresh_30min: int

class HealthScannerSummary(BaseModel):
    running: bool
    last_run: datetime | None
    stale_hours: float | None

class HealthSummaryResponse(BaseModel):
    api_version: str
    devices: HealthDevicesSummary
    agents: HealthAgentsSummary
    issues: HealthIssuesSummary
    notifications: HealthNotificationsSummary
    scanner: HealthScannerSummary


# --- Health Overview (Historical Telemetry & SLA) Schemas ---

class LatencyStats(BaseModel):
    current_ms: float | None = None
    min_ms: float | None = None
    avg_ms: float | None = None
    max_ms: float | None = None
    jitter_ms: float | None = None
    sparkline: list[float | None] = []
    probe_type: str | None = None  # "icmp" | "tcp" | None


class UptimeStats(BaseModel):
    uptime_pct: float = 100.0
    uptime_24h: float = 100.0
    uptime_7d: float = 100.0
    uptime_30d: float = 100.0
    # Bucketed availability (e.g. 24 or 30 blocks: 100=up, >0=partial, 0=down, null=no data)
    history_bars: list[float | None] = []


class ServiceHealthItem(BaseModel):
    id: int
    name: str
    protocol: str
    port: int
    is_up: bool
    latency_ms: float | None = None
    ssl_expiry_days: int | None = None
    ignore_ssl: bool = False


class AgentHealthAlerts(BaseModel):
    has_agent: bool = False
    agent_version: str | None = None
    is_active: bool = False
    cpu_percent: float | None = None
    ram_percent: float | None = None
    temperature: float | None = None
    patch_available: int = 0
    patch_security: int = 0
    reboot_required: bool = False
    major_upgrade_available: str | None = None


class DeviceHealthItem(BaseModel):
    id: int
    ip: str
    display_name: str
    hostname: str | None = None
    device_type: str = "unknown"
    group_id: int | None = None
    group_name: str | None = None
    is_online: bool
    alert_offline: bool = True
    missed_scans: int = 0
    health_score: int  # 0 to 100
    health_status: str  # "healthy" | "flapping" | "degraded" | "critical" | "offline" | "standby"
    latency: LatencyStats
    uptime: UptimeStats
    services: list[ServiceHealthItem] = []
    agent: AgentHealthAlerts | None = None
    ip_changed_at: datetime | None = None
    status_changed_at: datetime | None = None
    last_seen: datetime | None = None


class HealthIncident(BaseModel):
    id: int
    device_id: int
    device_name: str
    device_ip: str
    status: str  # "offline" | "online" | "service_down" | "service_up" | "flapping" | "info"
    severity: str  # "critical" | "warn" | "info"
    message: str | None = None
    timestamp: datetime


class HealthOverviewKPIs(BaseModel):
    network_health_score: int
    total_devices: int
    online_devices: int
    offline_devices: int
    flapping_devices: int
    avg_latency_ms: float | None = None
    avg_jitter_ms: float | None = None
    active_issues_count: int = 0
    ssl_warning_count: int = 0
    patch_warning_count: int = 0


class HealthOverviewResponse(BaseModel):
    kpis: HealthOverviewKPIs
    devices: list[DeviceHealthItem]
    recent_incidents: list[HealthIncident]
    period: str  # "24h" | "7d" | "30d"


class HealthSamplePoint(BaseModel):
    timestamp: datetime
    is_online: bool
    latency_ms: float | None = None
    probe_type: str | None = None
    ports_up: int = 0
    ports_total: int = 0


class DeviceHealthDetailResponse(BaseModel):
    device: DeviceHealthItem
    time_series: list[HealthSamplePoint]
    incidents: list[HealthIncident]

