import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiTokenResponse, DeviceGroup, Subnet, SubnetInfo } from '../../types';
import { api } from '../../api/client';
import { SettingsView } from './SettingsView';

const showToast = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    getSettings: vi.fn(), updateSettings: vi.fn(),
    getGroups: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
    getApiTokens: vi.fn(), createApiToken: vi.fn(), deleteApiToken: vi.fn(),
    exportBackup: vi.fn(), importBackup: vi.fn(), resetDatabase: vi.fn(),
    getSubnetsList: vi.fn(), createSubnet: vi.fn(), updateSubnet: vi.fn(), deleteSubnet: vi.fn(),
    getSubnets: vi.fn(),
  },
}));
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../Sidebar', () => ({ Sidebar: () => <nav>sidebar</nav> }));
vi.mock('../MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('../LanguageToggle', () => ({ LanguageToggle: () => <span>language toggle</span> }));
vi.mock('./PasswordForm', () => ({ PasswordForm: () => <span>password form</span> }));

const m = vi.mocked(api);

const groups = [
  { id: 1, name: 'Unassigned', is_default: true },
  { id: 2, name: 'Media', is_default: false },
] as DeviceGroup[];

const tokens = [
  { id: 7, name: 'Home Assistant', prefix: 'glan_ab12', created_at: '2026-10-01T10:00:00Z', last_used_at: null },
] as unknown as ApiTokenResponse[];

const subnets = [
  { id: 1, cidr: '192.168.100.0/24', name: 'Home LAN', dns_server: null, is_enabled: true, is_direct_l2: true, interface_name: 'eth0' },
  { id: 2, cidr: '192.168.110.0/24', name: 'IoT', dns_server: null, is_enabled: true, is_direct_l2: false },
] as Subnet[];

const detected = [
  { subnet: '192.168.100.0/24', interface_name: 'eth0', ip_address: '192.168.100.20', netmask: '', is_up: true },
  { subnet: '192.168.130.0/24', interface_name: 'eth1', ip_address: '192.168.130.20', netmask: '', is_up: true },
  { subnet: '172.17.0.0/16', interface_name: 'docker0', ip_address: '172.17.0.1', netmask: '', is_up: true, is_virtual: true },
] as SubnetInfo[];

function renderView() {
  render(<MemoryRouter><SettingsView /></MemoryRouter>);
  return userEvent.setup();
}

const saveBar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettings.mockResolvedValue({ scan_interval: '15', 'system.log_level': 'debug' });
  m.updateSettings.mockResolvedValue({} as never);
  m.getGroups.mockResolvedValue(groups);
  m.createGroup.mockResolvedValue({} as never);
  m.updateGroup.mockResolvedValue({} as never);
  m.deleteGroup.mockResolvedValue(undefined);
  m.getApiTokens.mockResolvedValue(tokens);
  m.createApiToken.mockResolvedValue({ token: 'glan_secret_token' } as never);
  m.deleteApiToken.mockResolvedValue({ status: 'ok', message: '' });
  m.exportBackup.mockResolvedValue({ devices: [] });
  m.importBackup.mockResolvedValue({} as never);
  m.resetDatabase.mockResolvedValue({ status: 'ok', message: '' });
  m.getSubnetsList.mockResolvedValue(subnets);
  m.getSubnets.mockResolvedValue(detected);
  m.createSubnet.mockImplementation(async (data) => ({ id: 9, dns_server: null, is_enabled: true, name: '', ...data }) as Subnet);
  m.updateSubnet.mockResolvedValue({} as never);
  m.deleteSubnet.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsView', () => {
  it('fills the form from the stored settings and defaults', async () => {
    renderView();
    await waitFor(() => expect(screen.getByLabelText('Scan interval')).toHaveValue(15));
    expect(screen.getByLabelText('Quick check interval')).toHaveValue(300);
    expect(screen.getByLabelText('Scanner timeout')).toHaveValue(1.5);
    expect(screen.getByLabelText('Offline after')).toHaveValue(3);
    expect(screen.getByLabelText('Keep history for')).toHaveValue(7);
    expect(screen.getByLabelText('Log Level')).toHaveValue('debug');
    expect(screen.getByRole('link', { name: 'Open Logs' })).toHaveAttribute('href', '/logs');
    expect(saveBar()).not.toBeInTheDocument();
  });

  it('saves changed settings through the save bar', async () => {
    const user = renderView();
    await waitFor(() => expect(screen.getByLabelText('Scan interval')).toHaveValue(15));

    await user.clear(screen.getByLabelText('Custom DNS Server'));
    await user.type(screen.getByLabelText('Custom DNS Server'), '10.0.0.1');
    expect(within(saveBar()!).getByRole('status')).toHaveTextContent('Unsaved changes');

    m.getSettings.mockResolvedValue({ scan_interval: '15', 'system.log_level': 'debug', 'dns.server': '10.0.0.1' });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(m.updateSettings).toHaveBeenCalledWith({
      scan_interval: '15', quick_scan_interval: '300', scan_timeout: '1.5',
      'scanner.offline_threshold': '3', 'dns.server': '10.0.0.1', history_retention_days: '7',
      server_url_override: '', 'system.log_level': 'debug', 'ui.start_page': '/',
    });
    expect(await screen.findByText('Settings saved!')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('reports a failed save and can discard the changes', async () => {
    m.updateSettings.mockRejectedValue(new Error('nope'));
    const user = renderView();
    await waitFor(() => expect(screen.getByLabelText('Log Level')).toHaveValue('debug'));

    await user.selectOptions(screen.getByLabelText('Log Level'), 'warning');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Save failed!')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Log Level')).toHaveValue('debug');
    expect(saveBar()).not.toBeInTheDocument();
  });

  it('creates and deletes groups but keeps default ones', async () => {
    const user = renderView();
    expect(await screen.findByText('Media')).toBeInTheDocument();
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete group Unassigned' })).not.toBeInTheDocument();

    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText('New group name'), '  Lab  ');
    await user.click(create);
    expect(m.createGroup).toHaveBeenCalledWith({ name: 'Lab', icon: 'folder' });
    await waitFor(() => expect(screen.getByLabelText('New group name')).toHaveValue(''));
    expect(m.getGroups).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Delete group Media' }));
    expect(m.deleteGroup).toHaveBeenCalledWith(2);
  });

  it('reports a failing group action', async () => {
    m.deleteGroup.mockRejectedValue(new Error('in use'));
    const user = renderView();
    await user.click(await screen.findByRole('button', { name: 'Delete group Media' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', 'Error', 'Could not save the group. in use'));
  });

  it('does not delete a group without confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = renderView();
    await user.click(await screen.findByRole('button', { name: 'Delete group Media' }));
    expect(m.deleteGroup).not.toHaveBeenCalled();
  });

  it('renames a group through inline edit', async () => {
    const user = renderView();
    expect(await screen.findByText('Media')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit group Media' }));
    const editInput = screen.getByLabelText('Edit group Media');
    expect(editInput).toHaveValue('Media');

    await user.clear(editInput);
    await user.type(editInput, 'Media Server');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(m.updateGroup).toHaveBeenCalledWith(2, { name: 'Media Server' });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('success', 'Saved', 'Group was renamed.'));
  });

  it('generates a token once, copies it and revokes tokens', async () => {
    const user = renderView();
    expect(await screen.findByText('Home Assistant')).toBeInTheDocument();
    expect(screen.getByText('glan_ab12')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Token Name (e.g. Home Assistant)'), 'Script');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(m.createApiToken).toHaveBeenCalledWith('Script');
    expect(await screen.findByDisplayValue('glan_secret_token')).toBeInTheDocument();
    expect(screen.getByText(/Token successfully generated/)).toBeInTheDocument();

    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('success', 'Success', 'Copied!'));
    expect(await navigator.clipboard.readText()).toBe('glan_secret_token');

    await user.click(screen.getByRole('button', { name: 'Revoke token Home Assistant' }));
    expect(m.deleteApiToken).toHaveBeenCalledWith(7);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('success', 'Success', 'Token revoked.'));
  });

  it('shows an empty token list and a failed token creation', async () => {
    m.getApiTokens.mockResolvedValue([]);
    m.createApiToken.mockRejectedValue(new Error('limit'));
    const user = renderView();
    expect(await screen.findByText('No API tokens configured.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Token Name (e.g. Home Assistant)'), 'X');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', 'Error', 'Could not create the token. limit'));
  });

  it('downloads a backup file', async () => {
    const createObjectURL = vi.fn(() => 'blob:backup');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {});
    const user = renderView();

    await user.click(screen.getByRole('button', { name: 'Download Backup' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toMatch(/^gravitylan_backup_\d{4}-\d{2}-\d{2}\.json$/);
    expect(link.href).toBe('blob:backup');
  });

  it('imports a backup only after confirmation', async () => {
    const user = renderView();
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.upload(input, file);
    expect(m.importBackup).not.toHaveBeenCalled();

    await user.upload(input, file);
    await waitFor(() => expect(m.importBackup).toHaveBeenCalledWith(file));
    expect(window.alert).toHaveBeenCalledWith('Backup successfully imported! The page will be reloaded.');
  });

  it('arms the database reset on the first click and resets on the second', async () => {
    const user = renderView();
    await user.click(screen.getByRole('button', { name: 'Reset Database' }));
    expect(m.resetDatabase).not.toHaveBeenCalled();

    const armed = screen.getByRole('button', { name: 'Really delete? Click again' });
    expect(armed).toHaveClass('is-armed');
    await user.click(armed);
    await waitFor(() => expect(m.resetDatabase).toHaveBeenCalled());
    expect(window.alert).toHaveBeenCalledWith('Database successfully reset.');
  });

  it('shows language and password sections', () => {
    renderView();
    expect(screen.getByText('language toggle')).toBeInTheDocument();
    expect(screen.getByText('password form')).toBeInTheDocument();
  });
});

describe('SettingsView scan subnets', () => {
  const subnetList = () => screen.getByRole('list', { name: 'Scan subnets' });

  it('lists the scan subnets of the network overview instead of a text field', async () => {
    renderView();
    const list = await screen.findByRole('list', { name: 'Scan subnets' });
    expect(within(list).getByText('Home LAN')).toBeInTheDocument();
    expect(within(list).getByText('192.168.110.0/24')).toBeInTheDocument();
    expect(within(list).getByText(/L2 Direct \(eth0\)/)).toBeInTheDocument();
    expect(within(list).getByText(/L3 Routed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Scan 192.168.100.0/24')).toBeChecked();
    expect(screen.queryByPlaceholderText('192.168.1.0/24, 10.0.0.0/24')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/network');
  });

  it('adds a subnet right away, without the save bar', async () => {
    const user = renderView();
    await screen.findByRole('list', { name: 'Scan subnets' });

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('Subnet (CIDR)'), ' 192.168.120.0/24 ');
    await user.type(screen.getByLabelText('Name'), 'Guests');
    await user.click(add);

    expect(m.createSubnet).toHaveBeenCalledWith({ cidr: '192.168.120.0/24', name: 'Guests' });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('success', 'Saved', '192.168.120.0/24 is scanned from now on.'));
    await waitFor(() => expect(screen.getByLabelText('Subnet (CIDR)')).toHaveValue(''));
    expect(m.getSubnetsList).toHaveBeenCalledTimes(2);
    expect(m.updateSettings).not.toHaveBeenCalled();
    expect(saveBar()).not.toBeInTheDocument();
  });

  it('keeps the input and explains a rejected subnet', async () => {
    m.createSubnet.mockRejectedValue(new Error('Subnet 192.168.100.0/24 is already configured'));
    const user = renderView();
    await screen.findByRole('list', { name: 'Scan subnets' });

    await user.type(screen.getByLabelText('Subnet (CIDR)'), '192.168.100');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'error', 'Error', 'Saving the subnet failed: Subnet 192.168.100.0/24 is already configured',
    ));
    expect(screen.getByLabelText('Subnet (CIDR)')).toHaveValue('192.168.100');
  });

  it('pauses and removes subnets', async () => {
    const user = renderView();
    await screen.findByRole('list', { name: 'Scan subnets' });

    await user.click(screen.getByLabelText('Scan 192.168.110.0/24'));
    expect(m.updateSubnet).toHaveBeenCalledWith(2, { is_enabled: false });
    expect(screen.getByLabelText('Scan 192.168.110.0/24')).not.toBeChecked();
    expect(within(subnetList()).getByText(/paused/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove 192.168.100.0/24' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Remove 192.168.100.0/24?'));
    expect(m.deleteSubnet).toHaveBeenCalledWith(1);
  });

  it('does not remove a subnet without confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = renderView();
    await screen.findByRole('list', { name: 'Scan subnets' });

    await user.click(screen.getByRole('button', { name: 'Remove 192.168.100.0/24' }));
    expect(m.deleteSubnet).not.toHaveBeenCalled();
  });

  it('offers detected physical networks that are not scanned yet', async () => {
    const user = renderView();
    const offered = await screen.findByRole('list', { name: 'Detected on this host but not scanned' });

    expect(within(offered).getByText('192.168.130.0/24')).toBeInTheDocument();
    expect(within(offered).queryByText('192.168.100.0/24')).not.toBeInTheDocument();
    expect(within(offered).queryByText('172.17.0.0/16')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add 192.168.130.0/24 as scan subnet' }));
    expect(m.createSubnet).toHaveBeenCalledWith({ cidr: '192.168.130.0/24', name: 'eth1' });
  });

  it('says which networks are scanned while none is configured', async () => {
    m.getSubnetsList.mockResolvedValue([]);
    renderView();
    expect(await screen.findByText(
      "No scan subnets yet. Until you add one, the container's own networks are scanned: 192.168.100.0/24, 192.168.130.0/24.",
    )).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Scan subnets' })).not.toBeInTheDocument();
  });
});
