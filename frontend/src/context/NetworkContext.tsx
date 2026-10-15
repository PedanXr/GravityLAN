import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, createScanSocket } from '../api/client';
import { useToast } from './ToastContext';
import { useTranslation } from 'react-i18next';
import { DiscoveredHost } from '../types';

interface NetworkContextType {
  discoveredHosts: DiscoveredHost[];
  setDiscoveredHosts: React.Dispatch<React.SetStateAction<DiscoveredHost[]>>;
  isDiscovering: boolean;
  runDiscovery: (subnetPrefix: string) => Promise<void>;
  updateDiscoveredHost: (id: number, data: { custom_name?: string; is_monitored?: boolean; is_reserved?: boolean }) => Promise<void>;
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [discoveredHosts, setDiscoveredHosts] = useState<DiscoveredHost[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);

  // Initial load and WebSocket listener
  useEffect(() => {
    const fetchHosts = () => api.getDiscoveredHosts().then(setDiscoveredHosts).catch(console.error);
    
    // Initial fetch
    fetchHosts();

    // Listen for background scan updates
    const ws = createScanSocket((data: any) => {
      if (data.status === 'COMPLETED' || data.status === 'completed') {
        fetchHosts();
      }
    });

    const interval = setInterval(fetchHosts, 15000);

    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, []);

  const runDiscovery = useCallback(async (subnetPrefix: string) => {
    setIsDiscovering(true);
    showToast('info', t('common.loading'), `${t('network.scan_subnet')} ${subnetPrefix}.0/24...`);
    try {
      const res = await api.liveDiscovery({ subnets: [`${subnetPrefix}.0/24`] });
      const foundCount = Array.isArray(res) ? res.length : 0;
      
      // Refresh the full state from the database to avoid wiping other subnets from the UI
      const updatedHosts = await api.getDiscoveredHosts();
      setDiscoveredHosts(updatedHosts);
      showToast('success', t('notifications.scan_completed'), t('notifications.devices_discovered', { count: foundCount }));
    } catch (err: any) {
      showToast('error', t('notifications.scan_failed'), err.message || t('notifications.scan_failed_text'));
    } finally {
      setIsDiscovering(false);
    }
  }, [showToast, t]);

  const updateDiscoveredHost = useCallback(async (id: number, data: any) => {
    try {
      const updated = await api.patchDiscoveredHost(id, data);
      setDiscoveredHosts(prev => prev.map(h => h.id === id ? updated : h));
      showToast('success', t('notifications.saved'), t('notifications.changes_applied'));
    } catch (err: any) {
      showToast('error', t('common.error'), t('notifications.device_update_failed'));
    }
  }, [setDiscoveredHosts, showToast, t]);

  return (
    <NetworkContext.Provider value={{ 
      discoveredHosts, 
      setDiscoveredHosts, 
      isDiscovering, 
      runDiscovery,
      updateDiscoveredHost
    }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  const context = useContext(NetworkContext);
  if (context === undefined) {
    throw new Error('useNetwork must be used within a NetworkProvider');
  }
  return context;
}
