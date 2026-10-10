import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, SshKey, SshProfile } from '../../types';
import { api } from '../../api/client';
import { ConnectDialog, ProfileDialog } from './SshDialogs';

vi.mock('../../api/client', () => ({
  api: {
    createSshProfile: vi.fn(),
    updateSshProfile: vi.fn(),
  },
}));

const createSshProfile = vi.mocked(api.createSshProfile);
const updateSshProfile = vi.mocked(api.updateSshProfile);

const nas = { id: 7, ip: '192.168.1.7', display_name: 'nas', hostname: null } as unknown as Device;
const key = (id: number, name: string) => ({ id, name, key_type: 'ed25519' }) as unknown as SshKey;

beforeEach(() => {
  createSshProfile.mockReset();
  updateSshProfile.mockReset();
});

describe('ConnectDialog', () => {
  it('connects once to a free host with a password', async () => {
    const onConnect = vi.fn();
    render(<ConnectDialog device={null} keys={[]} onClose={vi.fn()} onConnect={onConnect} onProfileSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Host / IP'), ' 10.0.0.5 ');
    await user.clear(screen.getByLabelText('User'));
    await user.type(screen.getByLabelText('User'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(onConnect).toHaveBeenCalledWith(
      { device_id: undefined, host: '10.0.0.5', port: 22, username: 'admin', password: 'pw' },
      'admin@10.0.0.5',
    );
    expect(createSshProfile).not.toHaveBeenCalled();
  });

  it('preselects the only key and connects to the device', async () => {
    const onConnect = vi.fn();
    render(<ConnectDialog device={nas} keys={[key(3, 'main')]} onClose={vi.fn()} onConnect={onConnect} onProfileSaved={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect' }));

    expect(onConnect).toHaveBeenCalledWith(
      { device_id: 7, host: undefined, port: 22, username: 'root', key_id: 3 },
      'root@nas',
    );
  });

  it('asks for a key when key login has none chosen', () => {
    const onConnect = vi.fn();
    const { container } = render(
      <ConnectDialog device={nas} keys={[key(1, 'a'), key(2, 'b')]} onClose={vi.fn()} onConnect={onConnect} onProfileSaved={vi.fn()} />,
    );

    fireEvent.submit(container.ownerDocument.querySelector('form')!);

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a key');
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('saves an "ask" profile and connects through it with the typed password', async () => {
    createSshProfile.mockResolvedValue({ id: 42, name: 'nas' } as SshProfile);
    const onConnect = vi.fn();
    const onProfileSaved = vi.fn();
    render(<ConnectDialog device={nas} keys={[]} onClose={vi.fn()} onConnect={onConnect} onProfileSaved={onProfileSaved} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByLabelText('Save as connection'));
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onConnect).toHaveBeenCalled());
    expect(createSshProfile).toHaveBeenCalledWith({
      name: 'nas',
      device_id: 7,
      host: null,
      port: 22,
      username: 'root',
      auth_method: 'ask',
      key_id: null,
      password: undefined,
    });
    expect(onProfileSaved).toHaveBeenCalled();
    expect(onConnect).toHaveBeenCalledWith({ profile_id: 42, password: 'pw' }, 'nas');
  });

  it('stores the password when asked to', async () => {
    createSshProfile.mockResolvedValue({ id: 5, name: 'box' } as SshProfile);
    const onConnect = vi.fn();
    render(<ConnectDialog device={null} keys={[]} onClose={vi.fn()} onConnect={onConnect} onProfileSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Host / IP'), 'box.lan');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByLabelText('Save as connection'));
    await user.type(screen.getByLabelText('Name'), 'box');
    await user.click(screen.getByLabelText(/Store password encrypted/));
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledWith({ profile_id: 5, password: undefined }, 'box'));
    expect(createSshProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'box', host: 'box.lan', device_id: null, auth_method: 'password', password: 'secret',
    }));
  });

  it('shows the API error and stays open', async () => {
    createSshProfile.mockRejectedValue(new Error('name taken'));
    const onConnect = vi.fn();
    render(<ConnectDialog device={nas} keys={[]} onClose={vi.fn()} onConnect={onConnect} onProfileSaved={vi.fn()} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByLabelText('Save as connection'));
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('name taken');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe('ProfileDialog', () => {
  it('creates a device profile named after the device', async () => {
    createSshProfile.mockResolvedValue({} as SshProfile);
    const onSaved = vi.fn();
    render(<ProfileDialog profile={null} devices={[nas]} keys={[]} onClose={vi.fn()} onSaved={onSaved} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Device'), '7');
    await user.click(screen.getByRole('button', { name: 'Password' }));
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createSshProfile).toHaveBeenCalledWith({
      name: 'nas',
      device_id: 7,
      host: null,
      port: 22,
      username: 'root',
      auth_method: 'password',
      key_id: null,
      password: 'pw',
    });
  });

  it('updates a host profile and leaves a stored password untouched', async () => {
    updateSshProfile.mockResolvedValue({} as SshProfile);
    const profile = {
      id: 9, name: 'router', device_id: null, host: 'router.lan', port: 2222, username: 'admin',
      auth_method: 'password', key_id: null, has_password: true,
    } as unknown as SshProfile;
    const onSaved = vi.fn();
    render(<ProfileDialog profile={profile} devices={[nas]} keys={[]} onClose={vi.fn()} onSaved={onSaved} />);

    expect(screen.getByLabelText('Password')).not.toBeRequired();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateSshProfile).toHaveBeenCalledWith(9, {
      name: 'router',
      device_id: null,
      host: 'router.lan',
      port: 2222,
      username: 'admin',
      auth_method: 'password',
      key_id: null,
    });
  });

  it('shows the hint instead of a password field for "ask every time"', async () => {
    render(<ProfileDialog profile={null} devices={[]} keys={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/asked for on every connection/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});
