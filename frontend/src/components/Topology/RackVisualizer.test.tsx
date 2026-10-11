import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, Rack } from '../../types';
import { api } from '../../api/client';
import RackVisualizer from './RackVisualizer';

vi.mock('../../api/client', () => ({
  api: { getRacks: vi.fn(), createRack: vi.fn() },
}));

const m = vi.mocked(api);

const small = { id: 1, name: 'Small', units: 6, width: 19 } as Rack;
const wide = { id: 2, name: 'Wide', units: 4, width: 10 } as Rack;

function makeDevice(id: number, over: Partial<Device>): Device {
  return {
    id, ip: `10.0.0.${id}`, hostname: null, display_name: `Dev ${id}`, is_online: true,
    rack_id: 1, rack_unit: null, rack_height: null,
    ...over,
  } as unknown as Device;
}

const devices = [
  makeDevice(1, { rack_unit: 2, is_online: false, display_name: '', hostname: 'switch.lan' }),
  makeDevice(2, { rack_unit: 5, rack_height: 2 }),
  makeDevice(3, { rack_id: 2, rack_unit: 1 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  m.getRacks.mockResolvedValue([small, wide]);
  m.createRack.mockResolvedValue({ id: 9, name: 'Main Rack', units: 42, width: 19 } as Rack);
});

describe('RackVisualizer', () => {
  it('shows a loading state first', () => {
    m.getRacks.mockReturnValue(new Promise(() => {}));
    render(<RackVisualizer devices={devices} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading racks…');
  });

  it('draws the first rack top-down with multi-unit devices spanning their rows', async () => {
    const { container } = render(<RackVisualizer devices={devices} />);

    expect(await screen.findByRole('heading', { name: 'Small' })).toBeInTheDocument();
    expect(screen.getByText('19″ rack · 6U')).toBeInTheDocument();

    const frame = screen.getByRole('list', { name: 'Small' });
    const slots = within(frame).getAllByRole('listitem');
    expect(slots.map((s) => s.querySelector('.rack-device__name')?.textContent)).toEqual(['Dev 2', 'switch.lan']);
    expect(slots[0]).toHaveStyle({ height: 'calc(2 * var(--rack-unit-height))' });
    expect(within(slots[0]).getByText('10.0.0.2 · 2U')).toBeInTheDocument();
    // U6, U3 and U1 are free; U4 is covered by the 2U device in U5
    const free = [...container.querySelectorAll('.rack-frame > .rack-unit')].map((u) => u.textContent);
    expect(free).toEqual(['6', '3', '1']);
  });

  it('sums up the rack and lists its inventory from the top', async () => {
    render(<RackVisualizer devices={devices} />);
    await screen.findByRole('heading', { name: 'Small' });

    expect(screen.getByText('Occupied units').nextElementSibling).toHaveTextContent('3 / 6');
    expect(screen.getByText('Devices in rack').nextElementSibling).toHaveTextContent('2');
    const inventory = screen.getByRole('heading', { name: 'Inventory' }).nextElementSibling as HTMLElement;
    const rows = within(inventory).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Dev 2U5 · 2U', 'switch.lanU2 · 1U']);
    expect(within(rows[1]).getByRole('img', { name: 'Offline' })).toBeInTheDocument();
  });

  it('switches between racks', async () => {
    const user = userEvent.setup();
    render(<RackVisualizer devices={devices} />);
    await screen.findByRole('heading', { name: 'Small' });

    const group = screen.getByRole('group', { name: 'Select rack' });
    expect(within(group).getByRole('button', { name: 'Small' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(group).getByRole('button', { name: 'Wide' }));

    expect(screen.getByRole('heading', { name: 'Wide' })).toBeInTheDocument();
    expect(screen.getByText('10″ rack · 4U')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Wide' })).getAllByRole('listitem')).toHaveLength(1);
    expect(within(group).getByRole('button', { name: 'Wide' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides the rack switch with a single rack and shows an empty inventory', async () => {
    m.getRacks.mockResolvedValue([small]);
    render(<RackVisualizer devices={[]} />);
    await screen.findByRole('heading', { name: 'Small' });
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByText(/No devices in this rack yet/)).toBeInTheDocument();
  });

  it('offers to create a default rack when there is none', async () => {
    const user = userEvent.setup();
    m.getRacks.mockResolvedValue([]);
    render(<RackVisualizer devices={devices} />);

    expect(await screen.findByRole('heading', { name: 'No rack yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create default rack (42U)' }));

    expect(m.createRack).toHaveBeenCalledWith({ name: 'Main Rack', units: 42, width: 19 });
    expect(await screen.findByRole('heading', { name: 'Main Rack' })).toBeInTheDocument();
  });

  it('treats a failed rack request as no racks', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.getRacks.mockRejectedValue(new Error('down'));
    render(<RackVisualizer devices={devices} />);
    expect(await screen.findByRole('heading', { name: 'No rack yet' })).toBeInTheDocument();
  });
});
