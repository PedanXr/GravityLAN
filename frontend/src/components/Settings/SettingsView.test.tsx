import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiTokenResponse, DeviceGroup } from '../../types';
import { api } from '../../api/client';
import { SettingsView } from './SettingsView';

const showToast = vi.fn();

vi.mock('../../api/client', () => ({
  api: {
    getSettings: vi.fn(), updateSettings: vi.fn(),
    getGroups: vi.fn(), createGroup: vi.fn(), deleteGroup: vi.fn(),
    getApiTokens: vi.fn(), createApiToken: vi.fn(), deleteApiToken: vi.fn(),
    exportBackup: vi.fn(), importBackup: vi.fn(), resetDatabase: vi.fn(),
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

function renderView() {
  render(<MemoryRouter><SettingsView /></MemoryRouter>);
  return userEvent.setup();
}

const saveBar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

beforeEach(() => {
  vi.clearAllMocks();
  m.getSettings.mockResolvedValue({ scan_interval: '15', scan_subnets: '10.0.0.0/24', 'system.log_level': 'debug' });
  m.updateSettings.mockResolvedValue({} as never);
  m.getGroups.mockResolvedValue(groups);
  m.createGroup.mockResolvedValue({} as never);
  m.deleteGroup.mockResolvedValue(undefined);
  m.getApiTokens.mockResolvedValue(tokens);
  m.createApiToken.mockResolvedValue({ token: 'glan_secret_token' } as never);
  m.deleteApiToken.mockResolvedValue({ status: 'ok', message: '' });
  m.exportBackup.mockResolvedValue({ devices: [] });
  m.importBackup.mockResolvedValue({} as never);
  m.resetDatabase.mockResolvedValue({ status: 'ok', message: '' });
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
    expect(screen.getByLabelText('Subnets to scan')).toHaveValue('10.0.0.0/24');
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

    m.getSettings.mockResolvedValue({ scan_interval: '15', scan_subnets: '10.0.0.0/24', 'system.log_level': 'debug', 'dns.server': '10.0.0.1' });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(m.updateSettings).toHaveBeenCalledWith({
      scan_interval: '15', quick_scan_interval: '300', scan_subnets: '10.0.0.0/24', scan_timeout: '1.5',
      'scanner.offline_threshold': '3', 'dns.server': '10.0.0.1', history_retention_days: '7',
      server_url_override: '', 'system.log_level': 'debug',
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
