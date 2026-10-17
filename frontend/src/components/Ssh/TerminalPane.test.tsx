import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, createSshTerminalSocket } from '../../api/client';
import { buildInstallCommand, copyText } from '../Agents/ManualInstallCommand';
import { TerminalPane, type AgentUpdate } from './TerminalPane';

// --- fakes ------------------------------------------------------------------------

interface FakeLine { text: string; isWrapped: boolean }

class FakeTerminal {
  static last: FakeTerminal;
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  keyHandler: (e: KeyboardEvent) => boolean = () => true;
  dataCb: (d: string) => void = () => {};
  lines: FakeLine[] = [];
  cursorY = 0;
  marker: { line: number; isDisposed: boolean; dispose: () => void } | null = null;
  write = vi.fn();
  writeln = vi.fn();
  focus = vi.fn();
  paste = vi.fn();
  dispose = vi.fn();
  getSelection = vi.fn(() => '');
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    FakeTerminal.last = this;
  }
  loadAddon() {}
  open() {}
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
  attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) { this.keyHandler = h; }
  onData(cb: (d: string) => void) { this.dataCb = cb; return { dispose() {} }; }
  onBinary() { return { dispose() {} }; }
  registerMarker() {
    this.marker = { line: this.cursorY, isDisposed: false, dispose() { this.isDisposed = true; } };
    return this.marker;
  }
  get buffer() {
    const lines = this.lines;
    return {
      active: {
        baseY: 0,
        cursorY: this.cursorY,
        getLine: (i: number) => lines[i] && {
          isWrapped: lines[i].isWrapped,
          translateToString: (trimRight?: boolean) => (trimRight ? lines[i].text.replace(/\s+$/, '') : lines[i].text),
        },
      },
    };
  }
}

// FakeTerminal is only looked up when a terminal is constructed, after this module ran.
vi.mock('@xterm/xterm', () => ({
  Terminal: class { constructor(opts: Record<string, unknown>) { return new FakeTerminal(opts); } },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { proposeDimensions() { return { cols: 102, rows: 30 }; } },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('./TerminalSettings', () => ({ TerminalSettings: () => <div>appearance panel</div> }));
vi.mock('./terminalPrefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminalPrefs')>()),
  loadTerminalFont: vi.fn(() => Promise.resolve()),
}));
vi.mock('../Agents/ManualInstallCommand', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../Agents/ManualInstallCommand')>()),
  copyText: vi.fn(async () => true),
}));
vi.mock('../../api/client', () => ({
  api: { prepareSshSession: vi.fn(), createAgentEnrollment: vi.fn() },
  createSshTerminalSocket: vi.fn(),
}));
const showToast = vi.fn();
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
}

let sockets: FakeSocket[];

function socket(): FakeSocket {
  return sockets[sockets.length - 1];
}

function serverSays(msg: object) {
  act(() => socket().onmessage!({ data: JSON.stringify(msg) }));
}

const request = { profile_id: 3 };

async function renderPane(agentUpdate?: AgentUpdate) {
  const onStatusChange = vi.fn();
  const user = userEvent.setup();
  render(<TerminalPane request={request} active onStatusChange={onStatusChange} agentUpdate={agentUpdate} />);
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  act(() => socket().onopen?.());
  return { onStatusChange, user, term: FakeTerminal.last };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sockets = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(api.prepareSshSession).mockResolvedValue({ ticket: 'tk', label: 'x', expires_in: 30 });
  vi.mocked(createSshTerminalSocket).mockImplementation(() => {
    const ws: FakeSocket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null };
    sockets.push(ws);
    return ws as unknown as WebSocket;
  });
});

