import { useCallback, useEffect, useState, type RefObject } from 'react';
import { useEdgesState, useNodesState, type Connection, type Node } from 'reactflow';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import {
  buildInitialEdges, buildInitialNodes, collectNeighborIds, linkCount, mergeEdgesPreservingState,
  mergeNodesPreservingState, nextSpeed, portLimitReached, type NodeConfig,
} from './graph';

const linkIdOf = (edgeId: string) => parseInt(edgeId.replace('e-', ''));

async function saveNodePos(id: string, pos: { x: number; y: number }) {
  try {
    await api.updateDevice(parseInt(id), {
      topology_x: Math.round(pos.x),
      topology_y: Math.round(pos.y),
    });
  } catch (err) {
    console.error('Failed to save node position:', err);
  }
}

/**
 * Devices and links as React Flow nodes and edges, reloaded every minute, plus
 * the changes made on the map: link speed, links, device settings and removal.
 */
export function useTopologyGraph() {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const onRotateSpeed = useCallback(async (edgeId: string, currentSpeed: string, forcedSpeed?: string) => {
    const speed = nextSpeed(currentSpeed, forcedSpeed);
    try {
      setEdges(eds => eds.map(e => (e.id === edgeId ? { ...e, data: { ...e.data, link_type: speed } } : e)));
      await api.updateTopologyLink(linkIdOf(edgeId), { link_type: speed });
    } catch (err) { console.error(err); }
  }, [setEdges]);

  const onDeleteLink = useCallback(async (edgeId: string) => {
    try {
      setEdges(eds => eds.filter(e => e.id !== edgeId));
      await api.deleteTopologyLink(linkIdOf(edgeId));
    } catch (err) { console.error(err); }
  }, [setEdges]);

  const deleteDevice = useCallback(async (id: string) => {
    if (!window.confirm(t('editor.delete_device_confirm', 'Do you really want to permanently delete this device?'))) return;
    try {
      await api.deleteDevice(parseInt(id));
      setNodes(nds => nds.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to delete device:', err);
      alert(t('notifications.delete_failed', 'Delete failed'));
    }
  }, [setNodes, t]);

  const fetchData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const { devices, links } = await api.getTopologyMap();
      console.log(`Topology: Loaded ${devices?.length || 0} devices and ${links?.length || 0} links`);

      if (!devices || devices.length === 0) {
        setNodes([]);
        setEdges([]);
        return;
      }

      const initialNodes = buildInitialNodes(devices, links, deleteDevice);
      const initialEdges = buildInitialEdges(links, devices, onRotateSpeed, onDeleteLink);
      // Only update if data actually changed to prevent React Flow re-renders
      setNodes(prevNodes => mergeNodesPreservingState(initialNodes, prevNodes));
      setEdges(prevEdges => mergeEdgesPreservingState(initialEdges, prevEdges));
    } catch (err) {
      console.error('Topology fetch failed:', err);
    } finally {
      setIsRefreshing(false);
    }
  }, [setNodes, setEdges, onRotateSpeed, onDeleteLink, deleteDevice]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 60000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const onConnect = useCallback((params: Connection) => {
    if (params.source === params.target) return;

    // Enforce max ports on both ends
    const overLimit = (id: string) => {
      const node = nodes.find(n => n.id === id);
      if (!node || !portLimitReached(node, id, edges)) return false;
      const current = linkCount(edges, id);
      const { label, max_ports: max } = node.data;
      alert(t('topology.port_limit_reached', {
        name: label, current, max,
        defaultValue: `Port limit reached! ${label} already has ${current} of ${max} ports occupied.`,
      }));
      return true;
    };
    if (overLimit(params.source!) || overLimit(params.target!)) return;

    api.createTopologyLink({
      source_id: parseInt(params.source!),
      target_id: parseInt(params.target!),
      source_handle: params.sourceHandle,
      target_handle: params.targetHandle,
      link_type: '1GbE',
    }).then(() => {
      fetchData();
    }).catch(() => {
      alert(t('topology.connection_error', 'Error creating connection. Does it already exist?'));
    });
  }, [fetchData, nodes, edges, t]);

  /** Store mode and handle setup of a device; true when saved. */
  const saveNodeSettings = useCallback(async (node: Node, config: NodeConfig) => {
    try {
      await api.updateDevice(parseInt(node.id), {
        is_wlan: config.isWlan,
        is_ap: config.isAp,
        topology_config: JSON.stringify({ top_handle_type: config.topHandle, bottom_handle_type: config.bottomHandle }),
      });
      fetchData();
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }, [fetchData]);

  return {
    nodes, edges, setNodes, onNodesChange, onEdgesChange, isRefreshing,
    fetchData, onConnect, onRotateSpeed, onDeleteLink, saveNodeSettings,
  };
}

interface StickyDragOptions {
  nodes: Node[];
  edges: ReturnType<typeof useTopologyGraph>['edges'];
  setNodes: ReturnType<typeof useTopologyGraph>['setNodes'];
  enabled: boolean;
}

/** Save dragged positions; with sticky drag on, linked neighbours move along and are saved too. */
export function useStickyDrag({ nodes, edges, setNodes, enabled }: StickyDragOptions) {
  const [lastPos, setLastPos] = useState<{ x: number; y: number } | null>(null);

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    setLastPos({ x: node.position.x, y: node.position.y });
  }, []);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    if (!enabled || !lastPos) return;
    const dx = node.position.x - lastPos.x;
    const dy = node.position.y - lastPos.y;
    if (dx === 0 && dy === 0) return;

    const neighbors = collectNeighborIds(edges, node.id);
    setNodes(nds => nds.map(n => (neighbors.has(n.id)
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
      : n)));
    setLastPos({ x: node.position.x, y: node.position.y });
  }, [enabled, lastPos, edges, setNodes]);

  const onNodeDragStop = useCallback(async (_: unknown, node: Node) => {
    setLastPos(null);
    await saveNodePos(node.id, node.position);
    if (!enabled) return;
    for (const nid of collectNeighborIds(edges, node.id)) {
      const n = nodes.find(x => x.id === nid);
      if (n) await saveNodePos(n.id, n.position);
    }
  }, [enabled, edges, nodes]);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}

export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggle = () => {
    if (!ref.current) return;
    if (!document.fullscreenElement) {
      ref.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  return { isFullscreen, toggle };
}
