import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api/client';
import { AgentsView } from './AgentsView';

vi.mock('../Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../MobileHeader', () => ({ MobileHeader: () => null }));
vi.mock('../../api/client', () => ({
  api: {
    getAgentsOverview: vi.fn(),
    adoptAgent: vi.fn(),
    getGlobalMetrics: vi.fn(),
    getAgentMetrics: vi.fn(),
    queryAgentPatches: vi.fn(),
    prepareAgentPatch: vi.fn(),
    getSshKeys: vi.fn(),
  },
}));

const m = vi.mocked(api);

function agent(over: Record<string, unknown> = {}) {
  return {
    device_id: 1, hostname: 'proxmox', ip: '10.0.0.10', is_online: true, agent_version: '0.3.5',
    os_pretty: 'Debian GNU/Linux 12', last_seen: null, cpu_usage: 42.04, ram_usage: 91.2, temp: 50,
    uptime_pct: 93.3, uptime_history: [100, 50, 0, -1], metrics_count: 10,
    patch_available: 0, patch_security: 0, patch_manager: 'apt', reboot_required: false, major_upgrade_available: null,
    ...over,
  };
}

function overview(agents: ReturnType<typeof agent>[]) {
  return { agents, total_agents: agents.length, active_agents: 1, total_data_points: 12345, avg_cpu: 81.25, avg_ram: 40, };
}

const snapshot = (cpu: number, ts: string, disk = [{ path: '/', percent: 80, used_gb: 40, total_gb: 50 }]) =>
  ({ cpu_percent: cpu, ram: { percent: 50 }, temperature: 45, timestamp: ts, disk });

interface FakeWs { url: string; onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number }) => void; onerror?: () => void }
let sockets: FakeWs[];

