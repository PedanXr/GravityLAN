import { MarkerType, type Edge, type Node } from 'reactflow';

/* eslint-disable @typescript-eslint/no-explicit-any -- device and link payloads are passed through to React Flow as they come */

export interface NodeConfig {
  maxPorts: number;
  isWlan: boolean;
  isAp: boolean;
  topHandle: string;
  bottomHandle: string;
}

const SPEEDS = ['100Mb', '1GbE', '2.5GbE', '10GbE'];

/** The speed after `current` in the cycle, unless one is forced. */
export function nextSpeed(current: string, forced?: string): string {
  return forced || SPEEDS[(SPEEDS.indexOf(current) + 1) % SPEEDS.length];
}

const is25G = (speed: string) => speed.includes('2.5G') || speed.includes('2500');

/** Link colour by speed; offline links are grey. */
export function speedColor(speed: string, isOnline: boolean): string {
  if (!isOnline) return 'rgba(100, 116, 139, 0.4)';
  if (speed.includes('10G')) return '#f59e0b';
  if (is25G(speed)) return '#d946ef';
  if (speed.includes('1GbE')) return '#38bdf8';
  return '#94a3b8';
}

function markerColor(linkType: string | undefined): string {
  if (linkType?.includes('10G')) return '#f59e0b';
  if (linkType && is25G(linkType)) return '#d946ef';
  return '#38bdf8';
}

/** Seconds one particle takes along a link at flow speed 1. */
export function particleSeconds(speed: string): number {
  if (speed.includes('10G')) return 1.4;
  if (speed.includes('2.5G')) return 1.8;
  return 3;
}

