import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ScanProgress } from '../../types';
import { api, createScanSocket } from '../../api/client';
import { SetupWizard } from './SetupWizard';

vi.mock('../LanguageToggle', () => ({ LanguageToggle: () => null }));
vi.mock('../../api/client', () => ({
  createScanSocket: vi.fn(),
  api: {
    getSubnets: vi.fn(),
    startScan: vi.fn(),
    stopScan: vi.fn(),
    completeSetup: vi.fn(),
    login: vi.fn(),
    refreshAllDevices: vi.fn(),
  },
}));

const m = vi.mocked(api);
let onProgress: (p: ScanProgress) => void;
let socket: { close: ReturnType<typeof vi.fn> };

const subnets = [
  { subnet: '192.168.1.0/24', interface_name: 'eth0', ip_address: '192.168.1.5' },
  { subnet: '10.0.0.0/24', interface_name: 'wg0', ip_address: '10.0.0.2' },
];

function progress(over: Partial<ScanProgress>): ScanProgress {
  return { status: 'running', current_subnet: '', hosts_scanned: 0, hosts_total: 0, devices_found: 0, message: '', timestamp: '', ...over } as ScanProgress;
}

function renderWizard() {
  const onComplete = vi.fn();
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<SetupWizard onComplete={onComplete} />} />
        <Route path="/" element={<p>dashboard page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { onComplete, user };
}

async function toNetworks(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByText('192.168.1.0/24');
}

function stepState(label: string) {
  return screen.getByText(label, { selector: '.setup-stepper__label' }).closest('li')!.className;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getSubnets.mockResolvedValue(subnets as never);
  m.startScan.mockResolvedValue({} as never);
  m.stopScan.mockResolvedValue({ status: 'ok' });
  m.completeSetup.mockResolvedValue({} as never);
  m.login.mockResolvedValue({} as never);
  m.refreshAllDevices.mockResolvedValue({} as never);
  vi.mocked(createScanSocket).mockImplementation((cb) => {
    onProgress = cb;
    socket = { close: vi.fn() };
    return socket as unknown as WebSocket;
  });
});

