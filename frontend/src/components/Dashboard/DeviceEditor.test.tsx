import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, Service } from '../../types';
import { api } from '../../api/client';
import { DeviceEditor } from './DeviceEditor';

const showToast = vi.fn();

vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('./DeviceMetrics', () => ({ DeviceMetrics: () => <div data-testid="metrics" /> }));
vi.mock('../Agents/ManualInstallCommand', () => ({
  ManualInstallCommand: () => <div />,
  ManualUninstallCommand: () => <div />,
}));
vi.mock('../../api/client', () => ({
  api: {
    getGroups: vi.fn(),
    getRacks: vi.fn(),
    getDeviceHistory: vi.fn(),
    getAgentStatus: vi.fn(),
    getAgentConfig: vi.fn(),
    deployAgent: vi.fn(),
    uninstallAgent: vi.fn(),
    getSshProfiles: vi.fn(),
    updateAgentConfig: vi.fn(),
    refreshDeviceInfo: vi.fn(),
    refreshServices: vi.fn(),
    addService: vi.fn(),
    updateService: vi.fn(),
    deleteService: vi.fn(),
    getDevice: vi.fn(),
    updateDevice: vi.fn(),
    deleteDevice: vi.fn(),
    getDeviceInterfaces: vi.fn(),
    getMergeSuggestions: vi.fn(),
  },
}));

const m = vi.mocked(api);

function service(id: number, port: number, name: string, protocol = 'http'): Service {
  return { id, port, name, protocol, is_up: true, is_auto_detected: true } as unknown as Service;
}

function makeDevice(over: Partial<Device> = {}): Device {
  return {
    id: 1,
    ip: '192.168.1.10',
    mac: 'aa:bb:cc:dd:ee:ff',
    hostname: 'nas.lan',
    display_name: 'NAS',
    vendor: 'Synology',
    notes: '',
    group_id: 1,
    parent_id: null,
    virtual_type: null,
    is_online: true,
    is_host: false,
    is_wlan: false,
    is_ap: false,
    rack_id: null,
    rack_unit: null,
    rack_height: 1,
    w: 2,
    h: 3,
    x: 0,
    y: 0,
    services: [],
    ...over,
  } as unknown as Device;
}

/** The input/select inside the .form-group whose label reads `text` (labels here have no htmlFor). */
function field(text: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const group = screen.getByText(text, { selector: 'label' }).closest('.form-group')!;
  return group.querySelector('input, select, textarea')!;
}

