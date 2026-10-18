import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, DiscoveredHost, Subnet } from '../../types';
import { api } from '../../api/client';
import { SubnetView } from './SubnetView';

const showToast = vi.fn();
const network = {
  discoveredHosts: [] as DiscoveredHost[],
  setDiscoveredHosts: vi.fn(),
  isDiscovering: false,
  runDiscovery: vi.fn(),
  updateDiscoveredHost: vi.fn(),
};

vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../context/NetworkContext', () => ({ useNetwork: () => network }));
vi.mock('../Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('../Dashboard/DeviceEditor', () => ({
  DeviceEditor: ({ device }: { device: Device }) => <div role="dialog" aria-label="device editor">{device.display_name}</div>,
}));
vi.mock('./IPTile', () => ({
  IPTile: (p: {
    ip: string; status: string; group?: { name: string }; isFirstRows: boolean; isReserved?: boolean; safeZoom: number;
    device?: Device; discovered?: DiscoveredHost;
    onSelectDevice: (d: Device) => void; onRefreshDevice: (id: number, ip: string, type: 'info' | 'services') => void;
    onUpdateDeviceField: (id: number, data: object) => void; onScanDiscoveredHost: (ip: string) => void;
    onAddDevice: (ip: string) => void; onDeleteDiscoveredHost: (id: number, ip: string) => void;
    isRefreshingServices: boolean; isRefreshingAdd: boolean;
  }) => (
    <div
      data-testid={`tile-${p.ip}`}
      data-status={p.status}
      data-group={p.group?.name ?? ''}
      data-first-rows={String(p.isFirstRows)}
      data-reserved={String(!!p.isReserved)}
      data-zoom={p.safeZoom}
      data-busy={String(!!p.isRefreshingServices || !!p.isRefreshingAdd)}
    >
      {p.device && <>
        <button onClick={() => p.onSelectDevice(p.device!)}>open {p.ip}</button>
        <button onClick={() => p.onRefreshDevice(p.device!.id, p.ip, 'info')}>info {p.ip}</button>
        <button onClick={() => p.onUpdateDeviceField(p.device!.id, { is_reserved: true })}>reserve {p.ip}</button>
      </>}
      {p.discovered && <>
        <button onClick={() => p.onScanDiscoveredHost(p.ip)}>scan {p.ip}</button>
        <button onClick={() => p.onAddDevice(p.ip)}>add {p.ip}</button>
        <button onClick={() => p.onDeleteDiscoveredHost(p.discovered!.id, p.ip)}>forget {p.ip}</button>
      </>}
    </div>
  ),
}));
vi.mock('../../api/client', () => ({
  createScanSocket: vi.fn(() => ({ close: vi.fn() })),
  api: {
    getDevices: vi.fn(),
    getSettings: vi.fn(),
    getSubnetsList: vi.fn(),
    quickSubnetScan: vi.fn(),
    updateSettings: vi.fn(),
    refreshDeviceInfo: vi.fn(),
    refreshServices: vi.fn(),
    updateDevice: vi.fn(),
    scanIp: vi.fn(),
    addDeviceFromIp: vi.fn(),
    deleteDiscoveredHost: vi.fn(),
    createSubnet: vi.fn(),
    deleteSubnet: vi.fn(),
    updateSubnet: vi.fn(),
  },
}));

const m = vi.mocked(api);

const subnets = [
  { id: 1, cidr: '192.168.1.0/24', name: 'LAN', dns_server: null, is_enabled: true },
  { id: 2, cidr: '10.0.0.0/24', name: 'Lab', dns_server: '10.0.0.1', is_enabled: true },
] as Subnet[];

const devices = [
  { id: 1, ip: '192.168.1.10', display_name: 'NAS', is_online: true },
  { id: 2, ip: '192.168.1.20', display_name: 'Printer', is_online: false, is_reserved: true },
  { id: 3, ip: '10.0.0.5', display_name: 'Lab box', is_online: true },
] as Device[];

const discovered = [
  { id: 7, ip: '192.168.1.50', is_online: true, first_seen: '2026-10-01T10:00:00Z' },
  { id: 8, ip: '192.168.1.51', is_online: false, first_seen: '2026-10-05T10:00:00Z' },
  { id: 9, ip: '192.168.1.10', is_online: true, first_seen: '2026-10-06T10:00:00Z' },
] as DiscoveredHost[];

const areas = { '192.168.1': [{ name: 'Servers', start: 10, end: 19, color: '#ff0000' }] };

function tile(ip: string) {
  return screen.getByTestId(`tile-${ip}`);
}

