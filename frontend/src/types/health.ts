/** TypeScript interfaces for Health Overview and Device Telemetry. */

export interface LatencyStats {
  current_ms: number | null;
  min_ms: number | null;
  avg_ms: number | null;
  max_ms: number | null;
  jitter_ms: number | null;
  sparkline: (number | null)[];
  probe_type: 'icmp' | 'tcp' | null;
}

export interface UptimeStats {
  uptime_pct: number;
  uptime_24h: number;
  uptime_7d: number;
  uptime_30d: number;
  history_bars: (number | null)[];
}

export interface ServiceHealthItem {
  id: number;
  name: string;
  protocol: string;
  port: number;
  is_up: boolean;
  latency_ms: number | null;
  ssl_expiry_days: number | null;
  ignore_ssl?: boolean;
}

export interface AgentHealthAlerts {
  has_agent: boolean;
  agent_version: string | null;
  is_active: boolean;
  cpu_percent: number | null;
  ram_percent: number | null;
  temperature: number | null;
  patch_available: number;
  patch_security: number;
  reboot_required: boolean;
  major_upgrade_available: string | null;
}

export interface DeviceHealthItem {
  id: number;
  ip: string;
  display_name: string;
  hostname: string | null;
  device_type: string;
  group_id: number | null;
  group_name: string | null;
  is_online: boolean;
  alert_offline?: boolean;
  missed_scans: number;
  health_score: number;
  health_status: 'healthy' | 'flapping' | 'degraded' | 'critical' | 'offline' | 'standby';
  latency: LatencyStats;
  uptime: UptimeStats;
  services: ServiceHealthItem[];
  agent: AgentHealthAlerts | null;
  ip_changed_at: string | null;
  status_changed_at: string | null;
  last_seen: string | null;
}

export interface HealthIncident {
  id: number;
  device_id: number;
  device_name: string;
  device_ip: string;
  status: 'offline' | 'online' | 'service_down' | 'service_up' | 'flapping' | 'info';
  severity: 'critical' | 'warn' | 'info';
  message: string | null;
  timestamp: string;
}

export interface HealthOverviewKPIs {
  network_health_score: number;
  total_devices: number;
  online_devices: number;
  offline_devices: number;
  flapping_devices: number;
  avg_latency_ms: number | null;
  avg_jitter_ms: number | null;
  active_issues_count: number;
  ssl_warning_count: number;
  patch_warning_count: number;
}

export interface HealthOverviewResponse {
  kpis: HealthOverviewKPIs;
  devices: DeviceHealthItem[];
  recent_incidents: HealthIncident[];
  period: '24h' | '7d' | '30d';
}

export interface HealthSamplePoint {
  timestamp: string;
  is_online: boolean;
  latency_ms: number | null;
  probe_type: string | null;
  ports_up: number;
  ports_total: number;
}

export interface DeviceHealthDetailResponse {
  device: DeviceHealthItem;
  time_series: HealthSamplePoint[];
  incidents: HealthIncident[];
}
