/** Core TypeScript interfaces matching the backend Pydantic schemas. */

export interface Service {
  id: number;
  name: string;
  protocol: string;
  port: number;
  url_template: string;
  color: string | null;
  is_auto_detected: boolean;
  sort_order: number;
  is_up: boolean;
  last_checked: string | null;
}

export interface Device {
  id: number;
  ip: string;
  mac: string | null;
  hostname: string | null;
  display_name: string;
  device_type: string;
  device_subtype: string;
  vendor?: string;
  group_id: number | null;
  icon: string | null;
  sort_order: number;
  is_pinned: boolean;
  is_hidden: boolean;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  notes: string | null;
  first_seen: string;
  last_seen: string;
  is_online: boolean;
  status_changed_at: string;
  is_reserved: boolean;
  virtual_type: 'docker' | 'lxc' | 'vm' | null;
  has_agent: boolean;
  has_pending_token?: boolean;
  agent_info?: {
    agent_version: string | null;
    latest_version: string | null;
    metrics?: {
      cpu_usage: number;
      memory_usage: number;
      disk_usage: number;
    };
  };
  services: Service[];
  old_ip: string | null;
  ip_changed_at: string | null;
  parent_id: number | null;
  parent_name?: string | null;
  rack_id: number | null;
  rack_unit: number | null;
  rack_height: number;
  topology_x: number | null;
  topology_y: number | null;
  max_ports?: number | null;
  topology_config?: string | null;
  is_wlan: boolean;
  is_ap: boolean;
  is_host: boolean;
}

export interface DeviceGroup {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  is_default: boolean;
  device_count: number;
}

export interface SubnetInfo {
  interface_name: string;
  ip_address: string;
  subnet: string;
  netmask: string;
  is_up: boolean;
}

export interface Subnet {
  id: number;
  cidr: string;
  name: string;
  dns_server: string | null;
  is_enabled: boolean;
}

export interface ScanProgress {
  status: 'idle' | 'running' | 'discovering' | 'identifying' | 'devices_updated' | 'completed' | 'failed' | 'cancelled';
  current_subnet: string;
  hosts_scanned: number;
  hosts_total: number;
  devices_found: number;
  message: string;
  timestamp: string;
}

export interface DeviceHistoryResponse {
  id: number;
  device_id: number;
  service_id: number | null;
  status: string;
  message: string | null;
  timestamp: string;
}

export interface ScanRequest {
  subnets: string[];
  ports?: number[];
  mode?: 'gentle' | 'fast';
}

export interface SetupStatus {
  is_setup_complete: boolean;
  device_count: number;
}

export interface DiscoveredHost {
  id: number;
  ip: string;
  mac: string | null;
  hostname: string | null;
  custom_name: string | null;
  vendor: string | null;
  is_online: boolean;
  is_monitored: boolean;
  is_reserved: boolean;
  ports?: number[];
  first_seen: string;
  last_seen: string;
}
export interface AgentSnapshot {
  id: number;
  device_id: number;
  cpu_percent: number;
  ram_used_mb: number;
  ram_total_mb: number;
  ram_percent: number;
  disk_json: string | null;
  temperature: number | null;
  net_json: string | null;
  timestamp: string;
}

export interface AgentSummary {
  device_id: number;
  hostname: string;
  ip: string;
  is_online: boolean;
  has_pending_token?: boolean;
  agent_version: string | null;
  last_seen: string | null;
  cpu_usage: number;
  ram_usage: number;
  temp: number | null;
  uptime_pct: number;
  uptime_history: number[];
  metrics_count: number;
  patch_available: number;
  patch_security: number;
  patch_manager: string | null;
  reboot_required: boolean;
  major_upgrade_available: string | null;
}

export interface GlobalMetricPoint {
  timestamp: string;
  avg_cpu: number;
  avg_ram: number;
  data_points: number;
}

export interface Rack {
  id: number;
  name: string;
  units: number;
  width: number;
  notes: string | null;
}

export interface TopologyLink {
  id: number;
  source_id: number;
  target_id: number;
  source_handle: string | null;
  target_handle: string | null;
  link_type: string;
}

export interface ApiTokenResponse {
  id: number;
  name: string;
  prefix: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiTokenCreated extends ApiTokenResponse {
  token: string;
}

// --- SSH terminal ---

export type SshAuthMethod = 'key' | 'password' | 'ask';

export interface SshKey {
  id: number;
  name: string;
  key_type: string;
  fingerprint: string;
  public_key: string;
  has_passphrase: boolean;
  created_at: string | null;
  last_used_at: string | null;
}

export interface SshProfile {
  id: number;
  name: string;
  device_id: number | null;
  device_name: string | null;
  host: string | null;
  target_host: string | null;
  port: number;
  username: string;
  auth_method: SshAuthMethod;
  key_id: number | null;
  key_name: string | null;
  has_password: boolean;
  created_at: string | null;
  last_connected_at: string | null;
}

export interface SshProfileInput {
  name?: string;
  device_id?: number | null;
  host?: string | null;
  port?: number;
  username?: string;
  auth_method?: SshAuthMethod;
  key_id?: number | null;
  password?: string;
}

export interface SshKnownHost {
  id: number;
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  first_seen: string | null;
  last_seen: string | null;
}

export interface SshStatus {
  vault_key_source: 'env' | 'file';
  active_sessions: number;
  max_sessions: number;
  idle_timeout_minutes: number;
}

/** What to connect to: a saved profile (plus a password for 'ask' profiles) or an ad-hoc target. */
/** A recent ad-hoc connection (no password stored). */
export interface SshHistoryEntry {
  id: number;
  label: string;
  device_id: number | null;
  device_name: string | null;
  host: string | null;
  target_host: string | null;
  port: number;
  username: string;
  auth_method: 'key' | 'password';
  key_id: number | null;
  key_name: string | null;
  last_used_at: string | null;
}

/** SSH login for agent deploy/uninstall: typed-in credentials, or a saved key connection of the device. */
export type AgentSshLogin =
  | { ssh_user: string; ssh_password?: string; ssh_key?: string; ssh_port?: number }
  | { profile_id: number; sudo_password?: string };

export interface SshSessionRequest {
  profile_id?: number;
  device_id?: number;
  host?: string;
  port?: number;
  username?: string;
  key_id?: number;
  password?: string;
}
