import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api/client';
import { HealthView } from './HealthView';
import type { HealthOverviewResponse, DeviceHealthDetailResponse } from '../../types';

vi.mock('../Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('../../api/client', () => ({
  api: {
    getHealthOverview: vi.fn(),
    getDeviceHealthDetail: vi.fn(),
  },
}));

const m = vi.mocked(api);

const mockOverview: HealthOverviewResponse = {
  kpis: {
    network_health_score: 95,
    total_devices: 2,
    online_devices: 2,
    offline_devices: 0,
    flapping_devices: 0,
    avg_latency_ms: 3.4,
    avg_jitter_ms: 0.5,
    active_issues_count: 0,
    ssl_warning_count: 1,
    patch_warning_count: 0,
  },
  devices: [
    {
      id: 1,
      ip: '192.168.1.1',
      display_name: 'Router Gateway',
      hostname: 'gateway.lan',
      device_type: 'router',
      group_id: 1,
      group_name: 'Network',
      is_online: true,
      missed_scans: 0,
      health_score: 100,
      health_status: 'healthy',
      latency: {
        current_ms: 1.2,
        min_ms: 0.9,
        avg_ms: 1.2,
        max_ms: 1.8,
        jitter_ms: 0.2,
        sparkline: [1.1, 1.2, 1.3],
        probe_type: 'icmp',
      },
      uptime: {
        uptime_pct: 100,
        uptime_24h: 100,
        uptime_7d: 100,
        uptime_30d: 100,
        history_bars: [100, 100, 100],
      },
      services: [
        {
          id: 10,
          name: 'HTTP Admin',
          protocol: 'tcp',
          port: 80,
          is_up: true,
          latency_ms: 1.5,
          ssl_expiry_days: null,
        },
      ],
      agent: null,
      ip_changed_at: null,
      status_changed_at: '2026-10-18T10:00:00Z',
      last_seen: '2026-10-18T20:00:00Z',
    },
    {
      id: 2,
      ip: '192.168.1.50',
      display_name: 'Home Server',
      hostname: 'homeserver.lan',
      device_type: 'server',
      group_id: 2,
      group_name: 'Servers',
      is_online: true,
      missed_scans: 0,
      health_score: 85,
      health_status: 'degraded',
      latency: {
        current_ms: 5.6,
        min_ms: 4.0,
        avg_ms: 5.5,
        max_ms: 8.0,
        jitter_ms: 0.8,
        sparkline: [5.0, 5.5, 6.0],
        probe_type: 'icmp',
      },
      uptime: {
        uptime_pct: 98.5,
        uptime_24h: 98.0,
        uptime_7d: 99.0,
        uptime_30d: 98.5,
        history_bars: [100, 95, 100],
      },
      services: [
        {
          id: 20,
          name: 'HTTPS Portal',
          protocol: 'tcp',
          port: 443,
          is_up: true,
          latency_ms: 4.8,
          ssl_expiry_days: 7, // Warning expiring soon
        },
      ],
      agent: {
        has_agent: true,
        agent_version: '1.2.0',
        is_active: true,
        cpu_percent: 25.5,
        ram_percent: 60.0,
        temperature: 42,
        patch_available: 2,
        patch_security: 0,
        reboot_required: false,
        major_upgrade_available: null,
      },
      ip_changed_at: null,
      status_changed_at: '2026-10-18T11:00:00Z',
      last_seen: '2026-10-18T20:00:00Z',
    },
  ],
  recent_incidents: [
    {
      id: 101,
      device_id: 2,
      device_name: 'Home Server',
      device_ip: '192.168.1.50',
      status: 'service_up',
      severity: 'info',
      message: 'Service HTTPS Portal recovered',
      timestamp: '2026-10-18T19:30:00Z',
    },
  ],
  period: '24h',
};

