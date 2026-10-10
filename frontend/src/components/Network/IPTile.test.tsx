import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import i18n from '../../i18n';
import type { Device, DiscoveredHost } from '../../types';
import { IPTile } from './IPTile';

type Props = ComponentProps<typeof IPTile>;

function props(over: Partial<Props> = {}): Props {
  return {
    i: 12,
    ip: '10.0.0.12',
    status: 'empty',
    isFirstRows: false,
    safeZoom: 1,
    t: i18n.t.bind(i18n),
    onSelectDevice: vi.fn(),
    onUpdateDeviceField: vi.fn(),
    onUpdateDiscoveredHost: vi.fn(),
    onRefreshDevice: vi.fn(),
    onScanDiscoveredHost: vi.fn(),
    onAddDevice: vi.fn(),
    onDeleteDiscoveredHost: vi.fn(),
    isRefreshingServices: false,
    isRefreshingAdd: false,
    ...over,
  };
}

const device = {
  id: 4, ip: '10.0.0.12', display_name: 'NAS', device_type: 'Server', mac: 'aa:bb', is_online: true, is_reserved: false,
  services: [
    { id: 1, name: 'Service SSH', is_up: true },
    { id: 2, name: 'Web', is_up: false },
    { id: 3, name: '', is_up: true },
  ],
} as unknown as Device;

const host = {
  id: 9, ip: '10.0.0.12', hostname: 'printer.lan', custom_name: null, mac: 'cc:dd', is_online: false,
  is_reserved: true, is_monitored: true, ports: [631, 80],
} as unknown as DiscoveredHost;

function tile() {
  return screen.getAllByRole('button')[0];
}

