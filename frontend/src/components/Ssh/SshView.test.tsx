import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Device, SshHistoryEntry, SshKey, SshProfile, SshSessionRequest } from '../../types';
import { api } from '../../api/client';
import { setLiveSshSessions } from './sessionCount';
import type { TerminalStatus } from './TerminalPane';
import { SshView } from './SshView';
import { agentUpdateFor } from './view/sshModel';

const showToast = vi.fn();
const panes: { request: SshSessionRequest; active: boolean; onStatusChange: (s: TerminalStatus) => void }[] = [];

vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('./sessionCount', () => ({ setLiveSshSessions: vi.fn() }));
vi.mock('./TerminalPane', () => ({
  TerminalPane: (p: { request: SshSessionRequest; active: boolean; onStatusChange: (s: TerminalStatus) => void; agentUpdate?: object | null }) => {
    panes.push(p);
    return (
      <div data-testid="pane" data-active={String(p.active)} data-update={JSON.stringify(p.agentUpdate ?? null)}>
        {JSON.stringify(p.request)}
      </div>
    );
  },
}));
vi.mock('./SshPanels', () => ({
  KeysPanel: ({ keys }: { keys: SshKey[] }) => <div>keys panel ({keys.length})</div>,
  KnownHostsPanel: () => <div>known hosts panel</div>,
}));
vi.mock('./SshDialogs', () => ({
  deviceLabel: (d: Device) => d.display_name || d.hostname || d.ip,
  ConnectDialog: (p: { device: Device | null; initial?: object; onConnect: (r: SshSessionRequest, l: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="connect">
      <span>connect to {p.device ? p.device.display_name : 'any host'}</span>
      <span>initial {JSON.stringify(p.initial ?? null)}</span>
      <button onClick={() => p.onConnect({ device_id: p.device?.id, host: 'h', username: 'u', password: 'x' }, 'u@h')}>dialog connect</button>
      <button onClick={p.onClose}>dialog close</button>
    </div>
  ),
  ProfileDialog: (p: { profile: SshProfile | null; initial?: object; onSaved: () => void; onClose: () => void }) => (
    <div role="dialog" aria-label="profile">
      <span>profile {p.profile ? p.profile.name : 'new'}</span>
      <span>initial {JSON.stringify(p.initial ?? null)}</span>
      <button onClick={p.onSaved}>dialog save</button>
    </div>
  ),
  PasswordPrompt: (p: { profile: SshProfile; onConnect: (pw: string) => void }) => (
    <div role="dialog" aria-label="password">
      <button onClick={() => p.onConnect('secret')}>prompt connect {p.profile.name}</button>
    </div>
  ),
}));
vi.mock('../../api/client', () => ({
  api: {
    getDevices: vi.fn(),
    getSshKeys: vi.fn(),
    getSshProfiles: vi.fn(),
    getSshKnownHosts: vi.fn(),
    getSshHistory: vi.fn(),
    getSshStatus: vi.fn(),
    deleteSshHistory: vi.fn(),
    deleteSshProfile: vi.fn(),
  },
}));

const m = vi.mocked(api);

const devices = [
  { id: 1, display_name: 'Unraid', ip: '10.0.0.11', is_online: false, services: [{ protocol: 'ssh', port: 22 }] },
  {
    id: 2, display_name: 'Proxmox', ip: '10.0.0.10', is_online: true, services: [{ protocol: 'tcp', port: 22 }],
    has_agent: true, agent_info: { agent_version: '0.3.5', latest_version: '0.3.7' },
  },
  { id: 3, display_name: 'Printer', ip: '10.0.0.50', is_online: true, services: [{ protocol: 'http', port: 80 }] },
  { id: 4, display_name: 'Hidden', ip: '10.0.0.99', is_online: true, is_hidden: true, services: [{ protocol: 'ssh', port: 22 }] },
] as unknown as Device[];

const profiles = [
  { id: 10, name: 'Proxmox root', username: 'root', target_host: '10.0.0.10', port: 22, auth_method: 'key', key_name: 'Homelab', device_id: 2, device_name: 'Proxmox' },
  { id: 11, name: 'Router', username: 'admin', target_host: 'router.lan', port: 2222, auth_method: 'ask', device_id: null },
] as unknown as SshProfile[];

const history = [
  { id: 20, label: 'root@nas', target_host: '10.0.0.12', port: 22, username: 'root', auth_method: 'key', key_id: 1, key_name: 'Homelab', device_id: null, host: '10.0.0.12' },
  { id: 21, label: 'pi@pihole', target_host: '10.0.0.13', port: 2200, username: 'pi', auth_method: 'password', key_id: null, device_id: 1, device_name: 'Unraid', host: null },
] as unknown as SshHistoryEntry[];

const keys = [{ id: 1, name: 'Homelab', key_type: 'ed25519' }] as unknown as SshKey[];

async function renderView(path = '/ssh', visible = true) {
  const user = userEvent.setup();
  const view = render(<MemoryRouter initialEntries={[path]}><SshView visible={visible} /></MemoryRouter>);
  await screen.findByText('Proxmox root');
  return { user, ...view };
}

const group = (title: string) => screen.getByRole('heading', { name: title }).closest('.ssh-targets__group') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  panes.length = 0;
  m.getDevices.mockResolvedValue(devices);
  m.getSshKeys.mockResolvedValue(keys);
  m.getSshProfiles.mockResolvedValue(profiles);
  m.getSshKnownHosts.mockResolvedValue([]);
  m.getSshHistory.mockResolvedValue(history);
  m.getSshStatus.mockResolvedValue({} as never);
  m.deleteSshHistory.mockResolvedValue({ status: 'ok' });
  m.deleteSshProfile.mockResolvedValue({ status: 'ok' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('SshView targets', () => {
  it('lists saved connections, recent connections and SSH devices', async () => {
    await renderView();

    const saved = group('Saved connections');
    expect(within(saved).getByText('root@10.0.0.10')).toBeInTheDocument();
    expect(within(saved).getByText('admin@router.lan:2222')).toBeInTheDocument();
    expect(within(saved).getByText('Homelab')).toBeInTheDocument();
    expect(within(saved).getByText('Ask every time')).toBeInTheDocument();

    const recent = group('Recent connections');
    expect(within(recent).getByText('10.0.0.13:2200')).toBeInTheDocument();
    expect(within(recent).getByText('Password')).toBeInTheDocument();

    const devs = group('Devices');
    expect(within(devs).getAllByText(/^(Unraid|Proxmox|Printer|Hidden)$/).map((e) => e.textContent)).toEqual(['Proxmox', 'Unraid']);
    expect(within(devs).getByText('Profile')).toBeInTheDocument();

    await userEvent.setup().click(within(devs).getByLabelText(/Include devices without/));
    expect(within(devs).getAllByText(/^(Unraid|Proxmox|Printer|Hidden)$/).map((e) => e.textContent)).toEqual(['Printer', 'Proxmox', 'Unraid']);
  });

  it('filters all lists with the search', async () => {
    const { user } = await renderView();

    await user.type(screen.getByRole('searchbox'), 'router');

    expect(within(group('Saved connections')).queryByText('Proxmox root')).not.toBeInTheDocument();
    expect(within(group('Saved connections')).getByText('Router')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent connections' })).not.toBeInTheDocument();
    expect(within(group('Devices')).getByText('No devices with an SSH service found.')).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(within(group('Saved connections')).getByText('No matches.')).toBeInTheDocument();
  });
});

describe('SshView sessions', () => {
  it('opens a key profile directly and asks for the password of an "ask" profile', async () => {
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: /Proxmox root/ }));
    expect(screen.getByRole('tab', { name: 'Proxmox root' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('pane')).toHaveTextContent('{"profile_id":10}');
    expect(screen.getByTestId('pane')).toHaveAttribute('data-active', 'true');

    await user.click(screen.getByRole('button', { name: /^Router/ }));
    await user.click(screen.getByRole('button', { name: 'prompt connect Router' }));
    expect(screen.getAllByTestId('pane')[1]).toHaveTextContent('{"profile_id":11,"password":"secret"}');
    expect(screen.getByRole('tab', { name: 'Router' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('connects to a device or any host through the connect dialog', async () => {
    const { user } = await renderView();

    await user.click(within(group('Devices')).getByRole('button', { name: /Proxmox/ }));
    expect(screen.getByRole('dialog', { name: 'connect' })).toHaveTextContent('connect to Proxmox');
    await user.click(screen.getByRole('button', { name: 'dialog connect' }));
    expect(screen.getByRole('tab', { name: 'u@h' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Other host/ }));
    expect(screen.getByRole('dialog', { name: 'connect' })).toHaveTextContent('connect to any host');
    await user.click(screen.getByRole('button', { name: 'dialog close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reconnects recent connections: with the stored key at once, else asking for the password', async () => {
    const { user } = await renderView();

    await user.click(within(group('Recent connections')).getByRole('button', { name: /root@nas/ }));
    expect(screen.getByTestId('pane')).toHaveTextContent('{"host":"10.0.0.12","port":22,"username":"root","key_id":1}');

    await user.click(within(group('Recent connections')).getByRole('button', { name: /pi@pihole/ }));
    const dialog = screen.getByRole('dialog', { name: 'connect' });
    expect(dialog).toHaveTextContent('connect to Unraid');
    expect(dialog).toHaveTextContent('initial {"host":"","port":2200,"username":"pi","auth":"password"}');
  });

  it('saves or removes a recent connection', async () => {
    const { user } = await renderView();
    const recent = group('Recent connections');

    await user.click(within(recent).getAllByRole('button', { name: 'Save as connection' })[1]);
    expect(screen.getByRole('dialog', { name: 'profile' })).toHaveTextContent(
      'initial {"name":"Unraid","device_id":1,"host":null,"port":2200,"username":"pi","auth_method":"ask","key_id":null}');
    await user.click(screen.getByRole('button', { name: 'dialog save' }));
    expect(m.getSshProfiles).toHaveBeenCalledTimes(2);

    await user.click(within(recent).getAllByRole('button', { name: 'Remove from history' })[0]);
    await waitFor(() => expect(m.deleteSshHistory).toHaveBeenCalledWith(20));
    expect(screen.queryByText('root@nas')).not.toBeInTheDocument();
  });

  it('creates, edits and deletes saved connections', async () => {
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: /^New$/ }));
    expect(screen.getByRole('dialog', { name: 'profile' })).toHaveTextContent('profile new');
    await user.click(screen.getByRole('button', { name: 'dialog save' }));

    await user.click(within(group('Saved connections')).getAllByRole('button', { name: 'Edit' })[1]);
    expect(screen.getByRole('dialog', { name: 'profile' })).toHaveTextContent('profile Router');
    expect(screen.getByRole('dialog', { name: 'profile' })).toHaveTextContent('initial null');
    await user.click(screen.getByRole('button', { name: 'dialog save' }));

    await user.click(within(group('Saved connections')).getAllByRole('button', { name: 'Delete' })[0]);
    await waitFor(() => expect(m.deleteSshProfile).toHaveBeenCalledWith(10));
    expect(window.confirm).toHaveBeenCalledWith('Delete connection “Proxmox root”?');
  });

  it('switches and closes tabs and reports live sessions', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Proxmox root/ }));
    await user.click(screen.getByRole('button', { name: /^Router/ }));
    await user.click(screen.getByRole('button', { name: 'prompt connect Router' }));
    expect(setLiveSshSessions).toHaveBeenLastCalledWith(2);

    act(() => panes.at(-1)!.onStatusChange('connected'));
    await waitFor(() => expect(m.getSshHistory).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('tab', { name: 'Router' }).querySelector('.ssh-tab__dot')).toHaveClass('is-connected');

    act(() => panes.at(-1)!.onStatusChange('closed'));
    expect(setLiveSshSessions).toHaveBeenLastCalledWith(1);

    await user.click(screen.getByRole('tab', { name: 'Proxmox root' }));
    expect(screen.getByRole('tab', { name: 'Proxmox root' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('button', { name: 'Close session Proxmox root' }));
    expect(screen.getByRole('tab', { name: 'Router' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'Close session Router' }));
    expect(screen.getByText('No open session')).toBeInTheDocument();
  });

  it('warns before a reload while sessions are live', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Proxmox root/ }));
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('offers to save an ad-hoc tab from its context menu', async () => {
    const { user } = await renderView();
    await user.click(within(group('Devices')).getByRole('button', { name: /Proxmox/ }));
    await user.click(screen.getByRole('button', { name: 'dialog connect' }));

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'u@h' }).parentElement!, { clientX: 40, clientY: 50 });
    const menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: /Save as connection/ }));
    expect(screen.getByRole('dialog', { name: 'profile' })).toHaveTextContent(
      'initial {"name":"Proxmox","device_id":2,"host":null,"port":22,"username":"u","auth_method":"ask","key_id":null}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks saved tabs in the context menu and closes from there or with Escape', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Proxmox root/ }));

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Proxmox root' }).parentElement!, { clientX: 5, clientY: 5 });
    expect(screen.getByRole('menu')).toHaveTextContent('Saved connection');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Proxmox root' }).parentElement!, { clientX: 5, clientY: 5 });
    await user.click(screen.getByRole('menuitem', { name: /Close session/ }));
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('SshView sections and links', () => {
  it('switches to keys and known hosts and keeps terminals mounted', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Proxmox root/ }));

    await user.click(screen.getByRole('button', { name: /Keys/ }));
    expect(screen.getByText('keys panel (1)')).toBeInTheDocument();
    expect(screen.getByTestId('pane')).toHaveAttribute('data-active', 'false');

    await user.click(screen.getByRole('button', { name: /Known hosts/ }));
    expect(screen.getByText('known hosts panel')).toBeInTheDocument();
    expect(m.getSshKnownHosts).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: /Terminal/ }));
    expect(screen.getByTestId('pane')).toHaveAttribute('data-active', 'true');
  });

  it('offers to add a key when there is none', async () => {
    m.getSshKeys.mockResolvedValue([]);
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Add a key/ }));
    expect(screen.getByText('keys panel (0)')).toBeInTheDocument();
  });

  it('opens the saved connection of a device linked as ?device=', async () => {
    await renderView('/ssh?device=2');
    await waitFor(() => expect(screen.getByTestId('pane')).toHaveTextContent('{"profile_id":10}'));
  });

  it('opens the connect dialog for a linked device without a saved connection', async () => {
    await renderView('/ssh?device=1');
    expect(await screen.findByRole('dialog', { name: 'connect' })).toHaveTextContent('connect to Unraid');
  });

  it('reports a failed load', async () => {
    m.getSshStatus.mockRejectedValue(new Error('backend down'));
    await renderView();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', 'SSH terminal', 'backend down'));
  });

  it('refreshes the devices when the page becomes visible again', async () => {
    const { rerender } = await renderView('/ssh', false);
    rerender(<MemoryRouter initialEntries={['/ssh']}><SshView visible /></MemoryRouter>);
    await waitFor(() => expect(m.getDevices).toHaveBeenCalledTimes(2));
  });
});

