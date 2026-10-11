import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType, ReactNode } from 'react';
import type { Device, TopologyLink } from '../../types';
import { api } from '../../api/client';
import TopologyMap from './TopologyMap';

/* eslint-disable @typescript-eslint/no-explicit-any */

// A stand-in for React Flow: it keeps the props it was given and renders the
// real node and edge components, so their output can be checked in jsdom.
const flow = vi.hoisted(() => ({ props: null as any }));

vi.mock('reactflow', async () => {
  const { useState } = await import('react');
  const useListState = (init: unknown[]) => {
    const [items, setItems] = useState(init);
    return [items, setItems, () => {}];
  };
  function ReactFlow(props: any) {
    flow.props = props;
    return (
      <div data-testid="flow">
        {props.nodes.map((n: any) => {
          const Node = props.nodeTypes[n.type] as ComponentType<any>;
          return <div key={n.id} data-testid={`node-${n.id}`}><Node id={n.id} data={n.data} selected={!!n.selected} /></div>;
        })}
        {props.edges.map((e: any) => {
          const Edge = props.edgeTypes[e.type] as ComponentType<any>;
          return (
            <svg key={e.id} data-testid={`edge-${e.id}`}>
              <Edge id={e.id} data={e.data} selected={!!e.selected} sourceX={0} sourceY={0} targetX={10} targetY={10} />
            </svg>
          );
        })}
        {props.children}
      </div>
    );
  }
  return {
    default: ReactFlow,
    Background: () => null,
    Controls: () => null,
    useNodesState: useListState,
    useEdgesState: useListState,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Handle: ({ id }: { id: string }) => <span data-testid="handle">{id}</span>,
    Position: { Top: 'top', Bottom: 'bottom' },
    getBezierPath: () => ['M0,0 L10,10', 5, 5],
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <foreignObject>{children}</foreignObject>,
  };
});
vi.mock('reactflow/dist/style.css', () => ({}));
vi.mock('../../api/client', () => ({
  api: {
    getTopologyMap: vi.fn(), createTopologyLink: vi.fn(), updateTopologyLink: vi.fn(), deleteTopologyLink: vi.fn(),
    updateDevice: vi.fn(), deleteDevice: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn(),
  },
}));

const m = vi.mocked(api);

function dev(id: number, over: Record<string, unknown> = {}): Device {
  return {
    id, ip: `10.0.0.${id}`, hostname: `host${id}`, display_name: null, is_online: true,
    has_agent: false, is_host: false, is_wlan: false, is_ap: false, virtual_type: null, parent_name: null,
    max_ports: 0, topology_x: null, topology_y: null, topology_config: null,
    ...over,
  } as unknown as Device;
}

const devices = [
  dev(1, { display_name: 'Core switch', is_host: true, max_ports: 8, topology_x: 0, topology_y: 0,
    has_agent: true, metrics: { cpu_percent: 42.4, ram: { percent: 61.6 } }, topology_config: JSON.stringify({ top_handle_type: 'both', bottom_handle_type: 'both' }) }),
  dev(2, { parent_name: 'Core switch', virtual_type: 'docker', topology_x: 300, topology_y: 0 }),
  dev(3, { is_ap: true, topology_x: 0, topology_y: 600 }),
  dev(4, { is_wlan: true, is_online: false, topology_x: 900, topology_y: 600 }),
];

const links: TopologyLink[] = [
  { id: 11, source_id: 1, target_id: 2, source_handle: 'bottom-source', target_handle: 'top-target', link_type: '10GbE' },
  { id: 12, source_id: 3, target_id: 4, source_handle: null, target_handle: null, link_type: '1GbE' },
];

const nodeEl = (id: number) => screen.getByTestId(`node-${id}`);
const edgeEl = (id: number) => screen.getByTestId(`edge-e-${id}`);
const flowNode = (id: number) => flow.props.nodes.find((n: any) => n.id === String(id));
// The sticky drag checkbox sits next to its caption without a label element
const stickyBox = () => screen.getByText('Sticky Drag').parentElement!.parentElement!.querySelector('input') as HTMLInputElement;