async function renderView() {
  const user = userEvent.setup();
  render(<SubnetView />);
  await waitFor(() => expect(screen.getByTestId('tile-192.168.1.10')).toHaveAttribute('data-status', 'online'));
  return { user };
}

/** The updater the view passed to setDiscoveredHosts, applied to the current list. */
function lastDiscoveredUpdate(): DiscoveredHost[] {
  const updater = network.setDiscoveredHosts.mock.calls.at(-1)![0];
  return updater(discovered);
}

beforeEach(() => {
  vi.clearAllMocks();
  network.discoveredHosts = discovered;
  m.getDevices.mockResolvedValue(devices);
  m.getSettings.mockResolvedValue({ network_groups: JSON.stringify(areas) } as never);
  m.getSubnetsList.mockResolvedValue(subnets);
  m.quickSubnetScan.mockResolvedValue({} as never);
  m.updateSettings.mockResolvedValue({} as never);
  m.updateSubnet.mockResolvedValue({} as never);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('SubnetView map', () => {
  it('picks the first subnet, quick-scans it once and maps all 256 addresses', async () => {
    await renderView();

    await waitFor(() => expect(m.quickSubnetScan).toHaveBeenCalledWith('192.168.1'));
    expect(m.quickSubnetScan).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId(/^tile-/)).toHaveLength(256);
    expect(tile('192.168.1.0')).toHaveAttribute('data-status', 'reserved');
    expect(tile('192.168.1.255')).toHaveAttribute('data-status', 'reserved');
    expect(tile('192.168.1.20')).toHaveAttribute('data-status', 'offline');
    expect(tile('192.168.1.20')).toHaveAttribute('data-reserved', 'true');
    expect(tile('192.168.1.50')).toHaveAttribute('data-status', 'online');
    expect(tile('192.168.1.51')).toHaveAttribute('data-status', 'offline');
    expect(tile('192.168.1.99')).toHaveAttribute('data-status', 'empty');
    expect(tile('192.168.1.12')).toHaveAttribute('data-group', 'Servers');
    expect(tile('192.168.1.20')).toHaveAttribute('data-group', '');
    expect(tile('192.168.1.31')).toHaveAttribute('data-first-rows', 'true');
    expect(tile('192.168.1.32')).toHaveAttribute('data-first-rows', 'false');
  });

  it('counts online devices plus online hosts not yet in the overview', async () => {
    await renderView();
    // NAS (device) + .50 (discovered only); .10 is discovered too but already a device
    expect(screen.getByText('2 Online')).toBeInTheDocument();
  });

  it('switches subnets with the tabs and quick-scans the new one', async () => {
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: 'Lab' }));

    await waitFor(() => expect(tile('10.0.0.5')).toHaveAttribute('data-status', 'online'));
    expect(screen.getByRole('button', { name: 'Lab' })).toHaveAttribute('aria-pressed', 'true');
    expect(m.quickSubnetScan).toHaveBeenLastCalledWith('10.0.0');
  });

  it('zooms the map', async () => {
    await renderView();
    const grid = tile('192.168.1.1').parentElement!;
    expect(grid.style.gridTemplateColumns).toBe('repeat(16, 1fr)');

    fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '2' } });

    expect(grid.style.gridTemplateColumns).toBe('repeat(8, 1fr)');
    expect(grid.style.gap).toBe('24px');
    expect(tile('192.168.1.1')).toHaveAttribute('data-zoom', '2');
  });

  it('lists recent findings not in the overview, newest first, and jumps to their subnet', async () => {
    const { user } = await renderView();
    const box = screen.getByText('Recent Findings').parentElement!;

    expect(within(box).getAllByText(/^192\.168\.1\./).map((e) => e.textContent)).toEqual(['192.168.1.51', '192.168.1.50']);

    await user.click(screen.getByRole('button', { name: 'Lab' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Lab' })).toHaveAttribute('aria-pressed', 'true'));
    await user.click(within(box).getByText('192.168.1.50'));
    expect(screen.getByRole('button', { name: 'LAN' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('runs a discovery of the current subnet', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /^Scan$/ }));
    expect(network.runDiscovery).toHaveBeenCalledWith('192.168.1');
  });
});

describe('SubnetView L2/L3 badges', () => {
  beforeEach(() => {
    m.getSubnetsList.mockResolvedValue([
      { id: 1, cidr: '192.168.1.0/24', name: 'LAN', dns_server: null, is_enabled: true, is_direct_l2: true, interface_name: 'eth0' },
      { id: 2, cidr: '10.0.0.0/24', name: 'Lab', dns_server: null, is_enabled: true, is_direct_l2: false },
      { id: 3, cidr: '10.0.5.0/24', name: 'IoT', dns_server: null, is_enabled: true, is_direct_l2: false, is_agent_probe: true, probe_device_name: 'pi-probe' },
    ] as Subnet[]);
  });

  it('labels each subnet in English in its tab and in the header', async () => {
    const { user } = await renderView();

    expect(screen.getByTitle('L2 Direct (eth0)')).toHaveTextContent('L2');
    expect(screen.getByTitle('L3 Routed')).toHaveTextContent('L3');
    expect(screen.getByTitle('L2 Probe (pi-probe)')).toHaveTextContent('L2 Probe');
    expect(screen.getByText('● L2 Direct')).toBeInTheDocument();
    expect(screen.getByText('(eth0)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Lab' }));
    expect(screen.getByText('▲ L3 Routed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'IoT' }));
    expect(screen.getByText('● L2 Probe (pi-probe)')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Direkt|Geroutet/);
  });

  it('labels each subnet in English in the subnet settings', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Subnet Settings/ }));
    const modal = screen.getByText('Subnet Configuration').closest('.modal-content') as HTMLElement;

    expect(within(modal).getByText('L2 Direct (eth0)')).toBeInTheDocument();
    expect(within(modal).getByText('L3 Routed (no native MAC via ARP)')).toBeInTheDocument();
    expect(within(modal).getByText('L2 Probe (pi-probe)')).toBeInTheDocument();
  });
});

