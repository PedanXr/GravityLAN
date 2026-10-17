import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, DiscoveredHost, Subnet } from '../../../types';
import { GatewayFields } from './GatewayFields';
import { buildTiles, countOnline, recentFindings } from './model';

const IOT: Subnet = {
  id: 2, cidr: '192.168.110.0/24', name: 'IoT', dns_server: null, is_enabled: true,
  gateway_ip: null, vlan_id: 110, gateway_suggestion: '192.168.110.1', gateway_source: 'suggested',
};

describe('GatewayFields', () => {
  it('shows the automatic gateway as placeholder and saves only changed fields', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<GatewayFields subnet={IOT} onSave={onSave} />);

    const gateway = screen.getByRole('textbox', { name: 'Gateway of 192.168.110.0/24' });
    const vlan = screen.getByRole('spinbutton', { name: 'VLAN ID of 192.168.110.0/24' });
    expect(gateway).toHaveAttribute('placeholder', 'automatic: 192.168.110.1 (suggested)');
    expect(vlan).toHaveValue(110);

    await user.click(gateway);
    await user.tab();
    expect(onSave).not.toHaveBeenCalled();

    await user.type(gateway, '192.168.110.254');
    await user.tab();
    expect(onSave).toHaveBeenLastCalledWith({ gateway_ip: '192.168.110.254' });

    await user.clear(vlan);
    await user.tab();
    expect(onSave).toHaveBeenLastCalledWith({ vlan_id: null });
  });
});

describe('IP overview with a multi-VLAN router', () => {
  const router = {
    id: 1, ip: '192.168.100.1', display_name: 'Router', is_online: true, is_reserved: false,
    interfaces: [{ id: 7, device_id: 1, ip: '192.168.110.1', is_online: false, mac: null, subnet_id: 2,
      subnet_name: 'IoT', subnet_cidr: '192.168.110.0/24', vlan_id: 110, label: null, last_seen: null, first_seen: null }],
  } as unknown as Device;
  const disc = { id: 3, ip: '192.168.110.1', is_online: true, is_monitored: true, first_seen: '2026-10-17T10:00:00' } as unknown as DiscoveredHost;

  it('shows the router on its gateway address in every subnet tab, with that interface state', () => {
    const lan = buildTiles('192.168.100', [router], [], [], 16);
    const iot = buildTiles('192.168.110', [router], [disc], [], 16);
    expect(lan[1].device?.id).toBe(1);
    expect(lan[1].status).toBe('online');
    expect(iot[1].device?.id).toBe(1);
    expect(iot[1].status).toBe('offline');
  });

  it('does not count or list the interface address as a new, unknown host', () => {
    expect(countOnline('192.168.110', [router], [disc])).toBe(0);
    expect(recentFindings([disc], [router])).toEqual([]);
  });
});