describe('IPTile', () => {
  it('shows an empty address without a tooltip', async () => {
    const p = props();
    render(<IPTile {...p} />);

    expect(tile()).toHaveAccessibleName('Device 10.0.0.12, Offline');
    expect(tile()).toHaveTextContent('12');
    expect(tile()).toHaveStyle({ opacity: '0.6', cursor: 'default', borderStyle: 'solid' });
    expect(tile().querySelector('.ip-tooltip')).toBeNull();

    await userEvent.setup().click(tile());
    expect(p.onSelectDevice).not.toHaveBeenCalled();
  });

  it('opens an overview device by click or Enter and offers its actions', async () => {
    const p = props({ device, status: 'online' });
    render(<IPTile {...p} />);
    const user = userEvent.setup();

    expect(tile()).toHaveAccessibleName('Device 10.0.0.12, Online');
    expect(tile()).toHaveClass('ip-tile', 'online');
    const tip = tile().querySelector('.ip-tooltip') as HTMLElement;
    expect(tip).toHaveClass('tooltip-top');
    expect(tip).toHaveTextContent('NAS');
    expect(tip).toHaveTextContent('MAC: aa:bb');
    expect(tip).toHaveTextContent('Dashboard: Yes');
    expect(within(tip).getAllByText(/^(SSH|Svc|Web)$/).map((b) => b.textContent)).toEqual(['SSH', 'Svc']);

    await user.click(tile());
    tile().focus();
    await user.keyboard('{Enter}');
    expect(p.onSelectDevice).toHaveBeenCalledTimes(2);

    await user.click(within(tip).getByTitle('Mark IP as reserved (fixed)'));
    expect(p.onUpdateDeviceField).toHaveBeenCalledWith(4, { is_reserved: true });

    await user.click(within(tip).getByRole('button', { name: /General/ }));
    expect(p.onSelectDevice).toHaveBeenCalledTimes(3);

    await user.click(within(tip).getByRole('button', { name: /Nmap Scan/ }));
    expect(p.onRefreshDevice).toHaveBeenCalledWith(4, '10.0.0.12', 'services');
  });

  it('disables the scan while one is running', () => {
    render(<IPTile {...props({ device, status: 'online', isRefreshingServices: true })} />);
    expect(screen.getByRole('button', { name: /Nmap Scan/ })).toBeDisabled();
  });

  it('manages a discovered host: reserve, monitor, name, add, scan, forget', async () => {
    const p = props({ discovered: host, status: 'offline', isReserved: true, isFirstRows: true });
    render(<IPTile {...p} />);
    const user = userEvent.setup();
    const tip = tile().querySelector('.ip-tooltip') as HTMLElement;

    expect(tip).toHaveClass('tooltip-bottom');
    expect(tip).toHaveTextContent('printer.lan');
    expect(tip).not.toHaveTextContent('Dashboard:');
    expect(within(tip).getByText('631')).toBeInTheDocument();
    expect(tile()).toHaveStyle({ borderStyle: 'dashed', boxShadow: 'inset 0 0 10px rgba(239, 68, 68, 0.4)' });

    await user.click(within(tip).getByTitle('Remove reservation'));
    expect(p.onUpdateDiscoveredHost).toHaveBeenLastCalledWith(9, { is_reserved: false });
    await user.click(within(tip).getByTitle('Stop Monitoring'));
    expect(p.onUpdateDiscoveredHost).toHaveBeenLastCalledWith(9, { is_monitored: false });

    const name = within(tip).getByPlaceholderText('Custom Name (e.g. Printer)');
    await user.type(name, 'Drucker{Enter}');
    expect(p.onUpdateDiscoveredHost).toHaveBeenLastCalledWith(9, { custom_name: 'Drucker' });
    await user.type(name, ' 2');
    await user.click(name.nextElementSibling as HTMLElement);
    expect(p.onUpdateDiscoveredHost).toHaveBeenLastCalledWith(9, { custom_name: 'Drucker 2' });

    await user.click(within(tip).getByRole('button', { name: /On Dashboard/ }));
    expect(p.onAddDevice).toHaveBeenCalledWith('10.0.0.12');
    await user.click(within(tip).getByRole('button', { name: /Nmap Scan/ }));
    expect(p.onScanDiscoveredHost).toHaveBeenCalledWith('10.0.0.12');
    await user.click(within(tip).getByTitle('Remove from list'));
    expect(p.onDeleteDiscoveredHost).toHaveBeenCalledWith(9, '10.0.0.12');

    await user.click(tile());
    expect(p.onSelectDevice).not.toHaveBeenCalled();
  });

  it('names a discovered host by its custom name, then hostname, then "unknown"', () => {
    const { rerender } = render(<IPTile {...props({ discovered: { ...host, custom_name: 'Laser' }, status: 'online' })} />);
    expect(tile().querySelector('h4')).toHaveTextContent('Laser');
    rerender(<IPTile {...props({ discovered: { ...host, id: 10, hostname: null }, status: 'online' })} />);
    expect(tile().querySelector('h4')).toHaveTextContent('Unknown Device');
  });

  it('marks area membership and scales with the zoom', () => {
    render(<IPTile {...props({ device, status: 'online', group: { name: 'Servers', color: '#ff0000', start: 10, end: 19 }, safeZoom: 2 })} />);

    expect(screen.getByText('Servers')).toHaveClass('ip-tile__group');
    expect(tile()).toHaveStyle({ borderColor: '#ff0000', borderWidth: '2px', fontSize: '1.4rem' });
    expect(tile().querySelector('.ip-tooltip')).toHaveStyle({ width: '520px' });
  });

  it('only re-renders when what it shows changes', () => {
    const p = props({ device, status: 'online' });
    const { rerender } = render(<IPTile {...p} />);
    const before = tile().querySelector('.ip-tooltip');

    // new callbacks and an unrelated field: memo keeps the old output
    rerender(<IPTile {...p} onSelectDevice={vi.fn()} device={{ ...device, display_name: 'Renamed' }} />);
    expect(tile()).toHaveTextContent('NAS');
    expect(tile().querySelector('.ip-tooltip')).toBe(before);

    rerender(<IPTile {...p} status="offline" />);
    expect(tile()).toHaveAccessibleName('Device 10.0.0.12, Offline');
  });
});