describe('SubnetView tile actions', () => {
  it('opens the device editor', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: 'open 192.168.1.10' }));
    expect(screen.getByRole('dialog', { name: 'device editor' })).toHaveTextContent('NAS');
  });

  it('refreshes device info and reloads', async () => {
    m.refreshDeviceInfo.mockResolvedValue({} as never);
    const { user } = await renderView();
    m.getDevices.mockClear();

    await user.click(screen.getByRole('button', { name: 'info 192.168.1.10' }));

    await waitFor(() => expect(m.refreshDeviceInfo).toHaveBeenCalledWith(1));
    await waitFor(() => expect(m.getDevices).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith('success', 'Success', 'Changes have been applied.');
  });

  it('updates a device field', async () => {
    m.updateDevice.mockResolvedValue({} as never);
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: 'reserve 192.168.1.10' }));
    await waitFor(() => expect(m.updateDevice).toHaveBeenCalledWith(1, { is_reserved: true }));
  });

  it('port-scans a discovered host and stores the ports', async () => {
    m.scanIp.mockResolvedValue({ ports: [22, 80] } as never);
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: 'scan 192.168.1.50' }));

    await waitFor(() => expect(network.setDiscoveredHosts).toHaveBeenCalled());
    expect(lastDiscoveredUpdate().find((h) => h.ip === '192.168.1.50')).toMatchObject({ ports: [22, 80] });
    expect(showToast).toHaveBeenLastCalledWith('success', 'Scan completed', 'Ports found: 22, 80');
  });

  it('adds a discovered host to the overview', async () => {
    m.addDeviceFromIp.mockResolvedValue({} as never);
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: 'add 192.168.1.50' }));

    await waitFor(() => expect(m.addDeviceFromIp).toHaveBeenCalledWith('192.168.1.50'));
    await waitFor(() => expect(network.setDiscoveredHosts).toHaveBeenCalled());
    expect(lastDiscoveredUpdate().map((h) => h.ip)).not.toContain('192.168.1.50');
  });

  it('forgets a discovered host', async () => {
    m.deleteDiscoveredHost.mockResolvedValue({} as never);
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: 'forget 192.168.1.51' }));

    await waitFor(() => expect(m.deleteDiscoveredHost).toHaveBeenCalledWith(8));
    expect(lastDiscoveredUpdate().map((h) => h.id)).toEqual([7, 9]);
  });
});