function renderEditor(device = makeDevice(), devices: Device[] = [device]) {
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(<DeviceEditor device={device} devices={devices} onClose={onClose} onSave={onSave} />);
  return { onClose, onSave, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getGroups.mockResolvedValue([{ id: 1, name: 'Servers' }, { id: 2, name: 'Clients' }] as never);
  m.getRacks.mockResolvedValue([{ id: 5, name: 'Rack A' }] as never);
  m.getDeviceHistory.mockResolvedValue([] as never);
  m.getAgentStatus.mockResolvedValue({ is_installed: false, is_active: false } as never);
  m.getSshProfiles.mockResolvedValue([]);
  m.updateDevice.mockResolvedValue({} as never);
  m.updateService.mockResolvedValue({} as never);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('DeviceEditor header', () => {
  it('shows name, IP, role and the parent chain', () => {
    const proxmox = makeDevice({ id: 2, display_name: 'Proxmox', is_host: true });
    const vm = makeDevice({ id: 3, display_name: 'Docker VM', parent_id: 2, virtual_type: 'vm' });
    renderEditor(makeDevice({ parent_id: 3, virtual_type: 'docker' }), [proxmox, vm]);

    expect(screen.getByRole('heading', { name: 'NAS' })).toBeInTheDocument();
    expect(screen.getByText('192.168.1.10 · Docker')).toBeInTheDocument();
    const path = screen.getByRole('navigation', { name: 'Network path' });
    expect(path).toHaveTextContent('Proxmox›Docker VM›NAS');
  });

  it('closes on Escape and on the close button', async () => {
    const { onClose, user } = renderEditor();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('opens straight on the interfaces tab, e.g. from the gateway list', async () => {
    const iface = {
      id: 7, device_id: 1, ip: '192.168.110.1', mac: null, subnet_id: 2, subnet_name: 'IoT', subnet_cidr: '192.168.110.0/24',
      vlan_id: 110, label: null, is_online: true, last_seen: null, first_seen: null,
    };
    m.getDeviceInterfaces.mockResolvedValue([iface]);
    m.getMergeSuggestions.mockResolvedValue([]);
    const device = makeDevice({ interfaces: [iface] });
    render(<DeviceEditor device={device} devices={[device]} onClose={vi.fn()} onSave={vi.fn()} initialTab="interfaces" />);

    expect(screen.getByRole('tab', { name: 'Interfaces (2)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Addresses of this device' })).toHaveTextContent('192.168.110.1');
    await waitFor(() => expect(m.getDeviceInterfaces).toHaveBeenCalledWith(1));
  });

  it('switches tabs with the arrow keys', async () => {
    const { user } = renderEditor();
    screen.getByRole('tab', { name: 'General' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('DeviceEditor general tab', () => {
  it('saves the form without moving the device when the group is unchanged', async () => {
    const { onSave, onClose, user } = renderEditor();
    await waitFor(() => expect(m.getGroups).toHaveBeenCalled());

    await user.clear(field('Display Name'));
    await user.type(field('Display Name'), 'Storage');
    await user.type(field('Notes'), 'in the basement');
    await user.click(screen.getByText('WLAN Client'));
    await user.click(screen.getByRole('button', { name: 'VM' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(m.updateDevice).toHaveBeenCalledWith(1, {
      display_name: 'Storage',
      notes: 'in the basement',
      group_id: 1,
      vendor: 'Synology',
      w: 2,
      h: 3,
      virtual_type: 'vm',
      parent_id: null,
      rack_id: null,
      rack_unit: null,
      rack_height: 1,
      is_wlan: true,
      is_ap: false,
      is_host: false,
      alert_offline: true,
    });
    expect(onSave).toHaveBeenCalled();
  });

  it('places the device below the target group when the group changes', async () => {
    const device = makeDevice();
    const other = makeDevice({ id: 9, group_id: 2, y: 4, h: 3 });
    const { onClose, user } = renderEditor(device, [device, other]);
    await screen.findByRole('option', { name: 'Clients' });

    await user.selectOptions(field('Group'), '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(m.updateDevice).toHaveBeenCalledWith(1, expect.objectContaining({ group_id: 2, x: 0, y: 7 }));
  });

  it('offers only other host devices as parent', () => {
    const host = makeDevice({ id: 2, display_name: 'Proxmox', is_host: true });
    const plain = makeDevice({ id: 3, display_name: 'Laptop' });
    renderEditor(makeDevice(), [host, plain]);

    const options = within(field('Physical Host') as HTMLSelectElement).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['No Host (Physical)', 'Proxmox']);
  });

  it('refreshes device info and takes the hostname when the name was the IP', async () => {
    m.refreshDeviceInfo.mockResolvedValue(makeDevice({ display_name: '192.168.1.10', hostname: 'printer.lan', vendor: 'HP' }) as never);
    const { onSave, user } = renderEditor(makeDevice({ display_name: '192.168.1.10' }));

    await user.click(screen.getByRole('button', { name: /Info-Refresh/ }));

    await waitFor(() => expect(field('Display Name')).toHaveValue('printer'));
    expect(field('Vendor')).toHaveValue('HP');
    expect(onSave).toHaveBeenCalled();
  });

  it('saves edited services together with the device', async () => {
    const device = makeDevice({ services: [service(11, 80, 'Web')] });
    const { onClose, user } = renderEditor(device);

    await user.click(screen.getByRole('tab', { name: 'Services & Ports' }));
    const name = screen.getByDisplayValue('Web');
    await user.clear(name);
    await user.type(name, 'Portal');
    await user.click(screen.getByRole('tab', { name: 'General' }));
    m.updateService.mockClear();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(m.updateService).toHaveBeenCalledWith(11, { port: 80, name: 'Portal', protocol: 'http' });
  });
});

describe('DeviceEditor services tab', () => {
  it('lists services by port and deletes one after confirmation', async () => {
    const device = makeDevice({ services: [service(12, 443, 'TLS', 'https'), service(11, 22, 'Shell', 'ssh')] });
    m.getDevice.mockResolvedValue(makeDevice({ services: [service(12, 443, 'TLS', 'https')] }) as never);
    const { onSave, user } = renderEditor(device);

    await user.click(screen.getByRole('tab', { name: 'Services & Ports' }));
    const names = screen.getAllByDisplayValue(/TLS|Shell/).map((i) => (i as HTMLInputElement).value);
    expect(names).toEqual(['Shell', 'TLS']);

    const shellRow = screen.getByDisplayValue('Shell').closest('div[style]')!.parentElement!.parentElement!;
    await user.click(within(shellRow).getAllByRole('button').at(-1)!);

    await waitFor(() => expect(m.deleteService).toHaveBeenCalledWith(11));
    await waitFor(() => expect(screen.queryByDisplayValue('Shell')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalled();
  });

  it('shows the empty state', async () => {
    const { user } = renderEditor();
    await user.click(screen.getByRole('tab', { name: 'Services & Ports' }));
    expect(screen.getByText('No services detected or configured.')).toBeInTheDocument();
  });

  it('runs an nmap service scan', async () => {
    m.refreshServices.mockResolvedValue(makeDevice({ services: [service(20, 8080, 'Alt')] }) as never);
    const { user } = renderEditor();
    await user.click(screen.getByRole('tab', { name: 'Services & Ports' }));

    await user.click(screen.getByRole('button', { name: /Nmap Scan/ }));

    expect(await screen.findByDisplayValue('Alt')).toBeInTheDocument();
    expect(m.refreshServices).toHaveBeenCalledWith(1);
  });
});

describe('DeviceEditor history tab', () => {
  it('loads the history when opened', async () => {
    m.getDeviceHistory.mockResolvedValue([
      { id: 1, status: 'online', message: 'Device came online', timestamp: '2026-10-10T10:00:00Z' },
      { id: 2, status: 'down', message: 'HTTP down', service_id: 4, timestamp: '2026-10-10T11:00:00Z' },
    ] as never);
    const { user } = renderEditor();

    await user.click(screen.getByRole('tab', { name: 'History & Status' }));

    expect(await screen.findByText('Device came online')).toBeInTheDocument();
    expect(screen.getByText('HTTP down')).toBeInTheDocument();
    expect(screen.getByText('SERVICE')).toBeInTheDocument();
    expect(m.getDeviceHistory).toHaveBeenCalledWith(1);
  });

  it('shows the empty state', async () => {
    const { user } = renderEditor();
    await user.click(screen.getByRole('tab', { name: 'History & Status' }));
    expect(await screen.findByText('No events recorded yet.')).toBeInTheDocument();
  });
});

describe('DeviceEditor agent tab', () => {
  it('installs the agent once a password is entered and keeps the form across tab switches', async () => {
    m.deployAgent.mockResolvedValue({ status: 'success', message: 'Agent installed' } as never);
    const { user } = renderEditor();

    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    const install = await screen.findByRole('button', { name: /Install Agent/ });
    expect(install).toBeDisabled();

    await user.type(screen.getByLabelText('SSH Password / Key'), 'pw');
    await user.click(screen.getByRole('tab', { name: 'General' }));
    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByLabelText('SSH Password / Key')).toHaveValue('pw');

    await user.click(screen.getByRole('button', { name: /Install Agent/ }));

    await waitFor(() => expect(m.deployAgent).toHaveBeenCalledWith(1, { ssh_user: 'root', ssh_password: 'pw', ssh_key: '', ssh_port: 22 }));
    expect(await screen.findByText(/Agent installed$/)).toBeInTheDocument();
    expect(screen.getByLabelText('SSH Password / Key')).toHaveValue('');
  });

  it('installs with a saved key connection of the device, without a password', async () => {
    m.deployAgent.mockResolvedValue({ status: 'success', message: 'Agent installed' } as never);
    m.getSshProfiles.mockResolvedValue([
      { id: 7, name: 'NAS root', device_id: 1, host: null, target_host: '192.168.1.10', port: 22, username: 'root', auth_method: 'key', key_id: 3, key_name: 'Homelab' },
      { id: 8, name: 'NAS ask', device_id: 1, host: null, port: 22, username: 'root', auth_method: 'ask', key_id: null },
      { id: 9, name: 'Other', device_id: 2, host: null, port: 22, username: 'root', auth_method: 'key', key_id: 3 },
    ] as never);
    const { user } = renderEditor();

    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    // Offered first once loaded; only the key connection of this device
    expect(await screen.findByRole('button', { name: /Saved connection/ })).toHaveAttribute('aria-pressed', 'true');
    const select = screen.getByLabelText('Connection');
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['NAS root – root@192.168.1.10 (Homelab)']);
    expect(screen.queryByLabelText('SSH Password / Key')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('sudo password (optional)'), 'sudo-pw');
    await user.click(screen.getByRole('button', { name: /Install Agent/ }));

    await waitFor(() => expect(m.deployAgent).toHaveBeenCalledWith(1, { profile_id: 7, sudo_password: 'sudo-pw' }));
    expect(await screen.findByText(/Agent installed$/)).toBeInTheDocument();
    expect(screen.getByLabelText('sudo password (optional)')).toHaveValue('');
  });

  it('can switch from the saved connection back to a password', async () => {
    m.getSshProfiles.mockResolvedValue([
      { id: 7, name: 'NAS root', device_id: 1, host: null, port: 22, username: 'root', auth_method: 'key', key_id: 3 },
    ] as never);
    const { user } = renderEditor();
    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    await screen.findByLabelText('Connection');

    await user.click(screen.getByRole('button', { name: 'Password' }));

    expect(screen.queryByLabelText('Connection')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install Agent/ })).toBeDisabled();
    await user.type(screen.getByLabelText('SSH Password / Key'), 'pw');
    await user.click(screen.getByRole('button', { name: /Install Agent/ }));
    await waitFor(() => expect(m.deployAgent).toHaveBeenCalledWith(1, { ssh_user: 'root', ssh_password: 'pw', ssh_key: '', ssh_port: 22 }));
  });

  it('loads and saves the agent configuration when installed', async () => {
    m.getAgentStatus.mockResolvedValue({ is_installed: true, is_active: false, agent_version: '0.3.5' } as never);
    m.getAgentConfig.mockResolvedValue({ interval: 30, disk_paths: ['/'], enable_temp: false } as never);
    m.updateAgentConfig.mockResolvedValue({} as never);
    const { user } = renderEditor();

    await user.click(screen.getByRole('tab', { name: 'Agent' }));
    await screen.findByText('Agent Configuration');
    await user.type(screen.getByPlaceholderText('/mnt/data'), '/mnt/data');
    await user.click(screen.getByRole('button', { name: '+' }));
    await user.click(screen.getByRole('button', { name: /Save Configuration/ }));

    await waitFor(() => expect(m.updateAgentConfig).toHaveBeenCalledWith(1, { interval: 30, disk_paths: ['/', '/mnt/data'], enable_temp: false }));
    expect(screen.getByRole('button', { name: /Update Agent/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Uninstall/ })).toBeInTheDocument();
  });
});

describe('DeviceEditor footer', () => {
  it('deletes the device after confirmation', async () => {
    m.deleteDevice.mockResolvedValue({} as never);
    const { onSave, onClose, user } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(m.deleteDevice).toHaveBeenCalledWith(1);
    expect(onSave).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('success', 'Success', 'Successfully deleted');
  });

  it('keeps the device when the deletion is not confirmed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const { onClose, user } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(m.deleteDevice).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
