import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { GatewayEntry, MergeSuggestion } from '../../../types';
import { api } from '../../../api/client';
import { GatewaysPopover } from './GatewaysPopover';

vi.mock('../../../api/client', () => ({
  api: { getGateways: vi.fn(), getMergeSuggestions: vi.fn() },
}));

const m = vi.mocked(api);

function entry(over: Partial<GatewayEntry>): GatewayEntry {
  return {
    subnet_id: 1, subnet_name: 'LAN', cidr: '192.168.100.0/24', vlan_id: null, is_enabled: true,
    gateway_ip: '192.168.100.1', source: 'detected', device_id: 4, device_name: 'Router',
    interface_id: null, is_primary: true, is_online: true, last_seen: null, mac: null, ...over,
  };
}

const ENTRIES: GatewayEntry[] = [
  entry({}),
  entry({ subnet_id: 2, subnet_name: 'IoT', cidr: '192.168.110.0/24', vlan_id: 110, gateway_ip: '192.168.110.1',
    source: 'configured', interface_id: 9, is_primary: false, is_online: false }),
  entry({ subnet_id: 3, subnet_name: 'Guest', cidr: '10.10.0.0/24', vlan_id: 30, gateway_ip: '10.10.0.1',
    source: 'suggested', device_id: null, device_name: null, is_primary: false, is_online: null }),
  entry({ subnet_id: 4, subnet_name: 'Cameras', cidr: '10.20.0.0/24', vlan_id: 40, gateway_ip: '10.20.0.1',
    interface_id: 10, is_primary: false }),
];

const SUGGESTION: MergeSuggestion = {
  target_id: 4, target_name: 'Router', target_ip: '192.168.100.1', reasons: ['same_mac'],
  candidate: { kind: 'device', id: 12, ip: '192.168.120.1', name: 'Router (DMZ)', mac: null, subnet_id: null, subnet_name: null, is_online: true },
};

function Where() {
  return <p>at {useLocation().pathname}</p>;
}

function renderPopover() {
  const onOpenDevice = vi.fn();
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<GatewaysPopover onOpenDevice={onOpenDevice} />} />
        <Route path="/network" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onOpenDevice, user: userEvent.setup() };
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Gateways: 1 gateway offline/ }));
  return screen.getByRole('dialog', { name: 'Gateways' });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getGateways.mockResolvedValue(ENTRIES);
  m.getMergeSuggestions.mockResolvedValue([SUGGESTION]);
});

describe('GatewaysPopover', () => {
  it('lists the gateway of every network with VLAN, status, source and device', async () => {
    const { user } = renderPopover();
    const panel = await openPanel(user);

    expect(within(panel).getByText('Gateways of 4 networks')).toBeInTheDocument();
    const rows = within(panel).getAllByRole('button', { name: /: gateway / });
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'LAN: gateway 192.168.100.1, Online, Router',
      'IoT, VLAN 110: gateway 192.168.110.1, Offline, Router',
      'Guest, VLAN 30: gateway 10.10.0.1, not seen yet, no device',
      'Cameras, VLAN 40: gateway 10.20.0.1, Online, Router',
    ]);
    expect(within(rows[0]).getByText('detected')).toBeInTheDocument();
    expect(within(rows[2]).getByText('suggested')).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/detected|suggested/)).toBeNull();
  });

  it('is navigable with the keyboard and opens the device on its interfaces tab', async () => {
    const { user, onOpenDevice } = renderPopover();
    await openPanel(user);

    expect(screen.getByRole('searchbox', { name: 'Filter by network, VLAN or IP' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /^LAN: gateway/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /^IoT, VLAN 110/ })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: /^Cameras/ })).toHaveFocus();
    await user.keyboard('{Home}{ArrowUp}');
    expect(screen.getByRole('searchbox')).toHaveFocus();

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onOpenDevice).toHaveBeenCalledWith(4, 'interfaces');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters by name, VLAN or address and closes with Escape back on the trigger', async () => {
    const { user } = renderPopover();
    await openPanel(user);

    await user.type(screen.getByRole('searchbox'), 'vlan 30');
    expect(screen.getAllByRole('button', { name: /: gateway / }).map((r) => r.getAttribute('aria-label')))
      .toEqual(['Guest, VLAN 30: gateway 10.10.0.1, not seen yet, no device']);
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), '192.168.110');
    expect(screen.getAllByRole('button', { name: /: gateway / })).toHaveLength(1);
    await user.type(screen.getByRole('searchbox'), 'xyz');
    expect(screen.getByText('No network matches the filter.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^Gateways/ })).toHaveFocus();
  });

  it('sends a gateway without a device to the IP overview and offers the merge suggestions', async () => {
    const { user, onOpenDevice } = renderPopover();
    let panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Merge 1 possible interface' }));
    expect(onOpenDevice).toHaveBeenCalledWith(4, 'interfaces');

    panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: /^Guest, VLAN 30/ }));
    expect(await screen.findByText('at /network')).toBeInTheDocument();
  });

  it('copies a gateway address', async () => {
    const { user } = renderPopover();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const panel = await openPanel(user);

    await user.click(within(panel).getByRole('button', { name: 'Copy 192.168.110.1' }));

    expect(writeText).toHaveBeenCalledWith('192.168.110.1');
    expect(await within(panel).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('shows an empty state without subnets', async () => {
    m.getGateways.mockResolvedValue([]);
    const { user } = renderPopover();
    await user.click(await screen.findByRole('button', { name: 'Gateways' }));
    await waitFor(() => expect(screen.getByText('No subnets configured yet.')).toBeInTheDocument());
  });
});