describe('SubnetView subnets and areas', () => {
  it.each([
    ['10.1.2', '10.1.2.0/24'],
    ['10.1.2.5', '10.1.2.5/32'],
    ['10.0.0.0/16', '10.0.0.0/16'],
  ])('adds the subnet %s as %s', async (input, cidr) => {
    m.createSubnet.mockResolvedValue({} as never);
    vi.spyOn(window, 'prompt').mockReturnValue(input);
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: /Add Subnet/ }));

    await waitFor(() => expect(m.createSubnet).toHaveBeenCalledWith({ cidr, name: `Network ${cidr}`, is_enabled: true }));
  });

  it('shows why a subnet could not be added', async () => {
    m.createSubnet.mockRejectedValue(new Error('Subnet 10.0.0.0/24 is already configured'));
    vi.spyOn(window, 'prompt').mockReturnValue('10.0.0');
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: /Add Subnet/ }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', 'Error', 'Subnet 10.0.0.0/24 is already configured'));
  });

  it('gives every subnet a tab and marks the paused ones', async () => {
    m.getSubnetsList.mockResolvedValue([
      ...subnets,
      { id: 3, cidr: '192.168.110.0/24', name: 'IoT', dns_server: null, is_enabled: false },
    ] as Subnet[]);
    await renderView();

    const paused = await screen.findByRole('button', { name: 'IoT (Paused)' });
    expect(paused).toHaveAttribute('title', expect.stringContaining('Not scanned'));
    expect(paused.closest('.subnet-tab')).toHaveClass('is-paused');
    expect(screen.getByRole('button', { name: 'LAN' }).closest('.subnet-tab')).not.toHaveClass('is-paused');
    expect(screen.getByRole('button', { name: 'Lab' })).toBeInTheDocument();
  });

  it('pauses scanning of a subnet in the subnet settings', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Subnet Settings/ }));
    const modal = screen.getByText('Subnet Configuration').closest('.modal-content') as HTMLElement;

    const scanLab = within(modal).getByLabelText('Scan 10.0.0.0/24');
    expect(scanLab).toBeChecked();
    await user.click(scanLab);
    await waitFor(() => expect(m.updateSubnet).toHaveBeenCalledWith(2, { is_enabled: false }));
    expect(m.getSubnetsList.mock.calls.length).toBeGreaterThan(1);
  });

  it('deletes the active subnet from its tab', async () => {
    m.deleteSubnet.mockResolvedValue({} as never);
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: 'Delete 192.168.1.0/24' }));

    await waitFor(() => expect(m.deleteSubnet).toHaveBeenCalledWith(1));
    expect(screen.queryByRole('button', { name: 'Delete 10.0.0.0/24' })).not.toBeInTheDocument();
  });

  it('renames a subnet and deletes one in the settings', async () => {
    m.deleteSubnet.mockResolvedValue({} as never);
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Subnet Settings/ }));
    const modal = screen.getByText('Subnet Configuration').closest('.modal-content') as HTMLElement;

    const name = within(modal).getByDisplayValue('Lab');
    await user.clear(name);
    await user.type(name, 'Lab 2');
    await user.tab();
    await waitFor(() => expect(m.updateSubnet).toHaveBeenCalledWith(2, { name: 'Lab 2' }));

    const dns = within(modal).getByDisplayValue('10.0.0.1');
    await user.clear(dns);
    await user.tab();
    await waitFor(() => expect(m.updateSubnet).toHaveBeenCalledWith(2, { dns_server: null }));

    await user.click(within(modal).getAllByRole('button', { name: /Delete/ })[1]);
    await waitFor(() => expect(m.deleteSubnet).toHaveBeenCalledWith(2));

    await user.click(within(modal).getByRole('button', { name: 'Finish' }));
    expect(screen.queryByText('Subnet Configuration')).not.toBeInTheDocument();
  });

  it('adds, edits and removes areas of the current subnet with explicit save', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Manage Areas/ }));
    const saved = () => JSON.parse(m.updateSettings.mock.calls.at(-1)![0].network_groups as string);

    await user.type(screen.getByPlaceholderText('Area name'), 'Clients');
    fireEvent.change(screen.getByPlaceholderText('Start'), { target: { value: '100' } });
    fireEvent.change(screen.getByPlaceholderText('End'), { target: { value: '199' } });
    await user.click(screen.getByPlaceholderText('End').parentElement!.querySelector('button.btn-primary')!);

    const modal = screen.getByRole('heading', { name: 'Manage Areas' }).closest('.modal-content') as HTMLElement;

    // Edit Servers to Core
    fireEvent.change(screen.getByDisplayValue('Servers'), { target: { value: 'Core' } });

    // Remove the first area (Core)
    await user.click(within(modal).getAllByTitle('Delete')[0]);

    // Verify nothing was saved to the API during typing/editing
    expect(m.updateSettings).not.toHaveBeenCalled();

    // Click Save button in modal footer
    await user.click(within(modal).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(m.updateSettings).toHaveBeenCalledTimes(1));
    expect(saved()['192.168.1']).toEqual([
      { name: 'Clients', start: 100, end: 199, color: '#38bdf8' },
    ]);
    expect(tile('192.168.1.150')).toHaveAttribute('data-group', 'Clients');
    expect(showToast).toHaveBeenCalledWith('success', 'Saved', 'Network areas updated successfully.');
  });
});
