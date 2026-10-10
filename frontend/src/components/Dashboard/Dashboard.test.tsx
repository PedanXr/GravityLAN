import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, DeviceGroup } from '../../types';
import { api } from '../../api/client';
import { GridStack } from 'gridstack';
import { Dashboard } from './Dashboard';

const showToast = vi.fn();

vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('./NotificationCenter', () => ({ NotificationCenter: () => null }));
vi.mock('./AgentUpdateCenter', () => ({ AgentUpdateCenter: () => <div>update center</div> }));
vi.mock('./DeviceEditor', () => ({
  DeviceEditor: ({ device }: { device: Device }) => <div role="dialog" aria-label="device editor">{device.display_name}</div>,
}));
vi.mock('./DeviceList', () => ({
  DeviceList: ({ devices }: { devices: Device[] }) => <ul data-testid="device-list">{devices.map((d) => <li key={d.id}>{d.display_name}</li>)}</ul>,
}));
vi.mock('./DeviceCard', () => ({
  DeviceCard: ({ device, isEditMode, onEdit, onSelect }: {
    device: Device; isEditMode: boolean; onEdit: (e: { stopPropagation(): void }) => void; onSelect: (s: boolean) => void;
  }) => (
    <div>
      <span>{device.display_name}</span>
      <button type="button" onClick={(e) => onEdit(e)}>edit {device.display_name}</button>
      {isEditMode && <input type="checkbox" aria-label={`select ${device.display_name}`} onChange={(e) => onSelect(e.target.checked)} />}
    </div>
  ),
}));
vi.mock('gridstack', () => ({ GridStack: { init: vi.fn() } }));
vi.mock('../../api/client', () => ({
  createScanSocket: vi.fn(() => ({ close: vi.fn() })),
  api: {
    getDevices: vi.fn(),
    getGroups: vi.fn(),
    updateGroup: vi.fn(),
    updateDevice: vi.fn(),
    bulkDeleteDevices: vi.fn(),
    refreshAllDevices: vi.fn(),
    getSubnets: vi.fn(),
    startDashboardScan: vi.fn(),
    getScanStatus: vi.fn(),
  },
}));

const m = vi.mocked(api);
const gridInit = vi.mocked(GridStack.init);

function grid() {
  return { on: vi.fn(), destroy: vi.fn(), batchUpdate: vi.fn(), compact: vi.fn(), float: vi.fn() };
}

function makeDevice(over: Partial<Device>): Device {
  return {
    id: 1, ip: '10.0.0.1', display_name: 'dev', hostname: null, group_id: null,
    x: null, y: null, w: null, h: null, has_agent: false, services: [], ...over,
  } as unknown as Device;
}

const groups = [
  { id: 1, name: 'Servers', sort_order: 0 },
  { id: 2, name: 'Clients', sort_order: 1 },
  { id: 3, name: 'Empty', sort_order: 2 },
] as DeviceGroup[];

const devices = [
  makeDevice({ id: 1, display_name: 'NAS', group_id: 1, x: 0, y: 0, w: 6, h: 2 }),
  makeDevice({
    id: 4, display_name: 'Proxmox', group_id: 1, has_agent: true,
    agent_info: { agent_version: '0.3.0', latest_version: '0.3.5' },
    services: [1, 2, 3, 4, 5].map((id) => ({ id })) as Device['services'],
  }),
  makeDevice({ id: 2, display_name: 'Laptop', group_id: 2 }),
  makeDevice({ id: 3, display_name: 'Printer', group_id: null }),
];

async function renderDashboard() {
  const user = userEvent.setup();
  const view = render(<Dashboard />);
  await screen.findByText('NAS');
  return { user, ...view };
}

