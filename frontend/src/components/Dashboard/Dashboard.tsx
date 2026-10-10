import { useState } from 'react';
import type { Device } from '../../types';
import { DeviceEditor } from './DeviceEditor';
import { Sidebar } from '../Sidebar';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentUpdateCenter } from './AgentUpdateCenter';
import { MobileHeader } from '../MobileHeader';
import { isAgentOutdated } from '../../utils/version';
import type { GroupKey } from './overview/layout';
import { useDashboardData, useDeviceActions, useGridLayout, useLiveRefresh, useScan, useViewMode } from './overview/hooks';
import { GroupSection } from './overview/GroupSection';
import { DashboardToolbar } from './overview/DashboardToolbar';
import { ScanProgressBar, SubnetModal } from './overview/ScanPanels';

// Gridstack
import 'gridstack/dist/gridstack.min.css';

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function Dashboard() {
  const { t } = useTranslation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<GroupKey>>(new Set());
  const [showUpdateCenter, setShowUpdateCenter] = useState(false);

  const { devices, setDevices, groups, setGroups, isLoading, setIsLoading, loadData } = useDashboardData();
  const { isMobile, viewMode, setViewMode } = useViewMode();
  const scan = useScan(loadData);
  useLiveRefresh(loadData, isEditMode, scan.isScanning);
  const { compactAll } = useGridLayout({ devices, setDevices, groups, isLoading, isEditMode, isMobile, viewMode, collapsedGroups, loadData });
  const actions = useDeviceActions({ devices, groups, setGroups, setIsLoading, loadData });

  const sidebar = <Sidebar active="dashboard" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />;
  const mobileHeader = <MobileHeader title={t('sidebar.dashboard')} onMenuClick={() => setIsSidebarOpen(true)} />;

  if (isLoading) {
    return (
      <div className="app-layout">
        {sidebar}
        <main className="app-main">
          {mobileHeader}
          <div className="empty-state">
            <div style={{ animation: 'pulse 2s infinite' }}>{t('dashboard.loading')}</div>
          </div>
        </main>
      </div>
    );
  }

  const outdatedAgents = devices.filter(d => d.has_agent && isAgentOutdated(d.agent_info?.agent_version, d.agent_info?.latest_version)).length;

  // Named groups with devices, then the unassigned devices (shown on their own when there are no groups).
  const sections = [...groups, null]
    .map((group) => ({ group, devices: devices.filter(d => d.group_id === (group ? group.id : null)) }))
    .filter(({ group, devices: inGroup }) => inGroup.length > 0 || (!group && groups.length === 0));

  return (
    <div className="app-layout">
      {sidebar}
      <main className="app-main">
        {mobileHeader}
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 'var(--space-xl)',
          flexWrap: isMobile ? 'wrap' : 'nowrap',
          gap: 'var(--space-md)'
        }}>
          <div>
            <h1 className="visually-hidden-mobile" style={{ marginBottom: 4, fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.01em' }}>{t('sidebar.dashboard')}</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              {t('dashboard.devices_sections', { devices: devices.length, groups: groups.length })}
            </p>
          </div>

          <DashboardToolbar
            isMobile={isMobile}
            viewMode={viewMode}
            onViewMode={setViewMode}
            isEditMode={isEditMode}
            onToggleEdit={() => setIsEditMode(!isEditMode)}
            selectedCount={actions.selectedIds.size}
            onBulkDelete={actions.bulkDelete}
            onCompact={compactAll}
            onResetLayout={actions.resetLayout}
            isRefreshingAll={actions.isRefreshingAll}
            isScanning={scan.isScanning}
            onRefreshAll={actions.refreshAll}
            onScan={scan.openSubnetModal}
            outdatedAgents={outdatedAgents}
            onShowUpdates={() => setShowUpdateCenter(true)}
          />
        </div>

        {showUpdateCenter && (
          <AgentUpdateCenter
            devices={devices}
            onClose={() => setShowUpdateCenter(false)}
            onComplete={() => loadData(true)}
          />
        )}

        {scan.isScanning && scan.scanProgress && <ScanProgressBar progress={scan.scanProgress} />}

        {sections.map(({ group, devices: inGroup }) => {
          const key: GroupKey = group ? group.id : 'null';
          const index = group ? groups.findIndex(g => g.id === group.id) : -1;
          return (
            <GroupSection
              key={key}
              group={group}
              devices={inGroup}
              isFirst={index === 0}
              isLast={index === groups.length - 1}
              isCollapsed={collapsedGroups.has(key)}
              isEditMode={isEditMode}
              viewMode={viewMode}
              selectedIds={actions.selectedIds}
              onToggle={() => setCollapsedGroups(prev => toggled(prev, key))}
              onMove={(direction) => group && actions.moveGroup(group, direction)}
              onSelect={actions.toggleSelected}
              onEdit={setSelectedDevice}
              onRefresh={() => loadData(true)}
            />
          );
        })}

        {selectedDevice && (
          <DeviceEditor
            device={selectedDevice}
            devices={devices}
            onClose={() => setSelectedDevice(null)}
            onSave={() => loadData(true)}
          />
        )}

        {scan.showSubnetModal && (
          <SubnetModal
            subnets={scan.availableSubnets}
            selected={scan.selectedSubnet}
            onSelect={scan.setSelectedSubnet}
            onClose={scan.closeSubnetModal}
            onStart={() => scan.startScan(scan.selectedSubnet)}
          />
        )}

        {devices.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__icon">🔍</div>
            <h3>{t('dashboard.no_devices_title')}</h3>
            <p style={{ marginBottom: 'var(--space-lg)' }}>
              {t('dashboard.no_devices_text')}
            </p>
            <button className="btn btn-primary" onClick={scan.openSubnetModal}>
              <RefreshCw size={16} /> {t('dashboard.scan_now')}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