describe('TerminalPane connection', () => {
  it('prepares a ticket, opens the socket with the fitted size and reports the stages', async () => {
    const { onStatusChange } = await renderPane();

    expect(api.prepareSshSession).toHaveBeenCalledWith(request);
    // jsdom has no layout, so the pane is never fitted and keeps xterm's 80x24
    expect(createSshTerminalSocket).toHaveBeenCalledWith('tk', 80, 24);
    expect(screen.getByRole('status')).toHaveTextContent('Connecting…');

    serverSays({ type: 'status', stage: 'authenticating' });
    expect(screen.getByRole('status')).toHaveTextContent('Logging in…');

    serverSays({ type: 'status', stage: 'connected' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onStatusChange.mock.calls.map(([s]) => s)).toEqual(['connecting', 'authenticating', 'connected']);
  });

  it('writes binary output to the terminal', async () => {
    const { term } = await renderPane();
    const bytes = new Uint8Array([104, 105]).buffer;
    act(() => socket().onmessage!({ data: bytes }));
    expect(term.write).toHaveBeenCalledWith(new Uint8Array([104, 105]));
  });

  it('asks before trusting an unknown host key', async () => {
    const { onStatusChange, user } = await renderPane();

    serverSays({ type: 'hostkey', status: 'unknown', host: 'nas', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' });

    const dialog = screen.getByRole('dialog', { name: 'Unknown host key' });
    expect(dialog).toHaveTextContent('nas:22 is not known yet');
    expect(dialog).toHaveTextContent('SHA256:abc');
    expect(dialog).toHaveTextContent('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');

    await user.click(screen.getByRole('button', { name: /Trust and connect/ }));

    expect(socket().send).toHaveBeenCalledWith(JSON.stringify({ type: 'hostkey_accept' }));
    expect(onStatusChange).toHaveBeenLastCalledWith('authenticating');
    expect(screen.queryByRole('dialog', { name: 'Unknown host key' })).not.toBeInTheDocument();
  });

  it('closes on a rejected host key and reconnects on request', async () => {
    const { user } = await renderPane();
    serverSays({ type: 'hostkey', status: 'unknown', host: 'nas', port: 22, key_type: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:x' });
    expect(screen.getByRole('dialog')).toHaveTextContent('ssh_host_ecdsa_key.pub');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(socket().send).toHaveBeenCalledWith(JSON.stringify({ type: 'hostkey_reject' }));
    expect(screen.getByRole('status')).toHaveTextContent('Session ended.');

    await user.click(screen.getByRole('button', { name: /Reconnect/ }));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0].close).toHaveBeenCalled();
    expect(api.prepareSshSession).toHaveBeenCalledTimes(2);
  });

  it('warns about a changed host key', async () => {
    const { user } = await renderPane();
    serverSays({ type: 'hostkey', status: 'changed', host: 'nas', port: 2222, key_type: 'ssh-rsa', fingerprint: 'SHA256:new', known_fingerprint: 'SHA256:old' });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Host key has changed!');
    expect(alert).toHaveTextContent('SHA256:old');
    expect(alert).toHaveTextContent('SHA256:new');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows server errors and idle closes', async () => {
    const { term, onStatusChange } = await renderPane();

    serverSays({ type: 'error', message: 'Authentication failed' });
    expect(screen.getByRole('status')).toHaveTextContent('Authentication failed');
    expect(term.writeln).toHaveBeenCalledWith('\r\n\x1b[31mAuthentication failed\x1b[0m');
    expect(onStatusChange).toHaveBeenLastCalledWith('error');

    serverSays({ type: 'closed', reason: 'idle' });
    expect(screen.getByRole('status')).toHaveTextContent('Session closed after inactivity.');
  });

  it('keeps an error when the socket closes afterwards and marks a clean end as closed', async () => {
    const { term, onStatusChange } = await renderPane();
    serverSays({ type: 'status', stage: 'connected' });

    act(() => socket().onclose!());

    expect(onStatusChange).toHaveBeenLastCalledWith('closed');
    expect(term.writeln).toHaveBeenCalledWith('\r\n\x1b[90m[Disconnected]\x1b[0m');
  });

  it('explains a refused handshake as an expired login', async () => {
    const onStatusChange = vi.fn();
    render(<TerminalPane request={request} active onStatusChange={onStatusChange} />);
    await waitFor(() => expect(sockets).toHaveLength(1));

    act(() => socket().onclose!());

    expect(screen.getByRole('status')).toHaveTextContent('your login has expired');
    expect(onStatusChange).toHaveBeenLastCalledWith('error');
  });

  it('shows why a ticket could not be prepared', async () => {
    vi.mocked(api.prepareSshSession).mockRejectedValue(new Error('Profile not found'));
    render(<TerminalPane request={request} active />);

    expect(await screen.findByText('Profile not found')).toBeInTheDocument();
    expect(createSshTerminalSocket).not.toHaveBeenCalled();
  });
});

describe('TerminalPane input and clipboard', () => {
  it('sends typed data and remembers the line of the last command', async () => {
    const { term } = await renderPane();
    term.cursorY = 4;

    act(() => term.dataCb('ls\r'));

    expect(socket().send).toHaveBeenCalledWith(new TextEncoder().encode('ls\r'));
    expect(term.marker?.line).toBe(4);
  });

  it('copies the selection, or says there is none', async () => {
    const { term, user } = await renderPane();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByText('Select text first')).toBeInTheDocument();
    expect(copyText).not.toHaveBeenCalled();

    term.getSelection.mockReturnValue('uptime');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copyText).toHaveBeenCalledWith('uptime');
    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  it('copies the last command with its output, joining wrapped rows and leaving out the new prompt', async () => {
    const { term, user } = await renderPane();
    await user.click(screen.getByRole('button', { name: 'Last command' }));
    expect(screen.getByText('No command yet')).toBeInTheDocument();

    term.lines = [
      { text: 'root@nas:~$ echo a very long', isWrapped: false },
      { text: ' command', isWrapped: true },
      { text: 'a very long command   ', isWrapped: false },
      { text: 'root@nas:~$ ', isWrapped: false },
    ];
    term.cursorY = 0;
    act(() => term.dataCb('\r'));
    term.cursorY = 3;

    await user.click(screen.getByRole('button', { name: 'Last command' }));

    expect(copyText).toHaveBeenCalledWith('root@nas:~$ echo a very long command\na very long command');
  });

  it('copies and pastes with Ctrl+Shift+C/V but leaves Ctrl+C to the shell', async () => {
    const { term } = await renderPane();
    term.getSelection.mockReturnValue('df -h');
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => 'pwd') }, configurable: true });

    const key = (k: string, shiftKey: boolean) => ({ type: 'keydown', ctrlKey: true, shiftKey, key: k }) as KeyboardEvent;
    expect(term.keyHandler(key('c', false))).toBe(true);
    expect(term.keyHandler(key('C', true))).toBe(false);
    expect(term.keyHandler(key('V', true))).toBe(false);

    await waitFor(() => expect(copyText).toHaveBeenCalledWith('df -h'));
    await waitFor(() => expect(term.paste).toHaveBeenCalledWith('pwd'));
  });

  it('offers a paste box when the clipboard cannot be read', async () => {
    const { term, user } = await renderPane();
    // after userEvent.setup(), which installs a clipboard of its own
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    await user.click(screen.getByRole('button', { name: 'Paste' }));
    const box = screen.getByRole('dialog', { name: 'Paste' });
    expect(box).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Paste' }), 'echo hi');
    await user.click(screen.getByRole('button', { name: /Paste into terminal/ }));

    expect(term.paste).toHaveBeenCalledWith('echo hi');
    expect(screen.queryByRole('dialog', { name: 'Paste' })).not.toBeInTheDocument();
  });

  it('changes the font size and opens the appearance panel', async () => {
    const { term, user } = await renderPane();
    const size = screen.getByText(/^\d+px$/);
    const start = parseInt(size.textContent!);

    await user.click(screen.getByRole('button', { name: 'Larger font' }));
    expect(screen.getByText(`${start + 1}px`)).toBeInTheDocument();
    await waitFor(() => expect(term.options.fontSize).toBe(start + 1));

    await user.click(screen.getByRole('button', { name: 'Smaller font' }));
    expect(screen.getByText(`${start}px`)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByText('appearance panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Appearance' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('TerminalPane agent update', () => {
  const update: AgentUpdate = { deviceId: 7, installed: '0.3.5', latest: '0.3.7', available: true };

  it('has no agent button for a session without an agent', async () => {
    await renderPane();
    serverSays({ type: 'status', stage: 'connected' });
    expect(screen.queryByRole('button', { name: 'Agent update' })).not.toBeInTheDocument();
  });

  it('greys the button out with the installed version while the agent is up to date', async () => {
    const { user } = await renderPane({ deviceId: 7, installed: '0.3.7', latest: '0.3.7', available: false });
    serverSays({ type: 'status', stage: 'connected' });

    const button = screen.getByRole('button', { name: 'Agent update' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', expect.stringContaining('up to date (v0.3.7)'));
    expect(button).not.toHaveClass('is-available');

    await user.click(button);
    expect(api.createAgentEnrollment).not.toHaveBeenCalled();
  });

  it('types the update command with a fresh install code into the input line, without Enter', async () => {
    vi.mocked(api.createAgentEnrollment).mockResolvedValue({ code: 'Abc_123-xyz', expires_in: 1800 });
    const { term, user } = await renderPane(update);

    const button = screen.getByRole('button', { name: 'Agent update' });
    expect(button).toHaveAttribute('title', expect.stringContaining('v0.3.5 → v0.3.7'));
    expect(button).toHaveClass('is-available');
    // Only once there is a shell to type into
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(api.createAgentEnrollment).not.toHaveBeenCalled();
    serverSays({ type: 'status', stage: 'connected' });
    expect(button).toHaveAttribute('aria-disabled', 'false');

    await user.click(button);

    expect(api.createAgentEnrollment).toHaveBeenCalledWith(7);
    // Leading space: kept out of the shell history where HISTCONTROL ignores such lines
    const command = ` ${buildInstallCommand(7, 'Abc_123-xyz')}`;
    expect(command).toContain('/api/agent/download/install-sh/7?code=Abc_123-xyz');
    expect(term.paste).toHaveBeenCalledWith(command);
    expect(term.paste.mock.calls[0][0]).not.toMatch(/[\r\n]/);
    expect(socket().send).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('success', 'Update command inserted', expect.stringContaining('press Enter'));
  });

  it('fetches a new code for every insert', async () => {
    vi.mocked(api.createAgentEnrollment)
      .mockResolvedValueOnce({ code: 'first-code-1234567890', expires_in: 1800 })
      .mockResolvedValueOnce({ code: 'second-code-123456789', expires_in: 1800 });
    const { term, user } = await renderPane(update);
    serverSays({ type: 'status', stage: 'connected' });

    await user.click(screen.getByRole('button', { name: 'Agent update' }));
    await user.click(screen.getByRole('button', { name: 'Agent update' }));

    expect(term.paste).toHaveBeenNthCalledWith(1, expect.stringContaining('code=first-code-1234567890'));
    expect(term.paste).toHaveBeenNthCalledWith(2, expect.stringContaining('code=second-code-123456789'));
  });

  it.each([
    ['the code request fails', () => vi.mocked(api.createAgentEnrollment).mockRejectedValue(new Error('403'))],
    ['the code could inject shell syntax', () => vi.mocked(api.createAgentEnrollment).mockResolvedValue({ code: 'x"; reboot; echo "', expires_in: 1800 })],
  ])('inserts nothing when %s', async (_case, arrange) => {
    arrange();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { term, user } = await renderPane(update);
    serverSays({ type: 'status', stage: 'connected' });

    await user.click(screen.getByRole('button', { name: 'Agent update' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', 'Agent update', 'Could not create an install command. Please try again.'));
    expect(term.paste).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
