import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, createScanSocket } from '../../../api/client';
import type { Device, DiscoveredHost, Subnet } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { useNetwork } from '../../../context/NetworkContext';
import { normalizeCidr, parseAreas, prefixOf, type AreasByPrefix, type NetworkArea } from './model';

/**
 * Devices, subnets and areas of the IP map. The shown /24 defaults to the first
 * subnet (or the first device); it is quick-scanned once when first shown.
 */
export function useSubnetData() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { isDiscovering } = useNetwork();
  const [devices, setDevices] = useState<Device[]>([]);
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [subnetPrefix, setSubnetPrefix] = useState('');
  const [areas, setAreas] = useState<AreasByPrefix>({});
  const lastScannedPrefix = useRef<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const devs = await api.getDevices().catch(() => []);
      const sets: Record<string, unknown> = await api.getSettings().catch(() => ({}));
      const safeDevices = Array.isArray(devs) ? devs : [];
      setDevices(safeDevices);

      if (sets && sets['network_groups']) {
        try {
          setAreas(parseAreas(sets['network_groups'], subnetPrefix));
        } catch (e) {
          console.warn('Failed to parse network_groups:', e);
          setAreas({});
        }
      }

      const subnetList = await api.getSubnetsList().catch(() => []);
      if (Array.isArray(subnetList)) {
        setSubnets(subnetList);
        const match = subnetList[0]?.cidr.match(/^(\d+\.\d+\.\d+)/);
        if (match && !subnetPrefix) setSubnetPrefix(match[1]);
      }

      const fromDevice = safeDevices[0]?.ip?.match(/(\d+\.\d+\.\d+)\./);
      if (!subnetPrefix && fromDevice) setSubnetPrefix(fromDevice[1]);
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, [subnetPrefix]);

  // Reload when a scan completes and poll every 10 s during a discovery, 30 s otherwise
  useEffect(() => {
    loadData();
    const ws = createScanSocket((data) => {
      const status = String(data.status);
      if (status === 'COMPLETED' || status === 'completed') loadData();
    });
    const interval = setInterval(loadData, isDiscovering ? 10000 : 30000);
    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, [loadData, isDiscovering]);

  useEffect(() => {
    if (!subnetPrefix || subnetPrefix === lastScannedPrefix.current) return;
    lastScannedPrefix.current = subnetPrefix;
    api.quickSubnetScan(subnetPrefix)
      .then(() => loadData())
      .catch((err) => console.error("Auto quick scan failed:", err));
  }, [subnetPrefix, loadData]);

  const saveAreas = async (updated: NetworkArea[]) => {
    const next = { ...areas, [subnetPrefix]: updated };
    setAreas(next);
    try {
      await api.updateSettings({ 'network_groups': JSON.stringify(next) });
      showToast('success', t('notifications.saved'), t('notifications.area_saved'));
    } catch {
      showToast('error', t('common.error'), t('notifications.save_failed'));
    }
  };

  const addSubnet = async () => {
    const input = prompt(t('network.new_subnet_prompt'));
    if (!input) return;
    const cidr = normalizeCidr(input);
    try {
      await api.createSubnet({ cidr, name: `Network ${cidr}`, is_enabled: true });
      showToast('success', t('notifications.saved'), t('network.add_subnet'));
      loadData();
    } catch (err) {
      showToast('error', t('common.error'), (err as Error).message || t('notifications.save_failed'));
    }
  };

  /** Delete after confirmation; the map falls back to the first subnet when the shown one goes. */
  const deleteSubnet = async (sub: Subnet) => {
    if (!confirm(`${t('common.delete')} ${sub.cidr}?`)) return;
    try {
      await api.deleteSubnet(sub.id);
      showToast('success', t('common.success'), t('notifications.deleted'));
      await loadData();
      if (subnetPrefix === prefixOf(sub.cidr)) setSubnetPrefix('');
    } catch {
      showToast('error', t('common.error'), t('notifications.save_failed'));
    }
  };

  const updateSubnet = (id: number, data: { name?: string; dns_server?: string | null; is_enabled?: boolean }) =>
    api.updateSubnet(id, data)
      .then(loadData)
      .catch((err) => showToast('error', t('common.error'), (err as Error).message || t('notifications.save_failed')));

  return {
    devices, subnets, subnetPrefix, setSubnetPrefix,
    areas: areas[subnetPrefix] || [], saveAreas,
    loadData, addSubnet, deleteSubnet, updateSubnet,
  };
}

