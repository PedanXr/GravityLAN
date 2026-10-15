import { useState, useEffect, useMemo } from 'react';
import { Sidebar } from '../Sidebar';
import type { Device } from '../../types';
import { DeviceEditor } from '../Dashboard/DeviceEditor';
import { useTranslation } from 'react-i18next';
import { useNetwork } from '../../context/NetworkContext';
import { MobileHeader } from '../MobileHeader';
import { IPTile } from './IPTile';
import { buildTiles, countOnline, prefixOf, recentFindings, type NetworkArea } from './subnet/model';
import { useHostActions, useSubnetData } from './subnet/hooks';
import { AreaManagerModal, EMPTY_AREA, RecentFindings, SubnetHeader, SubnetSettingsModal, SubnetTabs } from './subnet/SubnetParts';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isMobile;
}

export function SubnetView() {
  const { t } = useTranslation();
  const { discoveredHosts, isDiscovering, runDiscovery, updateDiscoveredHost } = useNetwork();
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showSubnetSettings, setShowSubnetSettings] = useState(false);
  const [newArea, setNewArea] = useState<NetworkArea>(EMPTY_AREA);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);

  const data = useSubnetData();
  const { devices, subnetPrefix, setSubnetPrefix, areas, loadData } = data;
  const actions = useHostActions(loadData);

  const safeZoom = zoom || 1;
  const columns = Math.floor(16 / safeZoom) || 1;
  const tiles = useMemo(
    () => buildTiles(subnetPrefix, devices, discoveredHosts, areas, columns),
    [subnetPrefix, devices, discoveredHosts, areas, columns],
  );
  const onlineCount = useMemo(() => countOnline(subnetPrefix, devices, discoveredHosts), [devices, discoveredHosts, subnetPrefix]);

  return (
    <div className="app-layout">
      <Sidebar active="network" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      <main className="app-main">
        <MobileHeader title={t('sidebar.network_planner')} onMenuClick={() => setIsSidebarOpen(true)} />
        <div className="subnet-container">
          <SubnetTabs
            subnets={data.subnets}
            activePrefix={subnetPrefix}
            onSelect={setSubnetPrefix}
            onDelete={data.deleteSubnet}
            onAdd={data.addSubnet}
          />

          <SubnetHeader
            isMobile={isMobile}
            onlineCount={onlineCount}
            zoom={zoom}
            onZoom={setZoom}
            isDiscovering={isDiscovering}
            onManageAreas={() => setShowGroupModal(true)}
            onSubnetSettings={() => setShowSubnetSettings(true)}
            onDiscover={() => runDiscovery(subnetPrefix)}
            currentSubnet={data.subnets.find(s => prefixOf(s.cidr) === subnetPrefix)}
          />

          {/* Phones get the same IP map as a compact auto-fill grid (a list made every square tile screen-wide) */}
          <div className="subnet-grid" style={!isMobile ? { gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: `${Math.floor(12 * safeZoom)}px` } : undefined}>
            {tiles
              .filter(tile => !isMobile || tile.status !== 'empty')
              .map(tile => {
                const busy = actions.isBusy(tile.ip);
                return (
                  <IPTile
                    key={tile.i}
                    {...tile}
                    safeZoom={isMobile ? 1 : safeZoom}
                    t={t}
                    onSelectDevice={setSelectedDevice}
                    onUpdateDeviceField={actions.updateDeviceField}
                    onUpdateDiscoveredHost={updateDiscoveredHost}
                    onRefreshDevice={actions.refreshDevice}
                    onScanDiscoveredHost={actions.scanDiscoveredHost}
                    onAddDevice={actions.addDevice}
                    onDeleteDiscoveredHost={actions.deleteDiscoveredHost}
                    isRefreshingServices={busy.services}
                    isRefreshingAdd={busy.add}
                  />
                );
              })}
          </div>

          {discoveredHosts.length > 0 && (
            <RecentFindings hosts={recentFindings(discoveredHosts, devices)} onSelect={setSubnetPrefix} />
          )}
        </div>

        {showSubnetSettings && (
          <SubnetSettingsModal
            subnets={data.subnets}
            onUpdate={data.updateSubnet}
            onDelete={data.deleteSubnet}
            onClose={() => setShowSubnetSettings(false)}
          />
        )}

        {showGroupModal && (
          <AreaManagerModal
            areas={areas}
            draft={newArea}
            onDraft={setNewArea}
            onSave={data.saveAreas}
            onClose={() => setShowGroupModal(false)}
          />
        )}

        {selectedDevice && (
          <DeviceEditor device={selectedDevice} onClose={() => setSelectedDevice(null)} onSave={loadData} />
        )}
      </main>
    </div>
  );
}
