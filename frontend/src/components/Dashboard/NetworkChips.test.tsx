import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Device, DeviceInterface } from '../../types';
import { NetworkChips } from './NetworkChips';
import { networkColor } from '../../utils/networks';

function iface(over: Partial<DeviceInterface> = {}): DeviceInterface {
  return {
    id: 7, device_id: 1, ip: '192.168.110.1', mac: 'aa:bb:cc:00:00:01', subnet_id: 2,
    subnet_name: 'IoT', subnet_cidr: '192.168.110.0/24', vlan_id: 110, label: null,
    is_online: true, last_seen: null, first_seen: null, ...over,
  };
}

function router(interfaces: DeviceInterface[]): Device {
  return {
    id: 1, ip: '192.168.100.1', display_name: 'Router', hostname: null, is_online: true,
    subnet_id: 1, subnet_name: 'LAN', subnet_vlan_id: null, interfaces,
  } as unknown as Device;
}

describe('NetworkChips', () => {
  it('shows nothing for a device in a single network', () => {
    const { container } = render(<NetworkChips device={router([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the primary network and every VLAN interface, offline ones marked', () => {
    render(<NetworkChips device={router([iface(), iface({ id: 8, ip: '10.10.0.1', subnet_id: 3, subnet_name: 'Guest', vlan_id: 30, is_online: false })])} />);

    const list = screen.getByRole('list', { name: 'Networks of Router' });
    const chips = within(list).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining('LAN'),
      expect.stringContaining('IoT110'),
      expect.stringContaining('Guest30'),
    ]);
    expect(chips[0]).toHaveAttribute('title', expect.stringContaining('192.168.100.1 · Primary · Online'));
    expect(chips[1]).toHaveAttribute('title', '192.168.110.1 · VLAN 110 · Online');
    expect(chips[2]).toHaveClass('is-offline');
    expect(chips[2]).toHaveTextContent('10.10.0.1, Offline');
  });

  it('gives a subnet the same colour wherever it appears', () => {
    expect(networkColor(2, '192.168.110.1')).toBe(networkColor(2, '10.0.0.1'));
    expect(networkColor(1)).not.toBe(networkColor(2));
    expect(networkColor(null, '192.168.110.1')).toBe(networkColor(null, '192.168.110.77'));
  });
});