/** Per-address actions of the map tiles, with a busy flag per address and action. */
export function useHostActions(loadData: () => Promise<void>) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { setDiscoveredHosts } = useNetwork();
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const withBusy = async (key: string, run: () => Promise<void>) => {
    setBusy(prev => ({ ...prev, [key]: true }));
    try {
      await run();
    } finally {
      setBusy(prev => ({ ...prev, [key]: false }));
    }
  };

  const refreshDevice = useCallback((id: number, ip: string, type: 'info' | 'services') => withBusy(`${ip}-${type}`, async () => {
    showToast('info', type === 'info' ? t('common.loading') : `${t('network.nmap_scan')}...`, `${t('common.loading')} ${ip}...`);
    try {
      await (type === 'info' ? api.refreshDeviceInfo(id) : api.refreshServices(id));
      await loadData();
      showToast('success', t('common.success'), t('notifications.changes_applied'));
    } catch {
      showToast('error', t('common.error'), t('notifications.save_failed'));
    }
  }), [loadData, t, showToast]);

  const updateDeviceField = useCallback(async (id: number, data: Partial<Device>) => {
    try {
      await api.updateDevice(id, data);
      showToast('success', t('notifications.saved'), t('notifications.changes_applied'));
      await loadData();
    } catch {
      showToast('error', t('common.error'), t('notifications.save_failed'));
    }
  }, [loadData, t, showToast]);

  const scanDiscoveredHost = useCallback((ip: string) => withBusy(`${ip}-disc`, async () => {
    showToast('info', `${t('network.nmap_scan')}...`, `${t('common.loading')} ${ip}...`);
    try {
      const result = await api.scanIp(ip);
      const ports: number[] = (result as { ports?: number[] }).ports || [];
      setDiscoveredHosts((prev: DiscoveredHost[]) => prev.map((h: DiscoveredHost) =>
        h.ip === ip ? { ...h, ports, last_scan: new Date().toISOString() } : h
      ));
      showToast('success', t('notifications.scan_completed'), t('network.ports_found', { ports: ports.join(', ') || t('network.no_ports_found') }));
    } catch {
      showToast('error', t('notifications.scan_failed'), t('notifications.scan_failed_text'));
    }
  }), [t, showToast, setDiscoveredHosts]);

  const addDevice = useCallback((ip: string) => withBusy(`${ip}-add`, async () => {
    try {
      await api.addDeviceFromIp(ip);
      showToast('success', t('common.success'), t('notifications.device_added', { ip }));
      await loadData();
      setDiscoveredHosts((prev: DiscoveredHost[]) => prev.filter(h => h.ip !== ip));
    } catch (err) {
      showToast('error', t('common.error'), (err as Error).message || t('notifications.save_failed'));
    }
  }), [loadData, t, showToast, setDiscoveredHosts]);

  const deleteDiscoveredHost = useCallback(async (id: number, ip: string) => {
    try {
      await api.deleteDiscoveredHost(id);
      showToast('success', t('common.success'), t('notifications.host_removed', { ip, defaultValue: `Host ${ip} removed` }));
      setDiscoveredHosts((prev: DiscoveredHost[]) => prev.filter(h => h.id !== id));
    } catch {
      showToast('error', t('common.error'), t('notifications.delete_failed', 'Delete failed'));
    }
  }, [t, showToast, setDiscoveredHosts]);

  const isBusy = (ip: string) => ({
    services: !!(busy[`${ip}-services`] || busy[`${ip}-info`] || busy[`${ip}-disc`]),
    add: !!busy[`${ip}-add`],
  });

  return { refreshDevice, updateDeviceField, scanDiscoveredHost, addDevice, deleteDiscoveredHost, isBusy };
}
