import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { api, createMetricsSocket } from '../../api/client';
import { DeviceMetrics } from './DeviceMetrics';

vi.mock('../../api/client', () => ({
  api: { getAgentStatus: vi.fn(), getAgentMetrics: vi.fn() },
  createMetricsSocket: vi.fn(),
}));

const m = vi.mocked(api);
let push: (msg: unknown) => void;
let socket: { close: ReturnType<typeof vi.fn> };

// A stored history row is flat; live messages are nested
const storedRow = {
  cpu_percent: 12.4, ram_used_mb: 2048, ram_total_mb: 8192, ram_percent: 25,
  disk_json: JSON.stringify([{ path: '/', total_gb: 100, used_gb: 50, percent: 50 }, { path: '/data', total_gb: 1000, used_gb: 900, percent: 90 }]),
  temperature: 72.3, net_json: JSON.stringify({ eth0: { rx_bytes_sec: 1_500_000, tx_bytes_sec: 2_500 } }),
  timestamp: '2026-10-10T10:00:00Z',
};

const live = {
  cpu_percent: 96, ram: { used_mb: 7000, total_mb: 8000, percent: 87.5 },
  disk: [{ path: '/', total_gb: 100, used_gb: 10, percent: 10 }], temperature: null,
  network: { wlan0: { rx_bytes_sec: 512, tx_bytes_sec: 0 } }, timestamp: '2026-10-10T10:00:10Z',
};

function meter(name: string) {
  return screen.getByRole('meter', { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getAgentStatus.mockResolvedValue({ is_active: true } as never);
  m.getAgentMetrics.mockResolvedValue({ snapshots: [storedRow] } as never);
  vi.mocked(createMetricsSocket).mockImplementation((_id, cb) => {
    push = cb;
    socket = { close: vi.fn() };
    return socket as unknown as WebSocket;
  });
});

describe('DeviceMetrics', () => {
  it('shows nothing without an active agent', async () => {
    m.getAgentStatus.mockResolvedValue({ is_active: false } as never);
    const { container } = render(<DeviceMetrics deviceId={1} />);
    await waitFor(() => expect(m.getAgentStatus).toHaveBeenCalledWith(1));
    expect(container).toBeEmptyDOMElement();
    expect(createMetricsSocket).not.toHaveBeenCalled();
  });

  it('shows nothing when the status cannot be read', async () => {
    m.getAgentStatus.mockRejectedValue(new Error('down'));
    const { container } = render(<DeviceMetrics deviceId={1} />);
    await waitFor(() => expect(m.getAgentStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('starts from the last stored sample and shows the fullest disk on the card', async () => {
    render(<DeviceMetrics deviceId={3} />);

    await waitFor(() => expect(meter('CPU')).toHaveAttribute('aria-valuetext', '12 %'));
    expect(m.getAgentMetrics).toHaveBeenCalledWith(3, 1);
    expect(meter('RAM')).toHaveAttribute('aria-valuenow', '25');
    expect(meter('Disk')).toHaveAttribute('aria-valuetext', '90 %');
    expect(meter('Temp')).toHaveAttribute('aria-valuetext', '72 °C');
    // normal values keep the accent, thresholds turn amber / red
    expect(meter('CPU').firstElementChild).toHaveStyle({ background: 'var(--accent-primary)' });
    expect(meter('Disk').firstElementChild).toHaveStyle({ background: 'var(--accent-warning)' });
    expect(meter('Temp').firstElementChild).toHaveStyle({ background: 'var(--accent-warning)' });
  });

  it('follows live messages and reports them', async () => {
    const onUpdate = vi.fn();
    render(<DeviceMetrics deviceId={3} onUpdate={onUpdate} />);
    await waitFor(() => expect(createMetricsSocket).toHaveBeenCalledWith(3, expect.any(Function)));

    act(() => push({ type: 'metrics', data: live }));

    expect(meter('CPU')).toHaveAttribute('aria-valuetext', '96 %');
    expect(meter('CPU').firstElementChild).toHaveStyle({ background: 'var(--accent-danger)' });
    expect(meter('RAM').firstElementChild).toHaveStyle({ background: 'var(--accent-warning)' });
    expect(screen.queryByRole('meter', { name: 'Temp' })).not.toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalledWith(live);

    act(() => push(storedRow));
    expect(meter('CPU')).toHaveAttribute('aria-valuetext', '12 %');
  });

  it('works without stored samples', async () => {
    m.getAgentMetrics.mockResolvedValue({ snapshots: [] } as never);
    const { container } = render(<DeviceMetrics deviceId={3} />);
    await waitFor(() => expect(createMetricsSocket).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    act(() => push({ type: 'metrics', data: live }));
    expect(meter('CPU')).toBeInTheDocument();
  });

  it('shows all values in the expanded view', async () => {
    render(<DeviceMetrics deviceId={3} compact={false} />);

    expect(await screen.findByText('12.4%')).toBeInTheDocument();
    expect(screen.getByText('2.0 / 8.0 GB')).toBeInTheDocument();
    expect(screen.getByText('50 / 100 GB')).toBeInTheDocument();
    expect(screen.getByText('900 / 1000 GB')).toBeInTheDocument();
    expect(screen.getByText('72.3°C')).toHaveStyle({ color: '#f59e0b' });
    expect(screen.getByText('↓1.5 MB/s ↑3 KB/s')).toBeInTheDocument();

    act(() => push({ type: 'metrics', data: live }));
    expect(screen.getByText('96.0%')).toHaveStyle({ color: '#ef4444' });
    expect(screen.getByText('↓512 B/s ↑0 B/s')).toBeInTheDocument();
    expect(screen.queryByText('Temperature')).not.toBeInTheDocument();
  });

  it('closes the live socket when it goes away', async () => {
    const { unmount } = render(<DeviceMetrics deviceId={3} />);
    await waitFor(() => expect(createMetricsSocket).toHaveBeenCalled());
    unmount();
    expect(socket.close).toHaveBeenCalled();
  });
});