const mockDetail: DeviceHealthDetailResponse = {
  device: mockOverview.devices[1],
  time_series: [
    {
      timestamp: '2026-10-18T19:00:00Z',
      is_online: true,
      latency_ms: 5.2,
      probe_type: 'icmp',
      ports_up: 1,
      ports_total: 1,
    },
    {
      timestamp: '2026-10-18T20:00:00Z',
      is_online: true,
      latency_ms: 5.6,
      probe_type: 'icmp',
      ports_up: 1,
      ports_total: 1,
    },
  ],
  incidents: mockOverview.recent_incidents,
};

describe('HealthView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.getHealthOverview.mockResolvedValue(mockOverview);
    m.getDeviceHealthDetail.mockResolvedValue(mockDetail);
  });

  it('renders network KPI metrics and devices table', async () => {
    render(<HealthView />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Router Gateway')).toBeInTheDocument();
    expect(within(table).getByText('Home Server')).toBeInTheDocument();

    // Score KPI
    expect(screen.getByText('95')).toBeInTheDocument();

    // Device IPs
    expect(within(table).getByText('192.168.1.1')).toBeInTheDocument();
    expect(within(table).getByText('192.168.1.50')).toBeInTheDocument();

    // Incident in timeline
    expect(screen.getByText('Service HTTPS Portal recovered')).toBeInTheDocument();
  });

  it('filters devices by search query', async () => {
    const user = userEvent.setup();
    render(<HealthView />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Router Gateway')).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'gateway');

    expect(within(table).getByText('Router Gateway')).toBeInTheDocument();
    expect(within(table).queryByText('Home Server')).not.toBeInTheDocument();
  });

  it('filters devices by status', async () => {
    const user = userEvent.setup();
    render(<HealthView />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Home Server')).toBeInTheDocument();

    // Click degraded filter
    const degradedBtn = screen.getByRole('button', { name: /degraded/i });
    await user.click(degradedBtn);

    expect(within(table).getByText('Home Server')).toBeInTheDocument();
    expect(within(table).queryByText('Router Gateway')).not.toBeInTheDocument();
  });

  it('switches period to 7d and calls api with 7d', async () => {
    const user = userEvent.setup();
    render(<HealthView />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Router Gateway')).toBeInTheDocument();

    const btn7d = screen.getByRole('button', { name: /7 days|7 Tage/i });
    await user.click(btn7d);

    await waitFor(() => {
      expect(m.getHealthOverview).toHaveBeenCalledWith('7d');
    });
  });

  it('opens detail drawer when clicking a device row', async () => {
    const user = userEvent.setup();
    render(<HealthView />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Home Server')).toBeInTheDocument();

    await user.click(within(table).getByText('Home Server'));

    await waitFor(() => {
      expect(m.getDeviceHealthDetail).toHaveBeenCalledWith(2, '24h');
      // Probed services in drawer
      expect(screen.getByText('HTTPS Portal')).toBeInTheDocument();
    });
  });

  it('toggles sort direction and changes sort option', async () => {
    const user = userEvent.setup();
    render(<HealthView />);

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // Header is row 0; device rows are 1 and 2
    expect(within(rows[1]).getByText('Home Server')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Router Gateway')).toBeInTheDocument();

    // Toggle sort order (from asc to desc)
    const toggleBtn = screen.getByLabelText('Sort ascending');
    await user.click(toggleBtn);

    // After flipping to desc, Router Gateway (score 100) comes before Home Server (score 85)
    const flippedRows = within(table).getAllByRole('row');
    expect(within(flippedRows[1]).getByText('Router Gateway')).toBeInTheDocument();
    expect(within(flippedRows[2]).getByText('Home Server')).toBeInTheDocument();

    // Open sort menu
    const sortBtn = screen.getByRole('button', { name: /By Score|Nach Score/i });
    await user.click(sortBtn);

    const nameOption = await screen.findByRole('option', { name: /By Name|Nach Name/i });
    await user.click(nameOption);

    // In descending name order: Router Gateway > Home Server
    const nameRows = within(table).getAllByRole('row');
    expect(within(nameRows[1]).getByText('Router Gateway')).toBeInTheDocument();
    expect(within(nameRows[2]).getByText('Home Server')).toBeInTheDocument();
  });
});
