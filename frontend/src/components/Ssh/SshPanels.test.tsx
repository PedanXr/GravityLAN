import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SshKey } from '../../types';
import { api } from '../../api/client';
import { copyText } from '../Agents/ManualInstallCommand';
import { KeysPanel } from './SshPanels';

const showToast = vi.fn();

vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../Agents/ManualInstallCommand', () => ({ copyText: vi.fn(async () => true) }));
vi.mock('../../api/client', () => ({
  api: { createSshKey: vi.fn(), generateSshKey: vi.fn(), deleteSshKey: vi.fn(), deleteSshKnownHost: vi.fn() },
}));

const m = vi.mocked(api);

const keys = [
  { id: 1, name: 'Homelab', key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc', public_key: 'ssh-ed25519 AAAA homelab', has_passphrase: true, last_used_at: null },
] as unknown as SshKey[];

function renderPanel(list = keys) {
  const onChanged = vi.fn();
  render(<KeysPanel keys={list} status={{ vault_key_source: 'env' } as never} onChanged={onChanged} />);
  return { onChanged, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('KeysPanel', () => {
  it('lists stored keys and where the vault key comes from', () => {
    renderPanel();
    expect(screen.getByText(/environment variable GRAVITYLAN_VAULT_KEY/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stored keys (1)' })).toBeInTheDocument();
    const row = screen.getByText('Homelab').closest('li') as HTMLElement;
    expect(row).toHaveTextContent('ssh-ed25519');
    expect(row).toHaveTextContent('Passphrase');
    expect(row).toHaveTextContent('SHA256:abc');
    expect(row).toHaveTextContent('Last used: –');
  });

  it('shows the empty list and the file vault hint', () => {
    render(<KeysPanel keys={[]} status={null} onChanged={vi.fn()} />);
    expect(screen.getByText('No keys stored yet.')).toBeInTheDocument();
    expect(screen.getByText(/data\/ssh_vault.key/)).toBeInTheDocument();
  });

  it('imports a pasted key with passphrase', async () => {
    m.createSshKey.mockResolvedValue({} as never);
    const { onChanged, user } = renderPanel();

    await user.type(screen.getByLabelText('Name'), ' nas ');
    await user.type(screen.getByLabelText('Private key'), 'PEM');
    await user.type(screen.getByLabelText('Passphrase (optional)'), 'pp');
    await user.click(screen.getByRole('button', { name: /Store key/ }));

    await waitFor(() => expect(m.createSshKey).toHaveBeenCalledWith({ name: 'nas', private_key: 'PEM', passphrase: 'pp' }));
    expect(showToast).toHaveBeenCalledWith('success', 'SSH keys', 'Key “nas” stored.');
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Private key')).toHaveValue('');
  });

  it('reads a key file and names the key after it unless a name was typed', async () => {
    const { user } = renderPanel();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;

    await user.upload(input, new File(['FILEKEY'], 'id_nas.ppk'));
    await waitFor(() => expect(screen.getByLabelText('Private key')).toHaveValue('FILEKEY'));
    expect(screen.getByLabelText('Name')).toHaveValue('id_nas');

    await user.upload(input, new File(['OTHER'], 'second.pem'));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('second'));

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'mine');
    await user.upload(input, new File(['THIRD'], 'third.key'));
    await waitFor(() => expect(screen.getByLabelText('Private key')).toHaveValue('THIRD'));
    expect(screen.getByLabelText('Name')).toHaveValue('mine');
  });

  it('refuses a key file that is too large', async () => {
    const { user } = renderPanel();
    await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, new File(['x'.repeat(20000)], 'big.pem'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The file is too large for a private key.');
  });

  it('shows the error of a failed import', async () => {
    m.createSshKey.mockRejectedValue(new Error('not a private key'));
    const { onChanged, user } = renderPanel();
    await user.type(screen.getByLabelText('Name'), 'x');
    await user.type(screen.getByLabelText('Private key'), 'junk');
    await user.click(screen.getByRole('button', { name: /Store key/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a private key');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('generates a key and offers its public half', async () => {
    m.generateSshKey.mockResolvedValue({ id: 9, name: 'gen', public_key: 'ssh-ed25519 BBBB gen' } as never);
    const { onChanged, user } = renderPanel();

    await user.click(screen.getByRole('button', { name: /Generate$/ }));
    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'gen');
    await user.click(screen.getByRole('button', { name: /Generate key/ }));

    await waitFor(() => expect(m.generateSshKey).toHaveBeenCalledWith('gen'));
    expect(onChanged).toHaveBeenCalled();
    const box = screen.getByText('“gen” was generated').closest('.callout') as HTMLElement;
    expect(box).toHaveTextContent('ssh-ed25519 BBBB gen');
    await user.click(within(box).getByRole('button', { name: /Copy public key/ }));
    expect(copyText).toHaveBeenCalledWith('ssh-ed25519 BBBB gen');
    expect(showToast).toHaveBeenCalledWith('success', 'Public key', 'Copied to clipboard.');
  });

  it('copies and deletes stored keys', async () => {
    m.deleteSshKey.mockResolvedValue({ status: 'ok' } as never);
    const { onChanged, user } = renderPanel();
    const row = screen.getByText('Homelab').closest('li') as HTMLElement;

    await user.click(within(row).getByRole('button', { name: 'Copy public key' }));
    expect(copyText).toHaveBeenCalledWith('ssh-ed25519 AAAA homelab');

    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(m.deleteSshKey).toHaveBeenCalledWith(1));
    expect(window.confirm).toHaveBeenCalledWith('Delete key “Homelab”? Connections using it will stop working.');
    expect(onChanged).toHaveBeenCalled();
  });
});