function groupHeader(name: string) {
  return screen.getByRole('heading', { name }).closest('.group-section__header') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  gridInit.mockImplementation(() => grid() as never);
  m.getDevices.mockResolvedValue(devices);
  m.getGroups.mockResolvedValue(groups);
  m.updateGroup.mockResolvedValue({} as never);
  m.updateDevice.mockResolvedValue({} as never);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Dashboard', () => {
  it('shows a loading state, then the groups with their device counts', async () => {
    render(<Dashboard />);
    expect(screen.getByText('Loading overview...')).toBeInTheDocument();

    await screen.findByText('NAS');
    expect(screen.getByText('4 Devices, 3 Sections')).toBeInTheDocument();
    expect(within(groupHeader('Servers')).getByText('2')).toBeInTheDocument();
    expect(within(groupHeader('Clients')).getByText('1')).toBeInTheDocument();
    expect(within(groupHeader('Unassigned Devices')).getByText('1')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Empty' })).not.toBeInTheDocument();
  });

  it('shows the empty state without devices', async () => {
    m.getDevices.mockResolvedValue([]);
    m.getGroups.mockResolvedValue([]);
    render(<Dashboard />);

    expect(await screen.findByText('No devices found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scan Now/ })).toBeInTheDocument();
  });

  it('sizes grid tiles from the saved layout or from the card content', async () => {
    const { container } = await renderDashboard();

    const saved = container.querySelector('[gs-id="1"]')!;
    expect(saved).toHaveAttribute('gs-x', '0');
    expect(saved).toHaveAttribute('gs-w', '6');
    expect(saved).toHaveAttribute('gs-h', '2');
    expect(saved).not.toHaveAttribute('gs-auto-position');

    // agent card: 4x5, plus one row for the second row of service chips
    const auto = container.querySelector('[gs-id="4"]')!;
    expect(auto).toHaveAttribute('gs-w', '4');
    expect(auto).toHaveAttribute('gs-h', '6');
    expect(auto).toHaveAttribute('gs-auto-position', 'true');

    const plain = container.querySelector('[gs-id="2"]')!;
    expect(plain).toHaveAttribute('gs-w', '3');
    expect(plain).toHaveAttribute('gs-h', '3');
  });

  it('starts one static grid per visible group and editable ones in edit mode', async () => {
    const { user } = await renderDashboard();
    await waitFor(() => expect(gridInit).toHaveBeenCalled());
    const staticInits = gridInit.mock.calls.filter(([opts]) => opts?.staticGrid === true);
    expect(new Set(staticInits.map(([, el]) => (el as HTMLElement).className.match(/grid-stack-(\w+)/)![1]))).toEqual(new Set(['1', '2', 'null']));

    gridInit.mockClear();
    await user.click(screen.getByRole('button', { name: /Edit Layout/ }));

    await waitFor(() => expect(gridInit).toHaveBeenCalledTimes(3));
    expect(gridInit.mock.calls.every(([opts]) => opts?.staticGrid === false)).toBe(true);
  });

  it('collapses and expands a group', async () => {
    const { user } = await renderDashboard();

    await user.click(groupHeader('Servers'));
    expect(screen.queryByText('NAS')).not.toBeInTheDocument();
    expect(screen.getByText('(Click to expand)')).toBeInTheDocument();

    await user.click(groupHeader('Servers'));
    expect(screen.getByText('NAS')).toBeInTheDocument();
  });

  it('switches to the list view', async () => {
    const { user } = await renderDashboard();

    await user.click(screen.getByRole('button', { name: 'List' }));

    const lists = screen.getAllByTestId('device-list');
    expect(lists.map((l) => l.textContent)).toEqual(['NASProxmox', 'Laptop', 'Printer']);
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens the device editor from a card', async () => {
    const { user } = await renderDashboard();

    await user.click(screen.getByRole('button', { name: 'edit Laptop' }));

    expect(screen.getByRole('dialog', { name: 'device editor' })).toHaveTextContent('Laptop');
  });

  it('moves a group down by swapping sort orders', async () => {
    const { user } = await renderDashboard();
    await user.click(screen.getByRole('button', { name: /Edit Layout/ }));

    expect(within(groupHeader('Servers')).getByTitle('Move group up')).toBeDisabled();
    // the reload after the move returns the server's new order
    m.getGroups.mockResolvedValue([
      { ...groups[1], sort_order: 0 }, { ...groups[0], sort_order: 1 }, groups[2],
    ]);
    await user.click(within(groupHeader('Servers')).getByTitle('Move group down'));

    await waitFor(() => expect(m.updateGroup).toHaveBeenCalledTimes(2));
    expect(m.updateGroup).toHaveBeenNthCalledWith(1, 1, { sort_order: 1 });
    expect(m.updateGroup).toHaveBeenNthCalledWith(2, 2, { sort_order: 0 });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(['Clients', 'Servers']);
  });

  it('deletes the selected devices in edit mode', async () => {
    m.bulkDeleteDevices.mockResolvedValue(undefined);
    const { user } = await renderDashboard();
    await user.click(screen.getByRole('button', { name: /Edit Layout/ }));

    await user.click(screen.getByLabelText('select NAS'));
    await user.click(screen.getByLabelText('select Printer'));
    await user.click(screen.getByRole('button', { name: /Delete 2/ }));

    await waitFor(() => expect(m.bulkDeleteDevices).toHaveBeenCalledWith([1, 3]));
  });

  it('compacts every grid in edit mode', async () => {
    const grids: ReturnType<typeof grid>[] = [];
    gridInit.mockImplementation(() => { const g = grid(); grids.push(g); return g as never; });
    const { user } = await renderDashboard();
    await user.click(screen.getByRole('button', { name: /Edit Layout/ }));
    await waitFor(() => expect(gridInit.mock.calls.some(([o]) => o?.staticGrid === false)).toBe(true));

    await user.click(screen.getByRole('button', { name: /Compact/ }));

    const live = grids.slice(-3);
    expect(live.every((g) => g.compact.mock.calls.length > 0)).toBe(true);
    expect(live[0].float).toHaveBeenNthCalledWith(1, false);
    expect(live[0].float).toHaveBeenNthCalledWith(2, true);
  });

  it('refreshes all devices', async () => {
    m.refreshAllDevices.mockResolvedValue({ status: 'ok', updated_count: 4 });
    const { user } = await renderDashboard();

    await user.click(screen.getByRole('button', { name: /Refresh All/ }));

    await waitFor(() => expect(m.refreshAllDevices).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith('success', 'Refresh All', 'Info updated');
  });

  it('opens the agent update center for outdated agents', async () => {
    const { user } = await renderDashboard();

    await user.click(screen.getByRole('button', { name: /1 Agent Updates/ }));

    expect(screen.getByText('update center')).toBeInTheDocument();
  });

  it('scans the chosen subnet and reports when it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.getSubnets.mockResolvedValue([
      { subnet: '10.0.0.0/24', interface_name: 'eth0', ip_address: '10.0.0.2' },
      { subnet: '192.168.1.0/24', interface_name: 'eth1', ip_address: '192.168.1.2' },
    ] as never);
    m.startDashboardScan.mockResolvedValue({ status: 'ok' } as never);
    m.getScanStatus
      .mockResolvedValueOnce({ status: 'running', message: 'Scanning 10.0.0.0/24', hosts_scanned: 64, hosts_total: 256, devices_found: 3 } as never)
      .mockResolvedValue({ status: 'completed', message: 'done', hosts_scanned: 256, hosts_total: 256, devices_found: 5 } as never);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Dashboard />);
    await screen.findByText('NAS');

    await user.click(screen.getByRole('button', { name: /^Scan$/ }));
    const dialog = await screen.findByText('Select Network');
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByLabelText(/192\.168\.1\.0\/24/));
    await user.click(screen.getByRole('button', { name: 'Start Scan' }));

    await waitFor(() => expect(m.startDashboardScan).toHaveBeenCalledWith({ subnets: ['192.168.1.0/24'] }));
    expect(screen.queryByText('Select Network')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scanning/ })).toBeDisabled();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(await screen.findByText('Scanning 10.0.0.0/24')).toBeInTheDocument();
    expect(screen.getByText('64 / 256 IPs')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('success', 'Scan completed', '5 devices found'));
    expect(screen.getByRole('button', { name: /^Scan$/ })).toBeEnabled();
  });
});
