import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device, DeviceInterface, MergeSuggestion } from '../../../types';
import { api } from '../../../api/client';
import { InterfacesTab } from './InterfacesTab';

const showToast = vi.fn();
vi.mock('../../../context/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../api/client', () => ({
  api: {
    getDeviceInterfaces: vi.fn(),
    getMergeSuggestions: vi.fn(),
    addDeviceInterface: vi.fn(),
    updateDeviceInterface: vi.fn(),
    removeDeviceInterface: vi.fn(),
    mergeIntoDevice: vi.fn(),
    dismissMergeSuggestion: vi.fn(),
  },
}));

const m = vi.mocked(api);

const IOT: DeviceInterface = {
  id: 7, device_id: 1, ip: '192.168.110.1', mac: 'aa:bb:cc:00:00:01', subnet_id: 2, subnet_name: 'IoT',
  subnet_cidr: '192.168.110.0/24', vlan_id: 110, label: null, is_online: false,
  last_seen: '2026-10-17T10:00:00', first_seen: null,
};

const ROUTER = {
  id: 1, ip: '192.168.100.1', mac: 'aa:bb:cc:00:00:01', display_name: 'Router', hostname: null,
  is_online: true, subnet_id: 1, subnet_name: 'LAN', subnet_vlan_id: null, interfaces: [IOT],
} as unknown as Device;

type SuggestionOverrides = Omit<Partial<MergeSuggestion>, 'candidate'> & { candidate?: Partial<MergeSuggestion['candidate']> };

function suggestion(over: SuggestionOverrides = {}): MergeSuggestion {
  const { candidate, ...rest } = over;
  return {
    target_id: 1, target_name: 'Router', target_ip: '192.168.100.1', reasons: ['same_hostname', 'same_mac'],
    candidate: { kind: 'device', id: 3, ip: '10.10.0.1', name: 'Router Guest', mac: null, subnet_id: 3, subnet_name: 'Guest', is_online: true, ...candidate },
    ...rest,
  };
}

function renderTab(device: Device = ROUTER) {
  const onChanged = vi.fn();
  const onMergedAway = vi.fn();
  render(<InterfacesTab device={device} onChanged={onChanged} onMergedAway={onMergedAway} />);
  return { onChanged, onMergedAway, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getDeviceInterfaces.mockResolvedValue([IOT]);
  m.getMergeSuggestions.mockResolvedValue([]);
  m.addDeviceInterface.mockResolvedValue(IOT);
  m.updateDeviceInterface.mockResolvedValue(IOT);
  m.removeDeviceInterface.mockResolvedValue(undefined);
  m.mergeIntoDevice.mockResolvedValue(IOT);
  m.dismissMergeSuggestion.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('InterfacesTab', () => {
  it('lists the primary address and each interface with its own status', async () => {
    renderTab();
    const list = within(screen.getByRole('region', { name: 'Addresses of this device' })).getAllByRole('listitem');

    expect(list).toHaveLength(2);
    expect(list[0]).toHaveTextContent('192.168.100.1');
    expect(list[0]).toHaveTextContent('Primary');
    expect(within(list[0]).getByRole('img', { name: 'Online' })).toBeInTheDocument();
    expect(list[1]).toHaveTextContent('192.168.110.1');
    expect(list[1]).toHaveTextContent('IoT · VLAN 110');
    expect(within(list[1]).getByRole('img', { name: 'Offline' })).toBeInTheDocument();
    await waitFor(() => expect(m.getDeviceInterfaces).toHaveBeenCalledWith(1));
  });

  it('adds, labels and detaches an interface', async () => {
    const { user, onChanged } = renderTab();

    await user.type(screen.getByRole('textbox', { name: 'IP address of the interface' }), '10.20.0.1');
    await user.type(screen.getByRole('textbox', { name: 'Label of the new interface' }), 'Cameras');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(m.addDeviceInterface).toHaveBeenCalledWith(1, { ip: '10.20.0.1', label: 'Cameras' }));
    expect(onChanged).toHaveBeenCalled();

    const label = screen.getByRole('textbox', { name: 'Label for 192.168.110.1' });
    await user.type(label, 'IoT VLAN{Enter}');
    await waitFor(() => expect(m.updateDeviceInterface).toHaveBeenCalledWith(1, 7, { label: 'IoT VLAN' }));

    await user.click(screen.getByRole('button', { name: 'Detach interface 192.168.110.1' }));
    await waitFor(() => expect(m.removeDeviceInterface).toHaveBeenCalledWith(1, 7));
  });

  it('merges a suggested duplicate only after confirmation and lets the user dismiss one', async () => {
    m.getMergeSuggestions.mockResolvedValue([
      suggestion(),
      suggestion({ reasons: ['same_mac'], candidate: { kind: 'discovered', id: 9, ip: '10.30.0.1', name: null, subnet_id: null, subnet_name: null } }),
    ]);
    const { user } = renderTab();
    const section = await screen.findByRole('region', { name: 'Suggestions' });
    const rows = within(section).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('same hostname');
    expect(rows[0]).toHaveTextContent('same MAC');

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(within(rows[0]).getByRole('button', { name: 'Merge as interface of Router' }));
    expect(m.mergeIntoDevice).not.toHaveBeenCalled();

    await user.click(within(rows[0]).getByRole('button', { name: 'Merge as interface of Router' }));
    await waitFor(() => expect(m.mergeIntoDevice).toHaveBeenCalledWith(1, { source_device_id: 3 }));

    // A bare discovered address is attached without the delete warning
    vi.mocked(window.confirm).mockClear();
    await user.click(within(rows[1]).getByRole('button', { name: 'Merge as interface of Router' }));
    await waitFor(() => expect(m.mergeIntoDevice).toHaveBeenCalledWith(1, { ip: '10.30.0.1' }));
    expect(window.confirm).not.toHaveBeenCalled();

    await user.click(within(rows[1]).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(m.dismissMergeSuggestion).toHaveBeenCalledWith({ target_id: 1, kind: 'discovered', candidate_ip: '10.30.0.1' }));
  });

  it('offers to merge this device into the router it duplicates, then closes', async () => {
    const dup = { ...ROUTER, id: 3, ip: '10.10.0.1', display_name: 'Router Guest', interfaces: [] } as unknown as Device;
    m.getDeviceInterfaces.mockResolvedValue([]);
    m.getMergeSuggestions.mockResolvedValue([suggestion()]);
    const { user, onMergedAway, onChanged } = renderTab(dup);

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Router Guest looks like a further address of Router (192.168.100.1).');
    await user.click(within(note).getByRole('button', { name: 'Merge as interface of Router' }));

    await waitFor(() => expect(m.mergeIntoDevice).toHaveBeenCalledWith(1, { source_device_id: 3 }));
    expect(onChanged).toHaveBeenCalled();
    expect(onMergedAway).toHaveBeenCalled();
  });

  it('shows the backend refusal instead of failing silently', async () => {
    m.addDeviceInterface.mockRejectedValue(new Error('192.168.110.1 is already an interface of a device'));
    const { user } = renderTab();
    await user.type(screen.getByRole('textbox', { name: 'IP address of the interface' }), '192.168.110.1');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error', 'Error', '192.168.110.1 is already an interface of a device'));
  });
});