async function renderMap() {
  const user = userEvent.setup();
  render(<TopologyMap />);
  await waitFor(() => expect(flow.props?.nodes).toHaveLength(4));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  flow.props = null;
  m.getTopologyMap.mockResolvedValue({ devices, links });
  m.getSettings.mockResolvedValue({});
  m.updateSettings.mockResolvedValue({} as never);
  m.createTopologyLink.mockResolvedValue({} as never);
  m.updateTopologyLink.mockResolvedValue({} as never);
  m.deleteTopologyLink.mockResolvedValue(undefined);
  m.updateDevice.mockResolvedValue({} as never);
  m.deleteDevice.mockResolvedValue(undefined);
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TopologyMap', () => {
  it('draws a node per device with its role, metrics, handles and ports', async () => {
    await renderMap();

    const core = within(nodeEl(1));
    expect(core.getByText('Core switch')).toBeInTheDocument();
    expect(core.getByText('10.0.0.1')).toBeInTheDocument();
    expect(core.getByText('HOST')).toBeInTheDocument();
    expect(core.getByText('42%')).toBeInTheDocument();
    expect(core.getByText('62%')).toBeInTheDocument();
    expect(core.getByText(/1 \/ 8 Ports/)).toBeInTheDocument();
    expect(core.getAllByTestId('handle').map((h) => h.textContent)).toEqual(['top-target', 'top-source', 'bottom-target', 'bottom-source']);
    expect(nodeEl(1).firstElementChild).toHaveClass('topology-node', 'online');

    const container = within(nodeEl(2));
    expect(container.getByText('host2')).toBeInTheDocument();
    expect(container.getByText('On: Core switch')).toBeInTheDocument();
    expect(container.getAllByTestId('handle').map((h) => h.textContent)).toEqual(['top-target', 'bottom-source']);
    expect(container.queryByText(/Ports/)).not.toBeInTheDocument();

    expect(nodeEl(4).firstElementChild).toHaveClass('offline');
  });

  it('places devices without a saved position on a five-wide grid', async () => {
    m.getTopologyMap.mockResolvedValue({ devices: [dev(1), dev(2), dev(3), dev(4), dev(5), dev(6, { topology_x: 7, topology_y: 8 })], links: [] });
    render(<TopologyMap />);
    await waitFor(() => expect(flow.props?.nodes).toHaveLength(6));
    expect(flow.props.nodes.map((n: any) => n.position)).toEqual([
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 600, y: 0 }, { x: 900, y: 0 }, { x: 1200, y: 0 }, { x: 7, y: 8 },
    ]);
  });

  it('shows WLAN clients the signal to their nearest access point', async () => {
    await renderMap();
    expect(flowNode(4).data.nearest_ap).toEqual({ x: 0, y: 600, id: 3 });
    expect(flowNode(1).data.nearest_ap).toBeNull();
    const bars = nodeEl(4).querySelectorAll('.signal-bar');
    expect(bars).toHaveLength(4);
    // 900 px away: two of four bars
    const active = [...bars].filter((b) => (b as HTMLElement).style.background === 'rgb(56, 189, 248)');
    expect(active).toHaveLength(2);
    expect((nodeEl(4).querySelector('.wlan-signals') as HTMLElement).style.left).toBe('-15px');
  });

  it('draws links with their speed, colour and live particles', async () => {
    await renderMap();

    const wired = flow.props.edges.find((e: any) => e.id === 'e-11');
    expect(wired).toMatchObject({ source: '1', target: '2', sourceHandle: 'bottom-source', targetHandle: 'top-target', animated: true });
    expect(wired.markerEnd).toEqual({ type: 'arrowclosed', color: '#f59e0b' });
    expect(within(edgeEl(11)).getByText('10GbE')).toHaveStyle({ backgroundColor: '#f59e0b' });
    // default intensity 2: three circles per particle
    expect(edgeEl(11).querySelectorAll('circle')).toHaveLength(6);

    const wireless = flow.props.edges.find((e: any) => e.id === 'e-12');
    expect(wireless.animated).toBe(false);
    expect(wireless.data).toMatchObject({ is_wireless: true, source_online: true, target_online: false });
    expect(edgeEl(12).querySelectorAll('circle')).toHaveLength(0);
    expect(edgeEl(12).querySelector('.react-flow__edge-path')).toHaveStyle({ strokeDasharray: '5,5' });
  });

  it('cycles a link speed from its badge', async () => {
    const user = await renderMap();
    await user.click(within(edgeEl(12)).getByText('1GbE'));
    expect(m.updateTopologyLink).toHaveBeenCalledWith(12, { link_type: '2.5GbE' });
    expect(within(edgeEl(12)).getByText('2.5GbE')).toBeInTheDocument();

    await user.click(within(edgeEl(11)).getByText('10GbE'));
    expect(m.updateTopologyLink).toHaveBeenLastCalledWith(11, { link_type: '100Mb' });
  });

  it('shows nothing for an empty network', async () => {
    m.getTopologyMap.mockResolvedValue({ devices: [], links: [] });
    render(<TopologyMap />);
    await waitFor(() => expect(m.getTopologyMap).toHaveBeenCalled());
    await waitFor(() => expect(flow.props.nodes).toEqual([]));
    expect(flow.props.edges).toEqual([]);
  });

  it('connects two devices and reloads the map', async () => {
    await renderMap();
    act(() => flow.props.onConnect({ source: '2', target: '2' }));
    expect(m.createTopologyLink).not.toHaveBeenCalled();

    act(() => flow.props.onConnect({ source: '2', target: '3', sourceHandle: 'bottom-source', targetHandle: 'top-target' }));
    expect(m.createTopologyLink).toHaveBeenCalledWith({ source_id: 2, target_id: 3, source_handle: 'bottom-source', target_handle: 'top-target', link_type: '1GbE' });
    await waitFor(() => expect(m.getTopologyMap).toHaveBeenCalledTimes(2));
  });

  it('refuses links beyond the port limit and reports failed links', async () => {
    m.getTopologyMap.mockResolvedValue({ devices: devices.map((d) => (d.id === 2 ? { ...d, max_ports: 1 } : d)), links });
    await renderMap();

    act(() => flow.props.onConnect({ source: '3', target: '2' }));
    expect(window.alert).toHaveBeenCalledWith('Port limit reached: host2 already uses 1 of 1 ports.');
    expect(m.createTopologyLink).not.toHaveBeenCalled();

    m.createTopologyLink.mockRejectedValue(new Error('exists'));
    act(() => flow.props.onConnect({ source: '1', target: '3' }));
    await waitFor(() => expect(window.alert).toHaveBeenLastCalledWith('Error creating connection. Does it already exist?'));
  });

  it('configures a device from its sidebar', async () => {
    const user = await renderMap();
    act(() => flow.props.onNodeClick({}, flowNode(1)));

    expect(screen.getByText('Device configuration')).toBeInTheDocument();
    expect(screen.getByLabelText('WLAN Client')).not.toBeChecked();
    const selects = screen.getAllByRole('combobox');
    expect(selects.map((s) => (s as HTMLSelectElement).value)).toEqual(['both', 'both']);
    expect(screen.getByRole('spinbutton')).toHaveValue(8);

    await user.click(screen.getByLabelText('Access Point'));
    await user.selectOptions(selects[0], 'target');
    await user.selectOptions(selects[1], 'source');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(m.updateDevice).toHaveBeenCalledWith(1, {
      is_wlan: false, is_ap: true, topology_config: JSON.stringify({ top_handle_type: 'target', bottom_handle_type: 'source' }),
    });
    await waitFor(() => expect(screen.queryByText('Device configuration')).not.toBeInTheDocument());
    expect(m.getTopologyMap).toHaveBeenCalledTimes(2);
  });

  it('falls back to default handles and 24 ports for a plain device', async () => {
    await renderMap();
    act(() => flow.props.onNodeClick({}, flowNode(4)));
    expect(screen.getByLabelText('WLAN Client')).toBeChecked();
    expect(screen.getAllByRole('combobox').map((s) => (s as HTMLSelectElement).value)).toEqual(['target', 'source']);
    expect(screen.getByRole('spinbutton')).toHaveValue(24);
  });

  it('removes a device after confirmation', async () => {
    const user = await renderMap();
    act(() => flow.props.onNodeClick({}, flowNode(2)));
    await user.click(screen.getByRole('button', { name: /Remove device/ }));
    expect(window.confirm).toHaveBeenCalledWith('Do you really want to permanently delete this device?');
    await waitFor(() => expect(m.deleteDevice).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.queryByTestId('node-2')).not.toBeInTheDocument());
  });

  it('changes and removes a link from its sidebar', async () => {
    const user = await renderMap();
    act(() => flow.props.onEdgeClick({}, flow.props.edges[0]));

    expect(screen.getByText('Connection info')).toBeInTheDocument();
    expect(screen.getByText('Link: 10GbE')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox'), '100Mb');
    expect(m.updateTopologyLink).toHaveBeenCalledWith(11, { link_type: '100Mb' });

    await user.click(screen.getByRole('button', { name: /Disconnect/ }));
    expect(m.deleteTopologyLink).toHaveBeenCalledWith(11);
    expect(screen.queryByTestId('edge-e-11')).not.toBeInTheDocument();

    act(() => flow.props.onPaneClick());
    expect(screen.queryByText('Connection info')).not.toBeInTheDocument();
  });

  it('moves linked neighbours along with sticky drag and saves all positions', async () => {
    m.getSettings.mockResolvedValue({ 'topology.sticky_drag': 'true' });
    await renderMap();
    await waitFor(() => expect(stickyBox()).toBeChecked());

    const core = flowNode(1);
    act(() => flow.props.onNodeDragStart({}, core));
    act(() => flow.props.onNodeDrag({}, { ...core, position: { x: 10.4, y: 20 } }));
    expect(flowNode(2).position).toEqual({ x: 310.4, y: 20 });
    expect(flowNode(3).position).toEqual({ x: 0, y: 600 });

    await act(() => flow.props.onNodeDragStop({}, { ...core, position: { x: 10.4, y: 20 } }));
    expect(m.updateDevice).toHaveBeenCalledWith(1, { topology_x: 10, topology_y: 20 });
    expect(m.updateDevice).toHaveBeenCalledWith(2, { topology_x: 310, topology_y: 20 });
  });

  it('saves only the dragged node without sticky drag', async () => {
    await renderMap();
    const node = flowNode(3);
    act(() => flow.props.onNodeDragStart({}, node));
    act(() => flow.props.onNodeDrag({}, { ...node, position: { x: 50, y: 650 } }));
    expect(flowNode(4).position).toEqual({ x: 900, y: 600 });
    await act(() => flow.props.onNodeDragStop({}, { ...node, position: { x: 50, y: 650 } }));
    expect(m.updateDevice).toHaveBeenCalledTimes(1);
    expect(m.updateDevice).toHaveBeenCalledWith(3, { topology_x: 50, topology_y: 650 });
  });

  it('loads and saves the data flow settings', async () => {
    m.getSettings.mockResolvedValue({ 'topology.flow_speed': '2', 'topology.flow_intensity': '4' });
    const user = await renderMap();

    expect(await screen.findByText('Speed: 2.0x')).toBeInTheDocument();
    expect(screen.getByText('Intensity: 4')).toBeInTheDocument();
    expect(edgeEl(11).querySelectorAll('circle')).toHaveLength(12);
    expect(edgeEl(11).querySelector('animateMotion')).toHaveAttribute('dur', '0.7s');

    const [, intensity] = screen.getAllByRole('slider');
    fireEvent.change(intensity, { target: { value: '0' } });
    expect(await screen.findByText('Animations Disabled')).toBeInTheDocument();
    expect(m.updateSettings).toHaveBeenCalledWith({ 'topology.flow_intensity': '0' });
    expect(edgeEl(11).querySelectorAll('circle')).toHaveLength(0);

    await user.click(stickyBox());
    expect(m.updateSettings).toHaveBeenLastCalledWith({ 'topology.sticky_drag': 'true' });

    await user.click(screen.getByText('Data flow'));
    expect(screen.queryByText('Intensity: 0')).not.toBeInTheDocument();
  });

  it('refreshes on demand and toggles full screen', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.assign(HTMLElement.prototype, { requestFullscreen });
    const user = await renderMap();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(m.getTopologyMap).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(requestFullscreen).toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', { value: document.body, configurable: true });
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
  });
});
