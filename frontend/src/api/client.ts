/** API client for HomeLan backend. */

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let token = localStorage.getItem('gravitylan_token');
  if (token === 'undefined') token = null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) || {}),
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    credentials: 'include',
    headers,
    ...options,
  });

  if (response.status === 401) {
    // Redirect to login if unauthorized and not already on auth/setup pages
    if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/setup')) {
      window.location.href = '/login';
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(formatErrorDetail(error.detail) || `API Error: ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json();
}

/** FastAPI sends `detail` as a string, or as a list of `{ msg }` objects for validation errors (422). */
function formatErrorDetail(detail: unknown): string {
  if (Array.isArray(detail)) return detail.map((item) => item?.msg ?? String(item)).join('; ');
  return typeof detail === 'string' ? detail : '';
}

export const api = {
  // Setup
  getSetupStatus: () => request<{ is_setup_complete: boolean; device_count: number; version?: string }>('/api/setup/status'),
  // Signs the admin in via session cookie when a password is set
  completeSetup: (data?: { dns_server?: string; admin_password?: string; subnets?: string[] }) =>
    request<{ status: string; devices_adopted: number }>('/api/setup/complete', { method: 'POST', body: JSON.stringify(data || {}) })
      .then((res) => {
        // Same as a password login: the session cookie replaces any token left by older versions
        localStorage.removeItem('gravitylan_token');
        return res;
      }),

  // Scanner
  getSubnets: () => request<import('../types').SubnetInfo[]>('/api/scanner/subnets'),
  startScan: (data: Partial<import('../types').ScanRequest> & { dns_server?: string }) =>
    request<{ status: string }>('/api/scanner/start', { method: 'POST', body: JSON.stringify(data) }),
  startDashboardScan: (data: { subnets: string[] }) => 
    request<{ status: string }>('/api/scanner/start-dashboard', { method: 'POST', body: JSON.stringify(data) }),
  stopScan: () => request<{ status: string }>('/api/scanner/stop', { method: 'POST' }),
  getScanStatus: () => request<import('../types').ScanProgress>('/api/scanner/status'),
  getDiscoveredHosts: () => request<import('../types').DiscoveredHost[]>('/api/scanner/discovered'),
  scanIp: (ip: string) => request<import('../types').DiscoveredHost>(`/api/scanner/scan-ip?ip=${ip}`),
  liveDiscovery: (data: { subnets: string[] }) =>
    request<import('../types').DiscoveredHost[]>(`/api/scanner/live-discovery?subnets=${data.subnets.join(',')}`),
  patchDiscoveredHost: (id: number, data: { custom_name?: string; is_monitored?: boolean; is_reserved?: boolean }) =>
    request<import('../types').DiscoveredHost>(`/api/scanner/discovered/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDiscoveredHost: (id: number) =>
    request<{ status: string; message: string }>(`/api/scanner/discovered/${id}`, { method: 'DELETE' }),
  quickSubnetScan: (subnets: string) =>
    request<{ status: string; hosts_found: number }>(`/api/scanner/quick-subnet-scan?subnets=${subnets}`, { method: 'POST' }),

  // Devices
  getDevices: () => request<import('../types').Device[]>('/api/devices'),
  getDevice: (id: number) => request<import('../types').Device>(`/api/devices/${id}`),
  addDeviceFromIp: (ip: string) => request<import('../types').Device>(`/api/devices/add-from-ip?ip=${ip}`, { method: 'POST' }),
  updateDevice: (id: number, data: Partial<import('../types').Device>) =>
    request<import('../types').Device>(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDevice: (id: number) => request<void>(`/api/devices/${id}`, { method: 'DELETE' }),
  bulkDeleteDevices: (ids: number[]) => request<void>('/api/devices/bulk-delete', { method: 'POST', body: JSON.stringify(ids) }),
  refreshDeviceInfo: (id: number) => request<import('../types').Device>(`/api/devices/${id}/refresh-info`, { method: 'POST' }),
  refreshServices: (id: number) => request<import('../types').Device>(`/api/devices/${id}/refresh-services`, { method: 'POST' }),
  refreshAllDevices: () => request<{status: string, updated_count: number}>('/api/devices/refresh-all', { method: 'POST' }),
  getDeviceHistory: (id: number) => request<import('../types').DeviceHistoryResponse[]>(`/api/devices/${id}/history`),

  // Interfaces (further addresses of one device) and subnet gateways
  getDeviceInterfaces: (deviceId: number) =>
    request<import('../types').DeviceInterface[]>(`/api/devices/${deviceId}/interfaces`),
  addDeviceInterface: (deviceId: number, data: { ip: string; label?: string | null; vlan_id?: number | null }) =>
    request<import('../types').DeviceInterface>(`/api/devices/${deviceId}/interfaces`, { method: 'POST', body: JSON.stringify(data) }),
  mergeIntoDevice: (deviceId: number, data: { source_device_id: number } | { ip: string }) =>
    request<import('../types').DeviceInterface>(`/api/devices/${deviceId}/interfaces/merge`, { method: 'POST', body: JSON.stringify(data) }),
  updateDeviceInterface: (deviceId: number, interfaceId: number, data: { label?: string | null; vlan_id?: number | null }) =>
    request<import('../types').DeviceInterface>(`/api/devices/${deviceId}/interfaces/${interfaceId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeDeviceInterface: (deviceId: number, interfaceId: number) =>
    request<void>(`/api/devices/${deviceId}/interfaces/${interfaceId}`, { method: 'DELETE' }),
  getMergeSuggestions: () => request<import('../types').MergeSuggestion[]>('/api/interfaces/suggestions'),
  dismissMergeSuggestion: (data: { target_id: number; kind: 'device' | 'discovered'; candidate_ip: string }) =>
    request<void>('/api/interfaces/suggestions/dismiss', { method: 'POST', body: JSON.stringify(data) }),
  getGateways: () => request<import('../types').GatewayEntry[]>('/api/network/gateways'),

  // Services
  addService: (deviceId: number, data: Partial<import('../types').Service>) => request<import('../types').Service>(`/api/devices/${deviceId}/services`, { method: 'POST', body: JSON.stringify(data) }),
  updateService: (serviceId: number, data: Partial<import('../types').Service>) => request<import('../types').Service>(`/api/services/${serviceId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteService: (serviceId: number) => request<void>(`/api/services/${serviceId}`, { method: 'DELETE' }),

  // Groups
  getGroups: () => request<import('../types').DeviceGroup[]>('/api/groups'),
  createGroup: (data: Partial<import('../types').DeviceGroup>) =>
    request<import('../types').DeviceGroup>('/api/groups', { method: 'POST', body: JSON.stringify(data) }),
  updateGroup: (id: number, data: Partial<import('../types').DeviceGroup>) =>
    request<import('../types').DeviceGroup>(`/api/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteGroup: (id: number) => request<void>(`/api/groups/${id}`, { method: 'DELETE' }),
  
  // Settings
  getSettings: () => request<Record<string, string>>('/api/settings'),
  getThemeSettings: () => request<Record<string, string>>('/api/settings').then(s => {
    // Filter only theme-related settings to keep it clean
    const theme: Record<string, string> = {};
    for (const k in s) {
      if (k.startsWith('theme.')) theme[k] = s[k];
    }
    return theme;
  }),
  updateSettings: (settings: Record<string, string>) => 
    request<{ status: string }>('/api/settings', { method: 'POST', body: JSON.stringify(settings) }),
  resetDatabase: () => request<{status: string, message: string}>('/api/settings/reset-db', { method: 'POST' }),
  
  // Backup
  exportBackup: () => fetch('/api/backup/export').then(res => res.json()),
  importBackup: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return fetch('/api/backup/import', { method: 'POST', body: formData }).then(res => res.json());
  },

  // Agent
  deployAgent: (deviceId: number, data: import('../types').AgentSshLogin) =>
    request<{ status: string; message: string; agent_version?: string }>(`/api/agent/deploy/${deviceId}`, { method: 'POST', body: JSON.stringify(data) }),
  uninstallAgent: (deviceId: number, data: import('../types').AgentSshLogin) =>
    request<{ status: string; message: string }>(`/api/agent/uninstall/${deviceId}`, { method: 'POST', body: JSON.stringify(data) }),
  createAgentEnrollment: (deviceId: number) =>
    request<{ code: string; expires_in: number }>(`/api/agent/enroll/${deviceId}`, { method: 'POST' }),
  getAgentStatus: (deviceId: number) =>
    request<{ device_id: number; is_installed: boolean; is_active: boolean; agent_version?: string; last_seen?: string }>(`/api/agent/status/${deviceId}`),
  getAgentMetrics: (deviceId: number, limit?: number, range?: string) => {
    const query = [];
    if (limit !== undefined) query.push(`limit=${limit}`);
    if (range !== undefined) query.push(`range=${range}`);
    const qs = query.length > 0 ? `?${query.join('&')}` : '';
    return request<{ 
      device_id: number; 
      snapshots: import('../types').AgentSnapshot[];
      retention_days?: number;
      available_ranges?: string[];
    }>(`/api/agent/metrics/${deviceId}${qs}`);
  },

  getAgentConfig: (deviceId: number) =>
    request<{ interval: number; disk_paths: string[]; enable_temp: boolean; enable_patch_check: boolean; enable_scanner_relay: boolean }>(`/api/agent/config/${deviceId}`),
  updateAgentConfig: (deviceId: number, data: { interval?: number; disk_paths?: string[]; enable_temp?: boolean; enable_patch_check?: boolean; enable_scanner_relay?: boolean }) =>
    request<{ interval: number; disk_paths: string[]; enable_temp: boolean; enable_patch_check: boolean; enable_scanner_relay: boolean }>(`/api/agent/config/${deviceId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adoptAgent: (deviceId: number) => 
    request<{ status: string }>(`/api/agent/adopt/${deviceId}`, { method: 'POST' }),
  queryAgentPatches: (deviceId: number, data: { ssh_user: string; ssh_password?: string; ssh_key?: string; ssh_port?: number; key_id?: number | null; key_passphrase?: string; profile_id?: number | null }) =>
    request<{
      device_id: number;
      patch_manager: string | null;
      packages: { package: string; current_version: string; new_version: string; repo?: string }[];
      major_upgrade_available: string | null;
    }>(`/api/agent/patches/${deviceId}/query`, { method: 'POST', body: JSON.stringify(data) }),
  prepareAgentPatch: (deviceId: number, data: { ssh_user: string; ssh_password?: string; ssh_key?: string; ssh_port?: number; mode: string; key_id?: number | null; key_passphrase?: string; profile_id?: number | null }) =>
    request<{ patch_token: string }>(`/api/agent/patches/${deviceId}/prepare`, { method: 'POST', body: JSON.stringify(data) }),
  getAgentsOverview: () => 
    request<{
      agents: import('../types').AgentSummary[];
      total_agents: number;
      active_agents: number;
      total_data_points: number;
      avg_cpu: number;
      avg_ram: number;
    }>('/api/agent/overview'),
  getGlobalMetrics: () => 
    request<{ history: import('../types').GlobalMetricPoint[] }>('/api/agent/global-metrics'),

  // Network (Subnets)
  getSubnetsList: () => request<import('../types').Subnet[]>('/api/network/subnets'),
  createSubnet: (data: Partial<import('../types').Subnet>) => request<import('../types').Subnet>('/api/network/subnets', { method: 'POST', body: JSON.stringify(data) }),
  updateSubnet: (id: number, data: Partial<import('../types').Subnet>) => request<import('../types').Subnet>(`/api/network/subnets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSubnet: (id: number) => request<void>(`/api/network/subnets/${id}`, { method: 'DELETE' }),

  // Topology
  getRacks: () => request<import('../types').Rack[]>('/api/topology/racks'),
  createRack: (data: Partial<import('../types').Rack>) => request<import('../types').Rack>('/api/topology/racks', { method: 'POST', body: JSON.stringify(data) }),
  deleteRack: (id: number) => request<void>(`/api/topology/racks/${id}`, { method: 'DELETE' }),
  getTopologyLinks: () => request<import('../types').TopologyLink[]>('/api/topology/links'),
  getTopologyMap: async () => {
    const [devices, links] = await Promise.all([
      request<import('../types').Device[]>('/api/devices?include_hidden=false'),
      request<import('../types').TopologyLink[]>('/api/topology/links'),
    ]);
    return { devices, links };
  },
  createTopologyLink: (data: Partial<import('../types').TopologyLink>) => request<import('../types').TopologyLink>('/api/topology/links', { method: 'POST', body: JSON.stringify(data) }),
  updateTopologyLink: (id: number, data: Partial<import('../types').TopologyLink>) => request<import('../types').TopologyLink>(`/api/topology/links/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTopologyLink: (id: number) => request<void>(`/api/topology/links/${id}`, { method: 'DELETE' }),

  // API Tokens
  getApiTokens: () => request<import('../types').ApiTokenResponse[]>('/api/auth/tokens'),
  createApiToken: (name: string) => request<import('../types').ApiTokenCreated>('/api/auth/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteApiToken: (id: number) => request<{ status: string; message: string }>(`/api/auth/tokens/${id}`, { method: 'DELETE' }),

  // SSH terminal
  getSshStatus: () => request<import('../types').SshStatus>('/api/ssh/status'),
  getSshKeys: () => request<import('../types').SshKey[]>('/api/ssh/keys'),
  createSshKey: (data: { name: string; private_key: string; passphrase?: string }) =>
    request<import('../types').SshKey>('/api/ssh/keys', { method: 'POST', body: JSON.stringify(data) }),
  generateSshKey: (name: string) =>
    request<import('../types').SshKey>('/api/ssh/keys/generate', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteSshKey: (id: number) => request<{ status: string }>(`/api/ssh/keys/${id}`, { method: 'DELETE' }),
  getSshProfiles: () => request<import('../types').SshProfile[]>('/api/ssh/profiles'),
  createSshProfile: (data: import('../types').SshProfileInput) =>
    request<import('../types').SshProfile>('/api/ssh/profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateSshProfile: (id: number, data: import('../types').SshProfileInput) =>
    request<import('../types').SshProfile>(`/api/ssh/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSshProfile: (id: number) => request<{ status: string }>(`/api/ssh/profiles/${id}`, { method: 'DELETE' }),
  getSshHistory: () => request<import('../types').SshHistoryEntry[]>('/api/ssh/history'),
  deleteSshHistory: (id: number) => request<{ status: string }>(`/api/ssh/history/${id}`, { method: 'DELETE' }),
  getSshKnownHosts: () => request<import('../types').SshKnownHost[]>('/api/ssh/known-hosts'),
  deleteSshKnownHost: (id: number) => request<{ status: string }>(`/api/ssh/known-hosts/${id}`, { method: 'DELETE' }),
  prepareSshSession: (data: import('../types').SshSessionRequest) =>
    request<{ ticket: string; label: string; expires_in: number }>('/api/ssh/sessions/prepare', { method: 'POST', body: JSON.stringify(data) }),

  // Auth
  login: (password: string) =>
    request<{ status: string; token?: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
      .then(res => {
        if (res.token) {
          localStorage.setItem('gravitylan_token', res.token);
        } else {
          // Password logins use the session cookie; a token left by older versions would keep the
          // browser "logged in" after the cookie expires, and the SSH terminal accepts the cookie only
          localStorage.removeItem('gravitylan_token');
        }
        return res;
      }),
  logout: () => 
    request<{ status: string }>('/api/auth/logout', { method: 'POST' }).then(() => {
      localStorage.removeItem('gravitylan_token');
      window.location.href = '/login';
    }),
  checkAuth: () => request<{ status: string }>('/api/auth/check', { method: 'POST' }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ status: string; other_sessions_ended: number }>('/api/auth/password', {
      method: 'POST', body: JSON.stringify({ current_password, new_password }),
    }),

  // Health Dashboard & Telemetry
  getHealthOverview: (period: '24h' | '7d' | '30d' = '24h') =>
    request<import('../types').HealthOverviewResponse>(`/api/health/overview?period=${period}`),
  getDeviceHealthDetail: (deviceId: number, period: '24h' | '7d' | '30d' = '24h') =>
    request<import('../types').DeviceHealthDetailResponse>(`/api/health/device/${deviceId}?period=${period}`),
};

/** Create a WebSocket connection for scan progress updates. */
export function createScanSocket(onMessage: (data: import('../types').ScanProgress) => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let token = localStorage.getItem('gravitylan_token');
  if (token === 'undefined') token = null;
  token = token || '';
  const wsBase = `${protocol}//${window.location.host}`;
  const ws = new WebSocket(`${wsBase}/api/scanner/ws?token=${token}`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch {
      console.warn('Invalid WebSocket message:', event.data);
    }
  };

  ws.onerror = (error) => console.error('WebSocket error:', error);

  return ws;
}

/** Create a WebSocket connection for live agent metrics. */
export function createMetricsSocket(deviceId: number, onMessage: (data: any) => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let token = localStorage.getItem('gravitylan_token');
  if (token === 'undefined') token = null;
  token = token || '';
  const wsBase = `${protocol}//${window.location.host}`;
  const ws = new WebSocket(`${wsBase}/api/agent/ws/${deviceId}?token=${token}`);

  ws.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data));
    } catch {
      console.warn('Invalid metrics WebSocket message:', event.data);
    }
  };

  ws.onerror = (error) => console.error('Metrics WebSocket error:', error);
  return ws;
}

/**
 * Open the SSH terminal WebSocket for a ticket from api.prepareSshSession.
 * Auth is the session cookie; terminal data is binary, control messages are JSON text.
 */
export function createSshTerminalSocket(ticket: string, cols: number, rows: number): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ ticket, cols: String(cols), rows: String(rows) });
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/ssh/terminal?${params}`);
  ws.binaryType = 'arraybuffer';
  return ws;
}