describe('SetupWizard', () => {
  it('starts with the welcome step and selects every detected network', async () => {
    const { user } = renderWizard();
    expect(screen.getByRole('heading', { name: 'Welcome to GravityLAN' })).toBeInTheDocument();
    expect(stepState('Welcome')).toContain('is-current');

    await toNetworks(user);

    expect(screen.getByRole('heading', { name: 'Select networks' })).toHaveFocus();
    expect(stepState('Welcome')).toContain('is-done');
    expect(screen.getByRole('checkbox', { name: /192\.168\.1\.0\/24/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /10\.0\.0\.0\/24/ })).toBeChecked();
    expect(screen.getByText('wg0 · 10.0.0.2')).toBeInTheDocument();
  });

  it('explains a failed or empty network detection', async () => {
    m.getSubnets.mockRejectedValue(new Error('no permission'));
    const { user } = renderWizard();
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not detect networks: no permission');
    expect(screen.getByRole('button', { name: /Skip scan/ })).toBeInTheDocument();
  });

  it('says when no networks were found', async () => {
    m.getSubnets.mockResolvedValue([] as never);
    const { user } = renderWizard();
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(await screen.findByText(/No networks detected/)).toBeInTheDocument();
  });

  it('skips the scan when no network is selected', async () => {
    const { user } = renderWizard();
    await toNetworks(user);
    await user.click(screen.getByRole('checkbox', { name: /192\.168/ }));
    await user.click(screen.getByRole('checkbox', { name: /10\.0/ }));

    await user.click(screen.getByRole('button', { name: /Skip scan/ }));

    expect(screen.getByRole('heading', { name: 'Configure security' })).toBeInTheDocument();
    expect(stepState('Scan')).toContain('is-skipped');
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('heading', { name: 'Select networks' })).toBeInTheDocument();
  });

  it('scans the chosen networks with live progress', async () => {
    const { user } = renderWizard();
    await toNetworks(user);
    await user.click(screen.getByRole('checkbox', { name: /10\.0/ }));
    await user.type(screen.getByLabelText('DNS server (optional)'), '192.168.1.2');

    await user.click(screen.getByRole('button', { name: /Start Scan/ }));

    expect(m.startScan).toHaveBeenCalledWith({ subnets: ['192.168.1.0/24'], mode: 'fast', dns_server: '192.168.1.2' });
    expect(screen.getByRole('heading', { name: 'Scanning Network...' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveClass('is-indeterminate');
    expect(screen.getByText('Initializing scan...')).toBeInTheDocument();

    act(() => onProgress(progress({ hosts_scanned: 64, hosts_total: 256, devices_found: 3, message: 'Pinging…' })));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('64 / 256')).toBeInTheDocument();
    expect(screen.getByText('Pinging…')).toBeInTheDocument();

    act(() => onProgress(progress({ status: 'completed', hosts_scanned: 256, hosts_total: 256, devices_found: 7 })));
    expect(socket.close).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Scan completed!' })).toBeInTheDocument();
    expect(screen.getByText('7')).toHaveClass('is-accent');

    await user.click(screen.getByRole('button', { name: /Next/ }));
    expect(stepState('Scan')).toContain('is-done');
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('heading', { name: 'Scan completed!' })).toBeInTheDocument();
  });

  it('adds a network the container cannot see, scans it and registers it with the setup', async () => {
    const { user } = renderWizard();
    await toNetworks(user);

    const input = screen.getByLabelText('Another network (e.g. an IoT VLAN)');
    await user.type(input, '10.0.0.0/8');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a subnet like 192.168.110.0/24.');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await user.clear(input);
    await user.type(input, '192.168.110.7/24');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(input).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: /192\.168\.110\.0\/24/ })).toBeChecked();
    expect(screen.getByText('Added manually')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /^10\.0\.0\.0\/24/ }));
    await user.click(screen.getByRole('button', { name: /Start Scan/ }));
    expect(m.startScan).toHaveBeenCalledWith({ subnets: ['192.168.1.0/24', '192.168.110.0/24'], mode: 'fast', dns_server: undefined });

    act(() => onProgress(progress({ status: 'completed', hosts_scanned: 256, hosts_total: 256 })));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.type(screen.getByLabelText('Administrator password'), 'test-pass-1');
    await user.type(screen.getByLabelText('Confirm password'), 'test-pass-1');
    await user.click(screen.getByRole('button', { name: /Finish/ }));

    await waitFor(() => expect(m.completeSetup).toHaveBeenCalledWith({
      admin_password: 'test-pass-1', subnets: ['192.168.1.0/24', '192.168.110.0/24'],
    }));
  });

  it('offers to go on without a scan that failed to start', async () => {
    m.startScan.mockRejectedValue(new Error('scanner busy'));
    const { user } = renderWizard();
    await toNetworks(user);

    await user.click(screen.getByRole('button', { name: /Start Scan/ }));

    expect(await screen.findByRole('heading', { name: 'Scan failed' })).toBeInTheDocument();
    expect(screen.getByText('scanner busy')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/run a scan from the overview/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Continue without scan/ }));
    expect(screen.getByRole('heading', { name: 'Configure security' })).toBeInTheDocument();
  });

  it('aborts a running scan', async () => {
    const { user } = renderWizard();
    await toNetworks(user);
    await user.click(screen.getByRole('button', { name: /Start Scan/ }));

    await user.click(screen.getByRole('button', { name: 'Abort Scan' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Scan cancelled' })).toBeInTheDocument());
    expect(m.stopScan).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('heading', { name: 'Select networks' })).toBeInTheDocument();
  });

  it('needs matching passwords before finishing', async () => {
    const { user } = renderWizard();
    await toNetworks(user);
    await user.click(screen.getByRole('checkbox', { name: /192\.168/ }));
    await user.click(screen.getByRole('checkbox', { name: /10\.0/ }));
    await user.click(screen.getByRole('button', { name: /Skip scan/ }));

    const finish = screen.getByRole('button', { name: /Finish/ });
    expect(finish).toBeDisabled();
    await user.type(screen.getByLabelText('Administrator password'), 'test-pass-1');
    await user.type(screen.getByLabelText('Confirm password'), 'test-pass-2');
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-invalid', 'true');
    expect(finish).toBeDisabled();
  });

  it('saves the setup, signs in and opens the dashboard', async () => {
    const { onComplete, user } = renderWizard();
    await toNetworks(user);
    await user.type(screen.getByLabelText('DNS server (optional)'), '10.0.0.1');
    await user.click(screen.getByRole('checkbox', { name: /192\.168/ }));
    await user.click(screen.getByRole('checkbox', { name: /10\.0/ }));
    await user.click(screen.getByRole('button', { name: /Skip scan/ }));
    await user.type(screen.getByLabelText('Administrator password'), 'test-pass-1');
    await user.type(screen.getByLabelText('Confirm password'), 'test-pass-1');

    await user.click(screen.getByRole('button', { name: /Finish/ }));

    expect(m.completeSetup).toHaveBeenCalledWith({ dns_server: '10.0.0.1', admin_password: 'test-pass-1' });
    expect(await screen.findByRole('progressbar', { name: 'Setup progress' })).toBeInTheDocument();
    await waitFor(() => expect(m.login).toHaveBeenCalledWith('test-pass-1'));
    await waitFor(() => expect(m.refreshAllDevices).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 });
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
  });

  it('stays in the wizard when the setup cannot be saved', async () => {
    m.completeSetup.mockRejectedValue(new Error('disk full'));
    const { onComplete, user } = renderWizard();
    await toNetworks(user);
    await user.click(screen.getByRole('checkbox', { name: /192\.168/ }));
    await user.click(screen.getByRole('checkbox', { name: /10\.0/ }));
    await user.click(screen.getByRole('button', { name: /Skip scan/ }));
    await user.type(screen.getByLabelText('Administrator password'), 'test-pass-1');
    await user.type(screen.getByLabelText('Confirm password'), 'test-pass-1');

    await user.click(screen.getByRole('button', { name: /Finish/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Setup could not be saved: disk full');
    expect(within(alert.closest('form')!).getByRole('heading', { name: 'Configure security' })).toBeInTheDocument();
    expect(m.login).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