beforeEach(() => {
  vi.clearAllMocks();
  sockets = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('WebSocket', class { url: string; constructor(url: string) { this.url = url; sockets.push(this as unknown as FakeWs); } close() {} });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  m.getAgentMetrics.mockResolvedValue({ snapshots: [snapshot(10, '2026-10-10T10:00:00Z'), snapshot(30, '2026-10-10T11:00:00Z')], available_ranges: ['6h', '24h', '7d'], retention_days: 30 } as never);
  m.getSshKeys.mockResolvedValue([] as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderView(agents = [agent()]) {
  m.getAgentsOverview.mockResolvedValue(overview(agents) as never);
  const user = userEvent.setup();
  render(<AgentsView />);
  await screen.findByText(agents[0].hostname as string);
  return { user };
}

function row(name: string) {
  return screen.getByText(name, { selector: '.agent-row__name' }).closest('li') as HTMLElement;
}

describe('AgentsView list', () => {
  it('shows the totals and one row per agent', async () => {
    await renderView([
      agent({ patch_available: 5, patch_security: 2, reboot_required: true, major_upgrade_available: 'Debian 13' }),
      agent({ device_id: 2, hostname: 'pihole', ip: '10.0.0.13', is_online: false, os_pretty: null, os_name: 'Raspbian', os_version: '12', uptime_pct: 70, agent_version: null }),
    ]);

    expect(screen.getByText('2 agents in your network')).toBeInTheDocument();
    expect(screen.getByText('81.3 %').closest('.stat-card')).toHaveTextContent('Avg CPU');
    expect(screen.getByText(/^12[.,\s ]345$/)).toBeInTheDocument();

    const prox = row('proxmox');
    expect(prox).toHaveTextContent('10.0.0.10 · v0.3.5');
    expect(prox).toHaveTextContent('Debian GNU/Linux 12');
    expect(within(prox).getByTitle('5 updates, 2 of them security updates')).toHaveClass('device-tag--danger');
    expect(prox).toHaveTextContent('Reboot');
    expect(prox).toHaveTextContent('Debian 13');
    expect(prox).toHaveTextContent('Connected');
    expect(within(prox).getByText('91.2 %').closest('.agent-meter')).toHaveClass('is-danger');
    expect(within(prox).getByText('42.0 %').closest('.agent-meter')).not.toHaveClass('is-warn');
    expect(within(prox).getByText('93.3 %')).toHaveClass('is-warn');
    expect(prox.querySelectorAll('.uptime-bars__bar.is-up, .uptime-bars__bar.is-partial, .uptime-bars__bar.is-down')).toHaveLength(3);
    expect(prox).toHaveTextContent('Never');

    const pi = row('pihole');
    expect(pi).toHaveTextContent('10.0.0.13 · v0.0.0');
    expect(pi).toHaveTextContent('Raspbian 12');
    expect(pi).toHaveTextContent('Disconnected');
    expect(within(pi).getByText('70.0 %')).toHaveClass('is-danger');
  });

  it('filters by name or IP', async () => {
    const { user } = await renderView([agent(), agent({ device_id: 2, hostname: 'pihole', ip: '10.0.0.13' })]);

    await user.type(screen.getByRole('searchbox'), '0.13');
    expect(screen.queryByText('proxmox')).not.toBeInTheDocument();
    expect(screen.getByText('pihole')).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'nothing');
    expect(screen.getByText('No agents found.')).toBeInTheDocument();
  });

  it('reloads on demand', async () => {
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(m.getAgentsOverview).toHaveBeenCalledTimes(2));
  });

  it('adopts a new agent key after confirmation', async () => {
    m.adoptAgent.mockResolvedValue({ status: 'ok' });
    const { user } = await renderView([agent({ has_pending_token: true })]);

    expect(screen.getByText(/reports a new key/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Adopt' }));

    await waitFor(() => expect(m.adoptAgent).toHaveBeenCalledWith(1));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Agent successfully adopted!'));
  });

  it('shows the global analytics and closes them with Escape', async () => {
    m.getGlobalMetrics.mockResolvedValue({ history: [
      { avg_cpu: 10, avg_ram: 20, data_points: 3, timestamp: '2026-10-10T10:00:00Z' },
      { avg_cpu: 30, avg_ram: 40, data_points: 7, timestamp: '2026-10-10T10:15:00Z' },
    ] } as never);
    const { user } = await renderView();

    await user.click(screen.getByRole('button', { name: /Global analytics/ }));
    const dialog = await screen.findByRole('dialog', { name: /Global analytics/ });
    await waitFor(() => expect(dialog).toHaveTextContent('Avg. CPU20.0 %'));
    expect(dialog).toHaveTextContent('Avg. RAM30.0 %');
    expect(dialog).toHaveTextContent('Peak samples7');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says when there is no global history yet', async () => {
    m.getGlobalMetrics.mockResolvedValue({ history: [] } as never);
    const { user } = await renderView();
    await user.click(screen.getByRole('button', { name: /Global analytics/ }));
    expect(await screen.findByText('No samples yet.')).toBeInTheDocument();
  });
});

describe('AgentsView detail: telemetry', () => {
  it('loads the 24h history, offers the ranges the server keeps and lists the disks', async () => {
    const { user } = await renderView([agent({ device_id: 11 })]);

    await user.click(screen.getByRole('button', { expanded: false }));

    const detail = await screen.findByText('Timeframe').then((h) => h.closest('.agent-detail') as HTMLElement);
    expect(m.getAgentMetrics).toHaveBeenCalledWith(11, undefined, '24h');
    expect(detail).toHaveTextContent('retention: 30 days');
    expect(within(detail).getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual(['6h', '7d']);
    expect(within(detail).getByText('Min 10.0%')).toBeInTheDocument();
    expect(within(detail).getByText('Max 30.0%')).toBeInTheDocument();
    expect(within(detail).getByText('80 %')).toHaveClass('is-warn');
    expect(detail).toHaveTextContent('40.0 GB of 50.0 GB used');

    await user.click(within(detail).getByRole('button', { name: '7d' }));
    await waitFor(() => expect(m.getAgentMetrics).toHaveBeenLastCalledWith(11, undefined, '7d'));
  });

  it('falls back to the longest kept range and explains empty data', async () => {
    m.getAgentMetrics.mockResolvedValue({ snapshots: [], available_ranges: ['6h'], retention_days: 1 } as never);
    const { user } = await renderView([agent({ device_id: 12 })]);

    await user.click(screen.getByRole('button', { expanded: false }));

    await waitFor(() => expect(m.getAgentMetrics).toHaveBeenLastCalledWith(12, undefined, '6h'));
    expect(await screen.findAllByText('No samples in the selected timeframe yet.')).toHaveLength(3);
    expect(screen.getByText('The agent reports no disks.')).toBeInTheDocument();
  });
});

describe('AgentsView detail: updates', () => {
  async function openUpdates(over: Record<string, unknown>) {
    const view = await renderView([agent(over)]);
    await view.user.click(screen.getByRole('button', { expanded: false }));
    await view.user.click(await screen.findByRole('tab', { name: /Updates/ }));
    return view;
  }

  it('explains when the agent has no supported package manager', async () => {
    await openUpdates({ device_id: 21, patch_manager: null });
    expect(screen.getByText('Updates not supported')).toBeInTheDocument();
  });

  it('fetches the package list over SSH and remembers the credentials until reload', async () => {
    m.queryAgentPatches.mockResolvedValue({ packages: [{ package: 'openssl', current_version: '3.0.1', new_version: '3.0.2' }], major_upgrade_available: 'Debian 13', patch_manager: 'apt' } as never);
    const { user } = await openUpdates({ device_id: 22, patch_available: 1, patch_security: 1, reboot_required: true });

    expect(screen.getByText('A reboot is required to apply earlier updates.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Username'));
    await user.type(screen.getByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Fetch update list' }));

    await waitFor(() => expect(m.queryAgentPatches).toHaveBeenCalledWith(22, { ssh_user: 'admin', ssh_password: 'pw', ssh_key: undefined, ssh_port: 22 }));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('openssl').closest('tr')).toHaveTextContent('openssl3.0.13.0.2Unknown');
    expect(screen.getByText(/New major release available: Debian 13/)).toBeInTheDocument();
    expect(screen.getByText('SSH: admin on port 22')).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();

    // collapse and open again: the remembered credentials skip the form
    await user.click(screen.getByRole('button', { expanded: true }));
    await user.click(screen.getByRole('button', { expanded: false }));
    await user.click(await screen.findByRole('tab', { name: /Updates/ }));
    expect(screen.getByText('SSH: admin on port 22')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change credentials' }));
    expect(screen.getByLabelText('Password')).toHaveValue('pw');
  });

  it('switches to a private key', async () => {
    m.queryAgentPatches.mockResolvedValue({ packages: [], major_upgrade_available: null, patch_manager: 'apt' } as never);
    const { user } = await openUpdates({ device_id: 23, patch_available: 2 });

    await user.selectOptions(screen.getByLabelText('Authentication'), 'key');
    await user.type(screen.getByLabelText('Private key'), 'KEY');
    await user.click(screen.getByLabelText('Remember credentials until reload'));
    await user.click(screen.getByRole('button', { name: 'Fetch update list' }));

    await waitFor(() => expect(m.queryAgentPatches).toHaveBeenCalledWith(23, { ssh_user: 'root', ssh_password: undefined, ssh_key: 'KEY', ssh_port: 22 }));
    expect(screen.queryByRole('button', { name: 'Security only' })).not.toBeInTheDocument();
  });

  it('switches to a stored SSH key from the vault', async () => {
    m.getSshKeys.mockResolvedValue([
      { id: 42, name: 'Vault Key', key_type: 'ed25519', fingerprint: 'SHA256:abc', public_key: 'ssh-ed25519 ...', has_passphrase: false } as never,
    ]);
    m.queryAgentPatches.mockResolvedValue({ packages: [], major_upgrade_available: null, patch_manager: 'apt' } as never);
    const { user } = await openUpdates({ device_id: 27, patch_available: 2 });

    await user.selectOptions(screen.getByLabelText('Authentication'), 'stored_key');
    const keySelect = await screen.findByLabelText('Stored Key');
    await user.selectOptions(keySelect, '42');
    await user.click(screen.getByRole('button', { name: 'Fetch update list' }));

    await waitFor(() => expect(m.queryAgentPatches).toHaveBeenCalledWith(27, {
      ssh_user: 'root',
      ssh_password: undefined,
      ssh_key: undefined,
      ssh_port: 22,
      key_id: 42,
      key_passphrase: undefined,
    }));
  });

  it('reports a failed update check', async () => {
    m.queryAgentPatches.mockResolvedValue({ packages: [], major_upgrade_available: null, patch_manager: 'apt', error: 'sudo: password required' } as never);
    const { user } = await openUpdates({ device_id: 24 });
    await user.click(screen.getByRole('button', { name: 'Fetch update list' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Update check failed: sudo: password required'));
    expect(screen.getByRole('button', { name: 'Upgrade all' })).toBeDisabled();
  });

  it('runs the security updates over the patch socket and streams the output', async () => {
    m.prepareAgentPatch.mockResolvedValue({ patch_token: 'ptk' });
    const { user } = await openUpdates({ device_id: 25, patch_available: 3, patch_security: 1 });
    await user.type(screen.getByLabelText('Password'), 'pw');

    await user.click(screen.getByRole('button', { name: 'Security only' }));

    await waitFor(() => expect(m.prepareAgentPatch).toHaveBeenCalledWith(25, { ssh_user: 'root', ssh_password: 'pw', ssh_key: undefined, ssh_port: 22, mode: 'security-only' }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toMatch(/\/api\/agent\/patches\/25\/run-ws\?patch_token=ptk&token=/);

    act(() => sockets[0].onopen!());
    act(() => sockets[0].onmessage!({ data: 'Unpacking openssl...\n' }));
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('Requesting update token');
    expect(log).toHaveTextContent('Unpacking openssl...');
    expect(screen.queryByRole('button', { name: 'Upgrade all' })).not.toBeInTheDocument();

    // the running update keeps its output while the telemetry tab is looked at
    await user.click(screen.getByRole('tab', { name: 'Telemetry' }));
    await user.click(screen.getByRole('tab', { name: /Updates/ }));
    expect(screen.getByRole('log')).toHaveTextContent('Unpacking openssl...');

    m.getAgentsOverview.mockClear();
    act(() => sockets[0].onclose!({ code: 1000 }));
    expect(screen.getByRole('log')).toHaveTextContent('Update process terminated (code: 1000)');
    expect(m.getAgentsOverview).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clear output' }));
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
  });

  it('shows why the patch run could not start', async () => {
    m.prepareAgentPatch.mockRejectedValue(new Error('SSH login failed'));
    const { user } = await openUpdates({ device_id: 26, patch_available: 3 });

    await user.click(screen.getByRole('button', { name: 'Upgrade all' }));

    expect(await screen.findByRole('log')).toHaveTextContent('[Local] Error: SSH login failed');
    expect(m.prepareAgentPatch).toHaveBeenCalledWith(26, expect.objectContaining({ mode: 'upgrade' }));
  });
});
