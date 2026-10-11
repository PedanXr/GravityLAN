import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ComponentProps } from 'react';
import type { Device, Service } from '../../types';
import { api } from '../../api/client';
import { DeviceCard } from './DeviceCard';

vi.mock('./DeviceMetrics', () => ({
  DeviceMetrics: ({ deviceId }: { deviceId: number }) => <div data-testid="metrics">metrics {deviceId}</div>,
}));
vi.mock('./ServiceBadge', () => ({
  ServiceBadge: ({ service, disabled }: { service: Service; disabled?: boolean }) => <span data-testid="badge" data-disabled={String(!!disabled)}>{service.name}</span>,
}));
vi.mock('../../api/client', () => ({
  api: { refreshDeviceInfo: vi.fn(), adoptAgent: vi.fn(), updateDevice: vi.fn() },
}));

const m = vi.mocked(api);

function makeDevice(over: Partial<Device> = {}): Device {
  return {
    id: 5, ip: '10.0.0.5', hostname: 'nas.lan', display_name: 'NAS', is_online: true,
    virtual_type: null, is_host: false, parent_id: null, parent_name: null, old_ip: null, has_pending_token: false,
    agent_info: { agent_version: '0.3.5', latest_version: '0.3.5' },
    services: [
      { id: 2, name: 'Web', protocol: 'https', port: 443, sort_order: 2 },
      { id: 1, name: 'Shell', protocol: 'ssh', port: 22, sort_order: 1 },
    ],
    ...over,
  } as unknown as Device;
}

function Where() {
  const loc = useLocation();
  return <p>at {loc.pathname}{loc.search}</p>;
}

function renderCard(props: Partial<ComponentProps<typeof DeviceCard>> = {}) {
  const handlers = { onEdit: vi.fn(), onRefresh: vi.fn(), onSelect: vi.fn() };
  const ui = (p: Partial<ComponentProps<typeof DeviceCard>>) => (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<DeviceCard device={makeDevice()} {...handlers} {...p} />} />
        <Route path="/ssh" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
  render(ui(props));
  return { ...handlers, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.refreshDeviceInfo.mockResolvedValue({} as never);
  m.adoptAgent.mockResolvedValue({ status: 'ok' });
  m.updateDevice.mockResolvedValue({} as never);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('DeviceCard', () => {
  it('shows the device with its role, host, metrics and services in order', () => {
    renderCard({ device: makeDevice({ virtual_type: 'docker', parent_id: 2, parent_name: 'Proxmox' }) });

    expect(screen.getByRole('heading', { name: 'NAS' })).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
    expect(screen.getByText('Docker')).toBeInTheDocument();
    expect(screen.getByText('on Proxmox')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Online' })).toBeInTheDocument();
    expect(screen.getByTestId('metrics')).toHaveTextContent('metrics 5');
    expect(screen.getAllByTestId('badge').map((b) => b.textContent)).toEqual(['Shell', 'Web']);
  });

  it('falls back to the hostname or IP and marks offline devices', () => {
    renderCard({ device: makeDevice({ display_name: '', hostname: null, is_online: false, is_host: true, services: [] }) });
    expect(screen.getByRole('heading', { name: '10.0.0.5' })).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveClass('is-offline');
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.queryByTestId('badge')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /SSH/i })).not.toBeInTheDocument();
  });

  it('opens the SSH page for devices with an SSH service', async () => {
    const { user } = renderCard();
    await user.click(screen.getByRole('button', { name: /SSH.*: NAS$/i }));
    expect(screen.getByText('at /ssh?device=5')).toBeInTheDocument();
  });

  it('refreshes the device info and opens the editor', async () => {
    const { onRefresh, onEdit, user } = renderCard();

    const refresh = screen.getByRole('button', { name: 'Refresh device info' });
    await user.click(refresh);
    expect(refresh).toHaveClass('spinning');
    await waitFor(() => expect(m.refreshDeviceInfo).toHaveBeenCalledWith(5));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Edit device: NAS' }));
    expect(onEdit).toHaveBeenCalled();
  });

  it('flags an agent update, adopts a new agent key and hides an IP change', async () => {
    const { onRefresh, user } = renderCard({
      device: makeDevice({ agent_info: { agent_version: '0.3.0', latest_version: '0.3.5' }, has_pending_token: true, old_ip: '10.0.0.99' } as Partial<Device>),
    });

    expect(screen.getByText('Agent update')).toBeInTheDocument();
    expect(screen.getByText(/New agent key/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Adopt' }));
    await waitFor(() => expect(m.adoptAgent).toHaveBeenCalledWith(5));
    expect(onRefresh).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /10\.0\.0\.99/ }));
    await waitFor(() => expect(m.updateDevice).toHaveBeenCalledWith(5, { old_ip: null, ip_changed_at: null }));
  });

  it('does not adopt without confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const { user } = renderCard({ device: makeDevice({ has_pending_token: true }) });
    await user.click(screen.getByRole('button', { name: 'Adopt' }));
    expect(m.adoptAgent).not.toHaveBeenCalled();
  });

  it('turns into a draggable, selectable tile in edit mode', async () => {
    const { onSelect, user } = renderCard({
      isEditMode: true,
      device: makeDevice({ agent_info: { agent_version: '0.3.0', latest_version: '0.3.5' }, has_pending_token: true, old_ip: '10.0.0.99' } as Partial<Device>),
    });

    expect(screen.queryByRole('button', { name: /Edit device/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('metrics')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent update')).not.toBeInTheDocument();
    expect(screen.queryByText(/New agent key/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /10\.0\.0\.99/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('badge').every((b) => b.dataset.disabled === 'true')).toBe(true);
    expect(document.querySelector('.device-card__handle')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Delete 1' }));
    expect(onSelect).toHaveBeenCalledWith(true);
  });

  it('marks a selected tile', () => {
    renderCard({ isEditMode: true, isSelected: true });
    expect(screen.getByRole('article')).toHaveClass('is-selected');
    expect(screen.getByRole('button', { name: 'Delete 1' })).toHaveAttribute('aria-pressed', 'true');
  });
});
