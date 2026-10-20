import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../../api/client';
import type { ProxmoxSettings } from '../../../types';
import { ProxmoxSection } from './ProxmoxSection';

vi.mock('../../../api/client', () => ({ api: {
  getProxmoxSettings: vi.fn(), saveProxmoxSettings: vi.fn(), syncProxmox: vi.fn(), disconnectProxmox: vi.fn(),
} }));
const m = vi.mocked(api);
const empty: ProxmoxSettings = {
  enabled: false, url: '', token_id: '', verify_tls: true, has_token_secret: false, last_sync: null, last_error: null,
};
const configured: ProxmoxSettings = {
  ...empty, enabled: true, url: 'https://pve:8006', token_id: 'reader@pve!inventory', has_token_secret: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.getProxmoxSettings.mockResolvedValue(empty);
  m.saveProxmoxSettings.mockResolvedValue(configured);
});

describe('Proxmox settings', () => {
  it('verifies TLS by default and saves an explicit opt-out with the secret', async () => {
    const user = userEvent.setup();
    render(<ProxmoxSection />);
    const enabled = screen.getByLabelText('Enable Proxmox integration');
    await waitFor(() => expect(enabled).toBeEnabled());
    expect(screen.getByLabelText('Ignore self-signed certificates')).not.toBeChecked();
    await user.click(enabled);
    await user.type(screen.getByLabelText('Proxmox API address'), configured.url);
    await user.type(screen.getByLabelText('API token ID'), configured.token_id);
    await user.type(screen.getByLabelText('API token secret'), 'new-secret');
    await user.click(screen.getByLabelText('Ignore self-signed certificates'));
    m.saveProxmoxSettings.mockResolvedValue({ ...configured, verify_tls: false });
    await user.click(screen.getByRole('button', { name: 'Save Proxmox connection' }));
    await waitFor(() => expect(m.saveProxmoxSettings).toHaveBeenCalledWith({
      enabled: true, url: configured.url, token_id: configured.token_id, token_secret: 'new-secret', verify_tls: false,
    }));
    await waitFor(() => expect(screen.getByLabelText('API token secret')).toHaveValue(''));
    expect(screen.getByLabelText('API token secret')).toHaveAttribute('type', 'password');
  });

  it('retains a saved secret and requires saving changes before synchronizing', async () => {
    const user = userEvent.setup();
    m.getProxmoxSettings.mockResolvedValue(configured);
    render(<ProxmoxSection />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Synchronize now' })).toBeEnabled());
    expect(screen.getByLabelText('API token secret')).toHaveValue('');
    await user.click(screen.getByLabelText('Ignore self-signed certificates'));
    expect(screen.getByRole('button', { name: 'Synchronize now' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save Proxmox connection' }));
    await waitFor(() => expect(m.saveProxmoxSettings).toHaveBeenCalledWith({
      enabled: true, url: configured.url, token_id: configured.token_id, verify_tls: false,
    }));
  });

  it('shows imported, skipped and conflicting counts after a manual sync', async () => {
    const user = userEvent.setup();
    m.getProxmoxSettings.mockResolvedValue(configured);
    m.syncProxmox.mockResolvedValue({ guests: 3, addresses: 4, updated_devices: 2, skipped: 1, conflicts: 1 });
    render(<ProxmoxSection />);
    const sync = screen.getByRole('button', { name: 'Synchronize now' });
    await waitFor(() => expect(sync).toBeEnabled());
    await user.click(sync);
    expect(await screen.findByText(/Imported 4 addresses from 3 guests/)).toHaveTextContent('Skipped guests: 1. Conflicting addresses: 1.');
    expect(m.syncProxmox).toHaveBeenCalledOnce();
  });

  it('shows connection failures and allows retrying', async () => {
    const user = userEvent.setup();
    m.getProxmoxSettings.mockResolvedValue(configured);
    m.syncProxmox.mockRejectedValue(new Error('Check the TLS certificate.'));
    render(<ProxmoxSection />);
    const sync = screen.getByRole('button', { name: 'Synchronize now' });
    await waitFor(() => expect(sync).toBeEnabled());
    await user.click(sync);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the TLS certificate.');
    expect(sync).toBeEnabled();
  });

  it('removes saved credentials on disconnect', async () => {
    const user = userEvent.setup();
    m.getProxmoxSettings.mockResolvedValue(configured);
    m.disconnectProxmox.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ProxmoxSection />);
    const button = screen.getByRole('button', { name: 'Disconnect' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByText('Proxmox connection removed.')).toBeInTheDocument();
    expect(m.disconnectProxmox).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Proxmox API address')).toHaveValue('');
    confirm.mockRestore();
  });
});
