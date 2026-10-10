import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api, createScanSocket } from '../../api/client';
import type { Device, DeviceGroup } from '../../types';
import { DeviceCard } from './DeviceCard';
import { DeviceList } from './DeviceList';
import { DeviceEditor } from './DeviceEditor';
import { Sidebar } from '../Sidebar';
import {
  RefreshCw, Edit3, Save, Trash2, ChevronRight, ChevronDown, Grid, ChevronUp, List, Zap
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NotificationCenter } from './NotificationCenter';
import { AgentUpdateCenter } from './AgentUpdateCenter';
import { MobileHeader } from '../MobileHeader';
import { useToast } from '../../context/ToastContext';
import { isAgentOutdated } from '../../utils/version';

// Gridstack
import 'gridstack/dist/gridstack.min.css';
import { GridStack } from 'gridstack';

export function Dashboard() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<any>(null);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(isMobile ? 'list' : 'grid');

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      // The free-form card grid does not fit phones; they always get the list.
      if (mobile) setViewMode('list');
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number | string>>(new Set());
  const [showSubnetModal, setShowSubnetModal] = useState(false);
  const [availableSubnets, setAvailableSubnets] = useState<any[]>([]);
  const [selectedSubnet, setSelectedSubnet] = useState<string>('');
  const [showUpdateCenter, setShowUpdateCenter] = useState(false);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<number>>(new Set());

  const handleBulkDelete = async () => {
    if (selectedDeviceIds.size === 0) return;
    if (!confirm(t('dashboard.bulk_delete_confirm', { count: selectedDeviceIds.size }))) return;
    
    setIsLoading(true);
    try {
      await api.bulkDeleteDevices(Array.from(selectedDeviceIds));
      setSelectedDeviceIds(new Set());
      await loadData(true);
    } catch (err) {
      console.error('Bulk delete failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleDeviceSelection = (id: number, selected: boolean) => {
    const next = new Set(selectedDeviceIds);
    if (selected) next.add(id);
    else next.delete(id);
    setSelectedDeviceIds(next);
  };
  
  const gridRefs = useRef<Record<string, GridStack>>({});

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

  useEffect(() => {
    if (isEditMode) return;
    
    const ws = createScanSocket((data: any) => {
      if (data.status === 'COMPLETED' || data.status === 'completed') {
        loadData(true);
      }
    });
    
    // Adaptive polling: 10s during scan, 30s normally, 60s if inactive (optional)
    const pollInterval = isScanning ? 10000 : 30000;
    const interval = setInterval(() => {
      loadData(true);
    }, pollInterval);
    
    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, [loadData, isEditMode, isScanning]);

  const toggleGroup = (id: number | string) => {
    const next = new Set(collapsedGroups);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsedGroups(next);
  };

  const moveGroup = async (e: React.MouseEvent, group: DeviceGroup, direction: 'up' | 'down') => {
    e.stopPropagation();
    
    const currentIndex = groups.findIndex(g => g.id === group.id);
    if (currentIndex === -1) return;
    
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= groups.length) return;
    
    const targetGroup = groups[targetIndex];
    
    const currentOrder = group.sort_order ?? currentIndex;
    const targetOrder = targetGroup.sort_order ?? targetIndex;

    let newCurrentOrder = targetOrder;
    let newTargetOrder = currentOrder;

    if (newCurrentOrder === newTargetOrder) {
        newCurrentOrder = direction === 'up' ? targetOrder - 1 : targetOrder + 1;
    }

    const newGroups = [...groups];
    newGroups[currentIndex] = { ...group, sort_order: newCurrentOrder };
    newGroups[targetIndex] = { ...targetGroup, sort_order: newTargetOrder };
    newGroups.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    setGroups(newGroups);
    
    try {
      await api.updateGroup(group.id, { sort_order: newCurrentOrder });
      await api.updateGroup(targetGroup.id, { sort_order: newTargetOrder });
      loadData(true);
    } catch (err) {
      console.error("Failed to reorder groups:", err);
      loadData(true);
    }
  };

  const layoutDependencies = useMemo(() => {
    return devices.map(d => `${d.id}:${d.group_id}:${d.w}:${d.h}`).join(',');
  }, [devices]);

  useEffect(() => {
    if (isLoading || devices.length === 0 || viewMode === 'list') {
      // Cleanup grids if we switch to list mode
      Object.values(gridRefs.current).forEach(g => g.destroy(false));
      gridRefs.current = {};
      return;
    }

    Object.values(gridRefs.current).forEach(g => g.destroy(false));
    gridRefs.current = {};

    const groupIds = [...groups.map(g => g.id.toString()), 'null'];
    
    groupIds.forEach(id => {
      if (collapsedGroups.has(id)) return;

      const groupDevices = devices.filter(d => d.group_id === (id === 'null' ? null : parseInt(id)));
      const el = document.querySelector(`.grid-stack-${id}`) as HTMLElement;
      if (el) {
        gridRefs.current[id] = GridStack.init({
          column: isMobile ? 1 : 12,
          cellHeight: isMobile ? 'auto' : 50,
          margin: 10,
          float: true, // Keep freedom
          staticGrid: !isEditMode,
          alwaysShowResizeHandle: isEditMode,
          resizable: { handles: 'se' },
          acceptWidgets: true,
        }, el);

        // AUTO-LAYOUT: If many items have auto-position, trigger a compact pass
        const hasNewItems = groupDevices.some(d => d.x === null);
        if (hasNewItems && !isEditMode) {
          gridRefs.current[id].batchUpdate();
          gridRefs.current[id].compact();
          gridRefs.current[id].batchUpdate(false);
        }

        gridRefs.current[id].on('added', async (_event, items) => {
          if (!isEditMode) return;
          if (!items || Array.isArray(items) === false) return;
          const itemArray = items as any[];
          
          for (const item of itemArray) {
            const devId = parseInt(item.el?.getAttribute('gs-id') || '0');
            const targetGroupId = id === 'null' ? null : parseInt(id);
            
            if (devId) {
              await api.updateDevice(devId, {
                group_id: targetGroupId,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h
              });
              loadData(true);
            }
          }
        });

        const handleUserInteraction = (_event: Event, el: HTMLElement) => {
          if (!isEditMode) return;
          
          const itemEl = el as any;
          const node = itemEl.gridstackNode;
          if (!node) return;

          const devId = parseInt(el.getAttribute('gs-id') || '0');
          if (!devId) return;

          setDevices(prev => {
            const next = [...prev];
            const idx = next.findIndex(d => d.id === devId);
            if (idx !== -1) {
              next[idx] = { ...next[idx], x: node.x, y: node.y, w: node.w, h: node.h };
            }
            return next;
          });

          api.updateDevice(devId, {
            x: node.x, y: node.y, w: node.w, h: node.h
          }).catch(err => console.error("Failed to save layout:", err));
        };

        gridRefs.current[id].on('dragstop', handleUserInteraction);
        gridRefs.current[id].on('resizestop', handleUserInteraction);
      }
    });

    return () => {
      Object.values(gridRefs.current).forEach(g => {
        try {
          if (g && typeof g.destroy === 'function') g.destroy(false);
        } catch (e) {
          console.warn('GridStack destroy safely ignored:', e);
        }
      });
      gridRefs.current = {};
    };
  }, [isLoading, layoutDependencies, groups.length, isEditMode, collapsedGroups, viewMode]);

  const handleRefreshAll = async () => {
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

  const handleRescan = useCallback(async (subnetToScan?: string) => {
    setIsScanning(true);
    setScanProgress(null);
    setShowSubnetModal(false);
    console.log("DEBUG: handleRescan triggered", { subnetToScan });
    try {
      const subnets = subnetToScan ? [subnetToScan] : (await api.getSubnets()).map(s => s.subnet);
      console.log("DEBUG: Starting Dashboard Scan for subnets:", subnets);
      
      const res = await api.startDashboardScan({
        subnets: subnets,
      });
      
      if (res.status !== 'ok') {
        alert("Scan Error: " + (res as any).message);
      }

      const interval = setInterval(async () => {
        try {
          const progress = await api.getScanStatus();
          setScanProgress(progress);
          if (progress.status !== 'running') {
            clearInterval(interval);
            setIsScanning(false);
            await loadData();
            showToast(
              'success',
              t('notifications.scan_completed', 'Scan completed'),
              t('setup.devices_found', { count: progress.devices_found ?? '?' })
            );
          }
        } catch (e) {
          console.error("Progress poll failed", e);
        }
      }, 5000);
    } catch (err: any) {
      console.error("Scan trigger failed", err);
      alert("Critical Scan Failure: " + err.message);
      setIsScanning(false);
    }
  }, [loadData, t]);

  const openSubnetModal = async () => {
    console.log("DEBUG: opening subnet modal...");
    try {
      const subnets = await api.getSubnets();
      console.log("DEBUG: found subnets:", subnets);
      if (!subnets || subnets.length === 0) {
        alert("No subnets found! Check your network settings.");
        return;
      }
      setAvailableSubnets(subnets);
      if (subnets.length > 0) {
        setSelectedSubnet(subnets[0].subnet);
      }
      setShowSubnetModal(true);
    } catch (err: any) {
      console.error('Failed to fetch subnets:', err);
      alert("Error loading subnets: " + err.message);
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

  if (isLoading) {
    return (
      <div className="app-layout">
        <Sidebar active="dashboard" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
        <main className="app-main">
          <MobileHeader title={t('sidebar.dashboard')} onMenuClick={() => setIsSidebarOpen(true)} />
          <div className="empty-state">
            <div style={{ animation: 'pulse 2s infinite' }}>{t('dashboard.loading')}</div>
          </div>
        </main>
      </div>
    );
  }

  const renderGroup = (group: DeviceGroup | null) => {
    const groupId = group ? group.id : 'null';
    const groupDevices = devices.filter(d => d.group_id === (group ? group.id : null));
    const isCollapsed = collapsedGroups.has(groupId);

    if (groupDevices.length === 0 && group) return null;
    if (groupDevices.length === 0 && !group && groups.length > 0) return null;

    return (
      <div key={groupId} className="group-section">
        <div 
          className="group-section__header" 
          onClick={() => toggleGroup(groupId)}
          style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center' }}
        >
          {isCollapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
          <h2 className="group-section__title" style={{ flexGrow: 1, margin: 0 }}>
            {group ? group.name : t('dashboard.unassigned_devices')}
          </h2>
          
          {isEditMode && group && (
            <div style={{ display: 'flex', gap: '4px', marginRight: 'var(--space-md)' }}>
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={(e) => moveGroup(e, group, 'up')}
                disabled={groups.findIndex(g => g.id === group.id) === 0}
                style={{ padding: '4px' }}
                title={t('dashboard.move_group_up')}
              >
                <ChevronUp size={16} />
              </button>
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={(e) => moveGroup(e, group, 'down')}
                disabled={groups.findIndex(g => g.id === group.id) === groups.length - 1}
                style={{ padding: '4px' }}
                title={t('dashboard.move_group_down')}
              >
                <ChevronDown size={16} />
              </button>
            </div>
          )}
          
          <span className="group-section__count">{groupDevices.length}</span>
          {isCollapsed && (
            <div style={{ marginLeft: 'var(--space-md)', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
              {t('dashboard.click_to_expand')}
            </div>
          )}
        </div>

        {!isCollapsed && (
          <>
            {viewMode === 'grid' ? (
              <div 
                className={`grid-stack grid-stack-${groupId} ${isEditMode ? 'is-editing' : ''}`}
                style={{ minHeight: groupDevices.length > 0 ? '140px' : '0' }}
              >
                {groupDevices.map((device) => {
                    const minW = 2;
                    const minH = 2;
                    
                    // Defaults for devices without a saved layout: agent cards (2×2 metric
                    // grid) three per row, plain cards (header + service chips) narrower and lower.
                    let defaultW = 3;
                    let defaultH = 3;

                    if (device.has_agent) {
                      defaultW = 4;
                      defaultH = 5;
                    }

                    // All service chips are shown and wrap: one more grid row per extra chip row
                    const chipsPerRow = device.has_agent ? 3 : 2;
                    const chipRows = Math.ceil((device.services?.length || 0) / chipsPerRow);
                    if (chipRows > 1) defaultH += chipRows - 1;
                    
                    const initialH = (device.h !== null && device.h !== undefined) ? device.h : defaultH;
                    const initialW = (device.w !== null && device.w !== undefined) ? device.w : defaultW;

                    // Smart auto-positioning for first-run
                    // If x/y is null, we can try to calculate a basic grid position to avoid the "pile-up"
                    const autoX = device.x !== null ? device.x : undefined;
                    const autoY = device.y !== null ? device.y : undefined;

                    return (
                      <div
                        key={device.id}
                        className="grid-stack-item"
                        gs-id={device.id}
                        gs-x={autoX}
                        gs-y={autoY}
                        gs-w={initialW}
                        gs-h={initialH}
                        gs-min-h={minH}
                        gs-min-w={minW}
                        gs-auto-position={autoX === undefined ? 'true' : undefined}
                      >
                    <div className="grid-stack-item-content">
                      <DeviceCard 
                        device={device} 
                        isEditMode={isEditMode} 
                        isSelected={selectedDeviceIds.has(device.id)}
                        onSelect={(selected) => toggleDeviceSelection(device.id, selected)}
                        onRefresh={() => loadData(true)}
                        onEdit={(e) => {
                          e.stopPropagation();
                          setSelectedDevice(device);
                        }}
                      />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <DeviceList 
                devices={groupDevices} 
                onEdit={(device) => setSelectedDevice(device)} 
              />
            )}
          </>
        )}
      </div>
    );
  };

  const outdatedAgents = devices.filter(d => d.has_agent && isAgentOutdated(d.agent_info?.agent_version, d.agent_info?.latest_version)).length;

  return (
    <div className="app-layout">
      <Sidebar active="dashboard" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      <main className="app-main">
        <MobileHeader title={t('sidebar.dashboard')} onMenuClick={() => setIsSidebarOpen(true)} />
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
          
          <div style={{ 
            display: 'flex', 
            gap: 'var(--space-sm)', 
            alignItems: 'center',
            flexWrap: 'wrap'
          }}>
            {!isMobile && (
              <div className="view-toggle" role="group" aria-label={t('dashboard.view_mode', 'Ansicht')}>
                <button
                  type="button"
                  className={`view-toggle__btn ${viewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => setViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  aria-label={t('dashboard.view_grid', 'Kacheln')}
                  title={t('dashboard.view_grid', 'Kacheln')}
                >
                  <Grid size={18} />
                </button>
                <button
                  type="button"
                  className={`view-toggle__btn ${viewMode === 'list' ? 'active' : ''}`}
                  onClick={() => setViewMode('list')}
                  aria-pressed={viewMode === 'list'}
                  aria-label={t('dashboard.view_list', 'Liste')}
                  title={t('dashboard.view_list', 'Liste')}
                >
                  <List size={18} />
                </button>
              </div>
            )}

            <NotificationCenter />
            
            {isEditMode && (
              <>
                {selectedDeviceIds.size > 0 && (
                   <button className="btn btn-danger btn-sm" onClick={handleBulkDelete}>
                    <Trash2 size={16} /> {t('dashboard.delete_selected', { count: selectedDeviceIds.size })}
                  </button>
                )}
                {viewMode === 'grid' && (
                  <button className="btn btn-secondary btn-sm" onClick={() => {
                    Object.values(gridRefs.current).forEach(g => {
                      if (g) {
                        g.float(false);
                        g.compact();
                        g.float(true);
                      }
                    });
                  }} title={t('dashboard.compact_hint')}>
                    <Grid size={16} /> {t('dashboard.compact')}
                  </button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={resetLayout}>
                  <Trash2 size={16} /> {t('dashboard.reset_layout')}
                </button>
              </>
            )}
            
            <button
              className={`btn btn-sm ${isEditMode ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setIsEditMode(!isEditMode)}
              aria-label={isMobile ? t(isEditMode ? 'dashboard.edit_finish' : 'dashboard.edit_layout') : undefined}
            >
              {isEditMode
                ? <><Save size={16} /> {t('dashboard.edit_finish')}</>
                : <><Edit3 size={16} /> {!isMobile && t('dashboard.edit_layout')}</>}
            </button>

            {!isEditMode && (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleRefreshAll}
                  disabled={isRefreshingAll || isScanning}
                  aria-label={isMobile ? t('dashboard.refresh_all') : undefined}
                >
                  <RefreshCw size={16} className={isRefreshingAll ? 'spinning' : ''} />
                  {!isMobile && (isRefreshingAll ? t('dashboard.refreshing') : t('dashboard.refresh_all'))}
                </button>

                <button
                  id="dashboard-scan-btn"
                  onClick={openSubnetModal}
                  disabled={isScanning}
                  className={`btn btn-sm flex items-center gap-2 ${isScanning ? 'btn-secondary' : 'btn-primary shadow-lg shadow-primary/20'}`}
                >
                  {isScanning ? (
                    <>
                      <div className="loading loading-spinner loading-xs"></div>
                      <span>{t('dashboard.scanning', 'Scanning...')}</span>
                    </>
                  ) : (
                    <>
                      <Zap size={14} className="text-yellow-400" />
                      <span>{t('dashboard.scan', 'Scan')}</span>
                    </>
                  )}
                </button>

                {outdatedAgents > 0 && (
                  <button
                    className="btn btn-warning btn-sm"
                    onClick={() => setShowUpdateCenter(true)}
                    aria-label={isMobile ? `${outdatedAgents} ${t('dashboard.agent_updates')}` : undefined}
                  >
                    <RefreshCw size={16} className="pulse" />
                    {outdatedAgents} {!isMobile && t('dashboard.agent_updates')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {showUpdateCenter && (
          <AgentUpdateCenter 
            devices={devices}
            onClose={() => setShowUpdateCenter(false)}
            onComplete={() => loadData(true)}
          />
        )}

        {/* Scan Progress Bar */}
        {isScanning && scanProgress && (
          <div style={{
            background: 'var(--bg-secondary)',
            padding: 'var(--space-md)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: 'var(--space-xl)',
            border: '1px solid var(--border-color)',
            animation: 'fadeIn 0.3s ease-out'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-xs)', fontSize: '0.875rem' }}>
              <span style={{ fontWeight: 600, color: 'var(--primary)' }}>{scanProgress.message}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>
                {scanProgress.hosts_scanned} / {scanProgress.hosts_total} IPs
              </span>
            </div>
            <div style={{ 
              height: 8, 
              background: 'var(--bg-tertiary)', 
              borderRadius: 4, 
              overflow: 'hidden',
              marginBottom: 'var(--space-xs)'
            }}>
              <div style={{ 
                height: '100%', 
                background: 'var(--primary)', 
                width: `${(scanProgress.hosts_scanned / scanProgress.hosts_total) * 100 || 0}%`,
                transition: 'width 0.3s ease-out'
              }} />
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              {t('dashboard.devices_found', { count: scanProgress.devices_found })}
            </div>
          </div>
        )}

        {groups.map(group => renderGroup(group))}
        {renderGroup(null)}

        {selectedDevice && (
          <DeviceEditor 
            device={selectedDevice} 
            devices={devices}
            onClose={() => setSelectedDevice(null)} 
            onSave={() => loadData(true)} 
          />
        )}

        {showSubnetModal && (
          <div className="modal-overlay" onClick={() => setShowSubnetModal(false)}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
              <div className="modal-header">
                <h3>{t('dashboard.select_network')}</h3>
              </div>
              <div className="modal-body">
                <p style={{ marginBottom: 'var(--space-md)', color: 'var(--text-secondary)' }}>
                  {t('dashboard.select_subnet_prompt')}
                </p>
                <div className="form-group">
                  {availableSubnets.map((s) => {
                    const isSelected = selectedSubnet === s.subnet;
                    return (
                      <label key={`${s.subnet}-${s.ip_address}`} className="radio-item" style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-sm)',
                        padding: 'var(--space-md)',
                        background: 'var(--bg-secondary)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: 'var(--space-xs)',
                        cursor: 'pointer',
                        border: isSelected ? '1px solid var(--primary)' : '1px solid transparent',
                        transition: 'all 0.2s ease'
                      }}>
                        <input 
                          type="radio" 
                          name="subnet" 
                          value={s.subnet} 
                          checked={isSelected}
                          onChange={() => setSelectedSubnet(s.subnet)}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600 }}>{s.subnet}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                            Interface: {s.interface_name} ({s.ip_address})
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowSubnetModal(false)}>{t('common.cancel')}</button>
                <button className="btn btn-primary" onClick={() => handleRescan(selectedSubnet)}>{t('dashboard.start_scan')}</button>
              </div>
            </div>
          </div>
        )}

        {devices.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__icon">🔍</div>
            <h3>{t('dashboard.no_devices_title')}</h3>
            <p style={{ marginBottom: 'var(--space-lg)' }}>
              {t('dashboard.no_devices_text')}
            </p>
            <button className="btn btn-primary" onClick={openSubnetModal}>
              <RefreshCw size={16} /> {t('dashboard.scan_now')}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