describe('SshView agent updates', () => {
  it('gives a terminal the agent update of the device it is connected to', async () => {
    const { user } = await renderView();

    // Saved connection of Proxmox (device 2, agent 0.3.5 of 0.3.7)
    const proxmox = JSON.stringify({ deviceId: 2, installed: '0.3.5', latest: '0.3.7', available: true });
    await user.click(screen.getByRole('button', { name: /Proxmox root/ }));
    expect(screen.getByTestId('pane')).toHaveAttribute('data-update', proxmox);

    // Router has no device, Unraid no agent
    await user.click(screen.getByRole('button', { name: /^Router/ }));
    await user.click(screen.getByRole('button', { name: 'prompt connect Router' }));
    await user.click(within(group('Devices')).getByRole('button', { name: /Unraid/ }));
    await user.click(screen.getByRole('button', { name: 'dialog connect' }));
    expect(screen.getAllByTestId('pane').map((p) => p.getAttribute('data-update'))).toEqual([proxmox, 'null', 'null']);
  });

  it('matches only explicit device links and marks only outdated agents as updatable', () => {
    const device = (agent_version: string | null, has_agent = true) =>
      [{ id: 5, ip: '10.0.0.5', has_agent, agent_info: { agent_version, latest_version: '0.3.7' } }] as unknown as Device[];
    const linked = [{ id: 30, device_id: 5 }] as unknown as SshProfile[];
    const agent = (installed: string, available: boolean) => ({ deviceId: 5, installed, latest: '0.3.7', available });

    expect(agentUpdateFor({ device_id: 5 }, device('0.3.6'), [])).toEqual(agent('0.3.6', true));
    expect(agentUpdateFor({ profile_id: 30 }, device('0.3.6'), linked)).toEqual(agent('0.3.6', true));
    // Up to date, or newer than the server's (never "updated" to an older one): shown, not updatable
    expect(agentUpdateFor({ device_id: 5 }, device('0.3.7'), [])).toEqual(agent('0.3.7', false));
    expect(agentUpdateFor({ device_id: 5 }, device('0.3.8'), [])).toEqual(agent('0.3.8', false));
    expect(agentUpdateFor({ device_id: 5 }, device(null), [])).toBeNull();
    expect(agentUpdateFor({ device_id: 5 }, device('0.3.6', false), [])).toBeNull();
    // A plain host is never matched to a device by its address
    expect(agentUpdateFor({ host: '10.0.0.5', username: 'root' }, device('0.3.6'), [])).toBeNull();
  });
});