/** Handle setup stored as JSON on the device; unreadable config means defaults. */
export function parseTopologyConfig(raw: string | null | undefined): { top_handle_type?: string; bottom_handle_type?: string } {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function nodeConfigFrom(node: Node): NodeConfig {
  const config = parseTopologyConfig(node.data.topology_config);
  return {
    maxPorts: node.data.max_ports || 24,
    isWlan: !!node.data.is_wlan,
    isAp: !!node.data.is_ap,
    topHandle: config.top_handle_type || 'target',
    bottomHandle: config.bottom_handle_type || 'source',
  };
}

/** Signal bars (1–4) for a WLAN client by its distance to the access point. */
export function signalStrength(distance: number): number {
  if (distance < 400) return 4;
  if (distance < 800) return 3;
  if (distance < 1200) return 2;
  return 1;
}

/** Put the signal badge on the node side that faces the access point. */
export function signalAnchor(dx: number, dy: number) {
  const w = 240;
  const h = 100;
  if (Math.abs(dx) * h > Math.abs(dy) * w) {
    return dx > 0 ? { right: -15, top: '50%', transform: 'translateY(-50%)' }
                  : { left: -15, top: '50%', transform: 'translateY(-50%)' };
  }
  return dy > 0 ? { bottom: -15, left: '50%', transform: 'translateX(-50%)' }
                : { top: -15, left: '50%', transform: 'translateX(-50%)' };
}

function gridPosition(dev: any, devices: any[]) {
  const index = devices.indexOf(dev);
  return { x: dev.topology_x ?? (index % 5) * 300, y: dev.topology_y ?? Math.floor(index / 5) * 200 };
}

function findNearestAp(dev: any, aps: any[], devices: any[]) {
  if (!dev.is_wlan || aps.length === 0) return null;
  const { x, y } = gridPosition(dev, devices);
  let nearestAp = null;
  let minDist = Infinity;
  aps.forEach((ap: any) => {
    const { x: apX, y: apY } = gridPosition(ap, devices);
    const dist = Math.sqrt(Math.pow(apX - x, 2) + Math.pow(apY - y, 2));
    if (dist < minDist) {
      minDist = dist;
      nearestAp = { x: apX, y: apY, id: ap.id };
    }
  });
  return nearestAp;
}

export function buildInitialNodes(devices: any[], links: any[], onDelete: (id: string) => void): Node[] {
  const aps = devices.filter((d: any) => d.is_ap);
  return devices.map((dev: any) => {
    const { x, y } = gridPosition(dev, devices);
    return {
      id: dev.id.toString(),
      type: 'device',
      data: {
        ...dev,
        label: dev.display_name || dev.hostname,
        nearest_ap: findNearestAp(dev, aps, devices),
        x,
        y,
        onDelete,
        link_count: links.filter((l: any) => l.source_id === dev.id || l.target_id === dev.id).length,
      },
      position: { x, y },
    };
  });
}

export function buildInitialEdges(
  links: any[],
  devices: any[],
  onRotateSpeed: (edgeId: string, speed: string, forcedSpeed?: string) => void,
  onDeleteLink: (edgeId: string) => void,
): Edge[] {
  return links.map((link: any) => {
    const sourceNode = devices.find((d: any) => d.id === link.source_id);
    const targetNode = devices.find((d: any) => d.id === link.target_id);
    const isWireless = sourceNode?.is_wlan || targetNode?.is_wlan;
    return {
      id: `e-${link.id}`,
      source: link.source_id.toString(),
      target: link.target_id.toString(),
      sourceHandle: link.source_handle,
      targetHandle: link.target_handle,
      type: 'custom',
      data: {
        link_type: link.link_type,
        is_wireless: isWireless,
        source_online: sourceNode?.is_online,
        target_online: targetNode?.is_online,
        onRotateSpeed,
        onDeleteLink,
      },
      animated: !isWireless,
      markerEnd: { type: MarkerType.ArrowClosed, color: markerColor(link.link_type) },
    };
  });
}

/** Keep the current nodes when nothing changed, so React Flow does not re-render; else keep selection and drags. */
export function mergeNodesPreservingState(initialNodes: Node[], prevNodes: Node[]): Node[] {
  const simplifiedIncoming = initialNodes.map((n: Node) => ({ id: n.id, data: n.data, position: n.position }));
  const simplifiedCurrent = prevNodes.map((n: Node) => ({ id: n.id, data: n.data, position: n.position }));

  if (JSON.stringify(simplifiedIncoming) === JSON.stringify(simplifiedCurrent)) {
    return prevNodes;
  }

  return initialNodes.map((n: any) => {
    const existing = prevNodes.find(node => node.id === n.id);
    return existing ? {
      ...n,
      selected: existing.selected,
      position: (existing as any).dragging ? existing.position : n.position,
    } : n;
  });
}

export function mergeEdgesPreservingState(initialEdges: Edge[], prevEdges: Edge[]): Edge[] {
  const simplifiedIncoming = initialEdges.map((e: Edge) => ({ id: e.id, data: e.data, source: e.source, target: e.target }));
  const simplifiedCurrent = prevEdges.map((e: Edge) => ({ id: e.id, data: e.data, source: e.source, target: e.target }));

  if (JSON.stringify(simplifiedIncoming) === JSON.stringify(simplifiedCurrent)) {
    return prevEdges;
  }

  return initialEdges.map((e: any) => {
    const existing = prevEdges.find(edge => edge.id === e.id);
    return existing ? { ...e, selected: existing.selected } : e;
  });
}

export function linkCount(edges: Edge[], nodeId: string): number {
  return edges.filter(e => e.source === nodeId || e.target === nodeId).length;
}

export function portLimitReached(node: Node | undefined, nodeId: string, edges: Edge[]): boolean {
  if (!node || node.data.max_ports <= 0) return false;
  return linkCount(edges, nodeId) >= node.data.max_ports;
}

export function collectNeighborIds(edges: Edge[], nodeId: string): Set<string> {
  const neighbors = new Set<string>();
  edges.forEach(e => {
    if (e.source === nodeId) neighbors.add(e.target);
    if (e.target === nodeId) neighbors.add(e.source);
  });
  return neighbors;
}
