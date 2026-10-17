import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { GridStack, type GridStackNode } from 'gridstack';
import { api, createScanSocket } from '../../../api/client';
import type { Device, DeviceGroup, ScanProgress, Subnet } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { swapGroupOrder, type GroupKey } from './layout';

const isMobileWidth = () => window.innerWidth < 768;

/** Phone layout flag; the free-form card grid does not fit phones, so they always get the list. */
export function useViewMode() {
  const [isMobile, setIsMobile] = useState(isMobileWidth());
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(isMobile ? 'list' : 'grid');
  useEffect(() => {
    const handleResize = () => {
      const mobile = isMobileWidth();
      setIsMobile(mobile);
      if (mobile) setViewMode('list');
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return { isMobile, viewMode, setViewMode };
}

/** Devices and groups, loaded on mount. */
export function useDashboardData() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async (silent = false) => {
    if (!silent && devices.length === 0) setIsLoading(true);
    try {
      const [devicesData, groupsData] = await Promise.all([
        api.getDevices(),
        api.getGroups()
      ]);
      setDevices(devicesData);
      setGroups(groupsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [devices.length]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  return { devices, setDevices, groups, setGroups, isLoading, setIsLoading, loadData };
}

/**
 * Keep the overview current outside edit mode: reload when a scan completes and
 * poll every 10 s during a scan, 30 s otherwise.
 */
export function useLiveRefresh(loadData: (silent?: boolean) => Promise<void>, paused: boolean, isScanning: boolean) {
  useEffect(() => {
    if (paused) return;
    const ws = createScanSocket((data) => {
      const status = String(data.status);
      if (status === 'COMPLETED' || status === 'completed') {
        loadData(true);
      }
    });
    const interval = setInterval(() => {
      loadData(true);
    }, isScanning ? 10000 : 30000);
    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, [loadData, paused, isScanning]);
}

interface GridLayoutOptions {
  devices: Device[];
  setDevices: Dispatch<SetStateAction<Device[]>>;
  groups: DeviceGroup[];
  isLoading: boolean;
  isEditMode: boolean;
  isMobile: boolean;
  viewMode: 'grid' | 'list';
  collapsedGroups: Set<GroupKey>;
  loadData: (silent?: boolean) => Promise<void>;
}

type GridMap = Record<string, GridStack>;

function destroyGrids(grids: GridMap) {
  Object.values(grids).forEach(g => {
    try {
      if (g && typeof g.destroy === 'function') g.destroy(false);
    } catch (e) {
      console.warn('GridStack destroy safely ignored:', e);
    }
  });
}

function startGroupGrid(el: HTMLElement, isMobile: boolean, isEditMode: boolean): GridStack {
  return GridStack.init({
    column: isMobile ? 1 : 12,
    cellHeight: isMobile ? 'auto' : 50,
    margin: 10,
    float: true, // Keep freedom
    staticGrid: !isEditMode,
    alwaysShowResizeHandle: isEditMode,
    resizable: { handles: 'se' },
    acceptWidgets: true,
  }, el);
}

const tileId = (el: Element | undefined) => parseInt(el?.getAttribute('gs-id') || '0');

/** Edit mode: save tiles dropped in from another group, and moved or resized tiles. */
function saveTileChanges(
  grid: GridStack,
  groupId: number | null,
  setDevices: Dispatch<SetStateAction<Device[]>>,
  loadData: (silent?: boolean) => Promise<void>,
) {
  // GridStack moves a tile dropped from another group into this grid's DOM, but React rendered
  // that element in the old group and crashes ("removeChild") when it re-renders. So hand the
  // element back, hidden, to where React put it; after saving, the reload moves the card itself.
  grid.on('dropped', async (_event, previous: GridStackNode | undefined, dropped: GridStackNode) => {
    const el = dropped?.el;
    const devId = tileId(el);
    const home = previous?.grid?.el;
    if (!el || !devId || !home) return;
    const { x, y, w, h } = dropped;
    grid.removeWidget(el, false);
    el.style.display = 'none';
    home.appendChild(el);
    try {
      await api.updateDevice(devId, { group_id: groupId, x, y, w, h });
      loadData(true);
    } catch (err) {
      console.error('Failed to move tile to another group:', err);
      el.style.display = '';
      previous!.grid!.makeWidget(el);
    }
  });

  const saveTile = (_event: Event, tile: HTMLElement) => {
    const node = (tile as HTMLElement & { gridstackNode?: GridStackNode }).gridstackNode;
    const devId = tileId(tile);
    if (!node || !devId) return;
    setDevices(prev => prev.map(d => d.id === devId ? { ...d, x: node.x ?? null, y: node.y ?? null, w: node.w ?? null, h: node.h ?? null } : d));
    api.updateDevice(devId, { x: node.x, y: node.y, w: node.w, h: node.h })
      .catch(err => console.error("Failed to save layout:", err));
  };
  grid.on('dragstop', saveTile);
  grid.on('resizestop', saveTile);
}

/**
 * One GridStack per expanded group. Grids are static outside edit mode; in edit
 * mode drags, resizes and drops between groups are saved to the device.
 */
export function useGridLayout({ devices, setDevices, groups, isLoading, isEditMode, isMobile, viewMode, collapsedGroups, loadData }: GridLayoutOptions) {
  const gridRefs = useRef<GridMap>({});

  const layoutDependencies = useMemo(() => {
    return devices.map(d => `${d.id}:${d.group_id}:${d.w}:${d.h}`).join(',');
  }, [devices]);

  useEffect(() => {
    const destroyAll = () => {
      destroyGrids(gridRefs.current);
      gridRefs.current = {};
    };

    destroyAll();
    if (isLoading || devices.length === 0 || viewMode === 'list') return;

    const groupIds = [...groups.map(g => g.id.toString()), 'null'];
    groupIds.forEach(id => {
      const el = collapsedGroups.has(id) ? null : document.querySelector<HTMLElement>(`.grid-stack-${id}`);
      if (!el) return;
      const groupId = id === 'null' ? null : parseInt(id);
      const grid = startGroupGrid(el, isMobile, isEditMode);
      gridRefs.current[id] = grid;

      if (isEditMode) {
        saveTileChanges(grid, groupId, setDevices, loadData);
      } else if (devices.some(d => d.group_id === groupId && d.x === null)) {
        // AUTO-LAYOUT: tiles without a saved position get one compact pass
        grid.batchUpdate();
        grid.compact();
        grid.batchUpdate(false);
      }
    });

    return destroyAll;
  }, [isLoading, layoutDependencies, groups.length, isEditMode, collapsedGroups, viewMode]);

  /** Close the gaps between tiles in every grid. */
  const compactAll = () => {
    Object.values(gridRefs.current).forEach(g => {
      if (g) {
        g.float(false);
        g.compact();
        g.float(true);
      }
    });
  };

  return { compactAll };
}

interface DeviceActionsOptions {
  devices: Device[];
  groups: DeviceGroup[];
  setGroups: Dispatch<SetStateAction<DeviceGroup[]>>;
  setIsLoading: (loading: boolean) => void;
  loadData: (silent?: boolean) => Promise<void>;
}

/** Toolbar and edit-mode actions that change devices or groups on the server. */
export function useDeviceActions({ devices, groups, setGroups, setIsLoading, loadData }: DeviceActionsOptions) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const toggleSelected = (id: number, selected: boolean) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (selected) next.add(id);
    else next.delete(id);
    return next;
  });

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(t('dashboard.bulk_delete_confirm', { count: selectedIds.size }))) return;
    setIsLoading(true);
    try {
      await api.bulkDeleteDevices(Array.from(selectedIds));
      setSelectedIds(new Set());
      await loadData(true);
    } catch (err) {
      console.error('Bulk delete failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const moveGroup = async (group: DeviceGroup, direction: 'up' | 'down') => {
    const change = swapGroupOrder(groups, group, direction);
    if (!change) return;
    setGroups(change.groups);
    try {
      for (const { id, sort_order } of change.updates) {
        await api.updateGroup(id, { sort_order });
      }
    } catch (err) {
      console.error("Failed to reorder groups:", err);
    }
    loadData(true);
  };

  const refreshAll = async () => {
    setIsRefreshingAll(true);
    showToast('info', t('dashboard.refreshing'), t('notifications.refresh_started_details'));
    try {
      await api.refreshAllDevices();
      // Delay a bit to allow background task to start
      setTimeout(() => loadData(true), 1500);
      showToast('success', t('dashboard.refresh_all'), t('notifications.info_updated') || 'Refresh gestartet.');
    } catch (err) {
      console.error('Refresh failed:', err);
      showToast('error', t('common.error'), t('notifications.refresh_failed', { error: '', defaultValue: 'Refresh failed.' }));
    } finally {
      setIsRefreshingAll(false);
    }
  };

  const resetLayout = async () => {
    if (!confirm(t('dashboard.reset_layout_confirm'))) return;
    setIsLoading(true);
    try {
      await Promise.all(devices.map(d =>
        api.updateDevice(d.id, { x: null, y: null, w: null, h: null })
      ));
      window.location.reload();
    } catch (err) {
      console.error('Reset failed:', err);
      setIsLoading(false);
    }
  };

  return { selectedIds, toggleSelected, bulkDelete, moveGroup, isRefreshingAll, refreshAll, resetLayout };
}

/** Scan states that mean the scan is still going (the backend sends 'devices_updated' mid-scan). */
const SCAN_ACTIVE: ScanProgress['status'][] = ['running', 'discovering', 'identifying', 'devices_updated'];

/** A subnet the dashboard scan can target, with a line saying what it is. */
export interface ScanTarget {
  subnet: string;
  label: string;
}

/** The enabled scan subnets of the network overview; only without any, the container's own interfaces. */
async function loadScanTargets(): Promise<ScanTarget[]> {
  let configured: Subnet[] = [];
  try {
    const list = await api.getSubnetsList();
    configured = Array.isArray(list) ? list.filter((s) => s.is_enabled !== false) : [];
  } catch (err) {
    console.warn('Loading the scan subnets failed, offering the local interfaces:', err);
  }
  if (configured.length > 0) return configured.map((s) => ({ subnet: s.cidr, label: s.name }));
  return (await api.getSubnets()).map((s) => ({ subnet: s.subnet, label: `Interface: ${s.interface_name} (${s.ip_address})` }));
}

/** Subnet picker and dashboard scan with progress polling every 5 s. */
export function useScan(loadData: (silent?: boolean) => Promise<void>) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [showSubnetModal, setShowSubnetModal] = useState(false);
  const [availableSubnets, setAvailableSubnets] = useState<ScanTarget[]>([]);
  const [selectedSubnet, setSelectedSubnet] = useState<string>('');

  const pollProgress = () => {
    const interval = setInterval(async () => {
      try {
        const progress = await api.getScanStatus();
        setScanProgress(progress);
        if (!SCAN_ACTIVE.includes(progress.status)) {
          clearInterval(interval);
          setIsScanning(false);
          await loadData();
          if (progress.status === 'failed') {
            showToast(
              'error',
              t('notifications.scan_failed', 'Scan failed'),
              progress.message || t('notifications.scan_failed_text')
            );
          } else {
            showToast(
              'success',
              t('notifications.scan_completed', 'Scan completed'),
              t('setup.devices_found', { count: progress.devices_found ?? '?' })
            );
          }
        }
      } catch (e) {
        console.error("Progress poll failed", e);
      }
    }, 5000);
  };

  const startScan = async (subnetToScan?: string) => {
    setIsScanning(true);
    setScanProgress(null);
    setShowSubnetModal(false);
    try {
      const subnets = subnetToScan ? [subnetToScan] : (await loadScanTargets()).map(s => s.subnet);
      const res = await api.startDashboardScan({ subnets });
      if (res.status !== 'ok') {
        alert("Scan Error: " + (res as { message?: string }).message);
      }
      pollProgress();
    } catch (err) {
      console.error("Scan trigger failed", err);
      alert("Critical Scan Failure: " + (err as Error).message);
      setIsScanning(false);
    }
  };

  const openSubnetModal = async () => {
    try {
      const subnets = await loadScanTargets();
      if (!subnets || subnets.length === 0) {
        alert("No subnets found! Check your network settings.");
        return;
      }
      setAvailableSubnets(subnets);
      setSelectedSubnet(subnets[0].subnet);
      setShowSubnetModal(true);
    } catch (err) {
      console.error('Failed to fetch subnets:', err);
      alert("Error loading subnets: " + (err as Error).message);
    }
  };

  return {
    isScanning, scanProgress,
    showSubnetModal, closeSubnetModal: () => setShowSubnetModal(false),
    availableSubnets, selectedSubnet, setSelectedSubnet,
    openSubnetModal, startScan,
  };
}
