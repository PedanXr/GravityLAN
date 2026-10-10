import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import type { Device, DeviceGroup, Service } from '../../types';
import { api } from '../../api/client';
import { X, Save, Trash2, Tag, Layout, Folder, Settings, RefreshCw, Cpu, Globe, Lock, Terminal, Monitor, Activity, ExternalLink, Upload, HardDrive, Thermometer, ChevronDown, ChevronRight, Wifi, Radio, Server } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { useTranslation } from 'react-i18next';
import { DeviceMetrics } from './DeviceMetrics';
import { ManualInstallCommand, ManualUninstallCommand } from '../Agents/ManualInstallCommand';
import { isAgentOutdated } from '../../utils/version';

const PROTOCOL_ICON_MAP: Record<string, any> = {
  'ssh': Terminal,
  'http': Globe,
  'https': Lock,
  'rdp': Monitor,
  'tcp': Activity,
};

function computeGroupPlacement(formData: any, currentDevice: any, devices: Device[]): { x: number; y: number } | null {
  if (formData.group_id === currentDevice.group_id) return null;
  const targetGroupDevices = devices.filter(d => d.group_id === formData.group_id && d.id !== currentDevice.id);
  let maxY = 0;
  targetGroupDevices.forEach(d => {
    const bottom = (d.y || 0) + (d.h || 1);
    if (bottom > maxY) maxY = bottom;
  });
  return { x: 0, y: maxY };
}

function syncModifiedServices(device: Device, currentDevice: any): Promise<unknown>[] {
  const originalServices = device.services || [];
  const currentServices = currentDevice.services || [];
  return currentServices.map(async (svc: Service) => {
    const originalSvc = originalServices.find(s => s.id === svc.id);
    if (originalSvc && (
      originalSvc.port !== svc.port ||
      originalSvc.name !== svc.name ||
      originalSvc.protocol !== svc.protocol
    )) {
      return api.updateService(svc.id, {
        port: svc.port,
        name: svc.name,
        protocol: svc.protocol,
      });
    }
  });
}

interface DeviceEditorProps {
  device: Device;
  devices?: Device[]; // Made optional for backward compatibility if needed
  onClose: () => void;
  onSave: () => void;
}

export function DeviceEditor({ device, devices = [], onClose, onSave }: DeviceEditorProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [currentDevice, setCurrentDevice] = useState<Device>(device);
  const [formData, setFormData] = useState({
    display_name: currentDevice.display_name || '',
    notes: currentDevice.notes || '',
    group_id: currentDevice.group_id,
    vendor: currentDevice.vendor || '',
    w: currentDevice.w || 2,
    h: currentDevice.h || 3,
    virtual_type: currentDevice.virtual_type || null,
    parent_id: currentDevice.parent_id || null,
    rack_id: currentDevice.rack_id || null,
    rack_unit: currentDevice.rack_unit || null,
    rack_height: currentDevice.rack_height || 1,
    is_wlan: currentDevice.is_wlan || false,
    is_ap: currentDevice.is_ap || false,
    is_host: currentDevice.is_host || false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'settings' | 'services' | 'history' | 'agent'>('settings');
  const [history, setHistory] = useState<any[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isScanningServices, setIsScanningServices] = useState(false);

  // Agent state
  const [agentStatus, setAgentStatus] = useState<{ is_installed: boolean; is_active: boolean; agent_version?: string; latest_version?: string; last_seen?: string } | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [sshForm, setSshForm] = useState({ ssh_user: 'root', ssh_password: '', ssh_key: '', ssh_port: 22 });
  const [agentConfig, setAgentConfig] = useState<{ interval: number; disk_paths: string[]; enable_temp: boolean } | null>(null);
  const [newDiskPath, setNewDiskPath] = useState('');
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [showManual, setShowManual] = useState(false);

  // Parents from the outermost host down to this device (e.g. Proxmox › Docker VM), cycle-safe.
  const networkPath = useMemo(() => {
    const byId = new Map((devices || []).map((d) => [d.id, d]));
    const chain: Device[] = [];
    const seen = new Set<number>();
    let parentId = currentDevice.parent_id;
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId)!;
      chain.unshift(parent);
      parentId = parent.parent_id;
    }
    return chain;
  }, [devices, currentDevice.parent_id]);

  // Modal dialog behaviour: focus moves into the panel, Tab stays inside it,
  // Escape closes, and focus returns to the element that opened it.
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    const loadGroups = async () => {
      try {
        const data = await api.getGroups();
        setGroups(data);
      } catch (err) {
        console.error('Failed to load groups:', err);
      }
    };
    loadGroups();
  }, []);

  const [racks, setRacks] = useState<any[]>([]);
  useEffect(() => {
    const loadRacks = async () => {
      try {
        const data = await api.getRacks();
        setRacks(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error('Failed to load racks:', err);
        setRacks([]);
      }
    };
    loadRacks();
  }, []);

  useEffect(() => {
    if (activeTab === 'history') {
      loadHistory();
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'agent') {
      loadAgentStatus();
    }
  }, [activeTab]);

  const loadAgentStatus = async () => {
    try {
      const status = await api.getAgentStatus(currentDevice.id);
      setAgentStatus(status);
      if (status.is_installed) {
        await loadAgentConfig();
      }
    } catch { /* agent not available */ }
  };

  const loadAgentConfig = async () => {
    try {
      const config = await api.getAgentConfig(currentDevice.id);
      setAgentConfig(config);
    } catch { /* no config yet */ }
  };

  const handleDeploy = async () => {
    setIsDeploying(true);
    showToast('info', t('agent.deploying'), t('agent.connecting', { ip: currentDevice.ip }));
    try {
      const result = await api.deployAgent(currentDevice.id, sshForm);
      setDeployLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${result.message}`]);
      if (result.status === 'success') {
        showToast('success', t('agent.deployed_title'), result.message);
        setSshForm(prev => ({ ...prev, ssh_password: '', ssh_key: '' }));
        await loadAgentStatus();
      } else {
        showToast('error', t('agent.deploy_failed_title'), result.message);
      }
    } catch (err: any) {
      const msg = err.message || t('agent.connection_failed');
      setDeployLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${t('common.error').toUpperCase()}: ${msg}`]);
      showToast('error', t('common.error'), msg);
    } finally {
      setIsDeploying(false);
    }
  };

  const handleUninstall = async () => {
    if (!window.confirm(t('agent.uninstall_confirm_long'))) {
      return;
    }
    
    setIsDeploying(true);
    showToast('info', t('agent.uninstalling'), t('agent.removing', { ip: currentDevice.ip }));
    try {
      const result = await api.uninstallAgent(currentDevice.id, sshForm);
      setDeployLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${result.message}`]);
      if (result.status === 'success') {
        showToast('success', t('agent.uninstalled_title'), result.message);
        setSshForm(prev => ({ ...prev, ssh_password: '', ssh_key: '' }));
        await loadAgentStatus();
      } else {
        showToast('error', t('agent.uninstall_failed_title'), result.message);
      }
    } catch (err: any) {
      const msg = err.message || t('agent.connection_failed');
      setDeployLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${t('common.error').toUpperCase()}: ${msg}`]);
      showToast('error', t('common.error'), msg);
    } finally {
      setIsDeploying(false);
    }
  };

  const loadHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const data = await api.getDeviceHistory(currentDevice.id);
      setHistory(data);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleRefreshInfo = async () => {
    setIsRefreshing(true);
    showToast('info', t('dashboard.refreshing'), t('notifications.refreshing_details', { ip: currentDevice.ip }));
    try {
      const updated = await api.refreshDeviceInfo(currentDevice.id);
      setCurrentDevice(updated);
      setFormData(prev => ({ 
        ...prev, 
        vendor: updated.vendor || '',
        display_name: (prev.display_name === currentDevice.ip && updated.hostname) 
          ? updated.hostname.split('.')[0] 
          : prev.display_name
      }));
      showToast('success', t('notifications.info_updated'), t('notifications.info_updated_text', { ip: currentDevice.ip }));
      onSave(); // Update dashboard
    } catch (err: any) {
      console.error('Failed to refresh device info:', err);
      showToast('error', t('common.error'), t('notifications.refresh_failed', { error: err.message || t('common.unknown') }));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleScanServices = async () => {
    setIsScanningServices(true);
    showToast('info', t('network.nmap_scan'), t('notifications.nmap_scan_started', { ip: currentDevice.ip }));
    try {
      const updated = await api.refreshServices(currentDevice.id);
      setCurrentDevice(updated);
      showToast('success', t('network.nmap_scan'), t('notifications.nmap_scan_finished', { ip: currentDevice.ip }));
      onSave();
    } catch (err: any) {
      console.error('Failed to scan services:', err);
      showToast('error', t('common.error'), err.message || t('common.unknown'));
    } finally {
      setIsScanningServices(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    let updateData: any = { ...formData };

    const placement = computeGroupPlacement(formData, currentDevice, devices);
    if (placement) {
      updateData.x = placement.x;
      updateData.y = placement.y;
    }

    try {
      // Find and save any modified services to prevent race conditions from onBlur / typing
      const servicePromises = syncModifiedServices(device, currentDevice);
      
      await Promise.all(servicePromises.filter(Boolean));

      await api.updateDevice(currentDevice.id, updateData);
      onSave();
      onClose();
    } catch (err) {
      console.error('Failed to save device:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const deviceName = currentDevice.display_name || currentDevice.hostname || currentDevice.ip;
  const deviceRole = currentDevice.virtual_type === 'docker' ? 'Docker'
    : currentDevice.virtual_type === 'vm' ? 'VM'
    : currentDevice.virtual_type || (currentDevice.is_host ? 'Host' : null);
  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: 'settings', label: t('editor.tabs.general') },
    { id: 'services', label: t('editor.tabs.services') },
    { id: 'history', label: t('editor.tabs.history') },
    { id: 'agent', label: t('editor.tabs.agent') },
  ];

  return (
    <div className="inspector-overlay">
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={`inspector-panel ${activeTab === 'agent' ? 'is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspector-title"
      >
        <header className="inspector-header">
          {networkPath.length > 0 && (
            <nav className="inspector-path" aria-label={t('editor.network_path')}>
              {networkPath.map((node) => (
                <Fragment key={node.id}>
                  <span>{node.display_name || node.ip}</span>
                  <span aria-hidden="true">›</span>
                </Fragment>
              ))}
              <span className="inspector-path__current">{deviceName}</span>
            </nav>
          )}
          <div className="inspector-title-row">
            <span
              className={`status-dot ${currentDevice.is_online ? 'status-dot--online' : 'status-dot--offline'}`}
              role="img"
              aria-label={currentDevice.is_online ? t('network.online') : t('network.offline')}
            />
            <div className="inspector-title-text">
              <h2 id="inspector-title" className="inspector-title">{deviceName}</h2>
              <span className="inspector-subtitle">{currentDevice.ip}{deviceRole ? ` · ${deviceRole}` : ''}</span>
            </div>
            <button type="button" className="btn-close" onClick={onClose} aria-label={t('common.close')}><X size={18} /></button>
          </div>
          <div
            className="inspector-tabs"
            role="tablist"
            aria-label={t('editor.title_edit')}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const index = tabs.findIndex((tab) => tab.id === activeTab);
              const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              setActiveTab(next.id);
              document.getElementById(`inspector-tab-${next.id}`)?.focus();
            }}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`inspector-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls="inspector-tabpanel"
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={`inspector-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </header>

        <div
          className="modal-body"
          id="inspector-tabpanel"
          role="tabpanel"
          aria-labelledby={`inspector-tab-${activeTab}`}
          tabIndex={0}
          style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-lg)', minHeight: 400 }}
        >
          {activeTab === 'settings' ? (
            <form onSubmit={handleSubmit}>
              {/* Basic Information */}
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: '24px', 
                background: 'rgba(255,255,255,0.02)', 
                padding: '20px', 
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.05)',
                marginBottom: '24px'
              }}>
                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <label><Tag size={14} /> {t('editor.display_name')}</label>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      value={formData.display_name}
                      onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
                      placeholder={currentDevice.hostname || currentDevice.ip}
                    />
                    <button 
                      type="button"
                      className="btn btn-secondary" 
                      onClick={handleRefreshInfo}
                      disabled={isRefreshing}
                      style={{ height: 42, padding: '0 16px', display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                      <RefreshCw size={16} className={isRefreshing ? 'spinning' : ''} />
                      {isRefreshing ? t('common.loading') : t('editor.refresh_info')}
                    </button>
                  </div>
                </div>

                <div className="form-group">
                  <label><Folder size={14} /> {t('editor.group')}</label>
                  <select
                    className="input"
                    value={formData.group_id || ''}
                    onChange={(e) => setFormData({ ...formData, group_id: e.target.value ? parseInt(e.target.value) : null })}
                  >
                    <option value="">{t('dashboard.unassigned_devices')}</option>
                    {Array.isArray(groups) && groups.map(group => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label><Cpu size={14} /> {t('editor.vendor')}</label>
                  <input
                    className="input"
                    value={formData.vendor}
                    onChange={(e) => setFormData({ ...formData, vendor: e.target.value })}
                    placeholder={t('common.unknown')}
                  />
                </div>

                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                  <label><Monitor size={14} /> {t('editor.parent_device', 'Physischer Host')}</label>
                  <select
                    className="input"
                    value={formData.parent_id || ''}
                    onChange={(e) => setFormData({ ...formData, parent_id: e.target.value ? parseInt(e.target.value) : null })}
                  >
                    <option value="">{t('editor.no_parent', 'Kein Host (Physisch)')}</option>
                    {(devices || []).filter(d => d.id !== currentDevice.id && d.is_host).map(dev => (
                      <option key={dev.id} value={dev.id}>{dev.display_name || dev.hostname || dev.ip}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Infrastructure & Placement */}
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: '24px', 
                background: 'rgba(255,255,255,0.02)', 
                padding: '20px', 
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.05)',
                marginBottom: '24px'
              }}>
                <div className="form-group">
                  <label><Layout size={14} /> {t('editor.rack_position', 'Rack & Position')}</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <select
                      className="input"
                      style={{ flex: 2 }}
                      value={formData.rack_id || ''}
                      onChange={(e) => setFormData({ ...formData, rack_id: e.target.value ? parseInt(e.target.value) : null })}
                    >
                      <option value="">{t('editor.no_rack')}</option>
                      {Array.isArray(racks) && racks.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <input
                      type="number"
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="Unit"
                      value={formData.rack_unit || ''}
                      onChange={(e) => setFormData({ ...formData, rack_unit: e.target.value ? parseInt(e.target.value) : null })}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label><HardDrive size={14} /> {t('editor.rack_height', 'Rack Height (U)')}</label>
                  <input
                    type="number"
                    className="input"
                    min={1}
                    max={10}
                    value={formData.rack_height}
                    onChange={(e) => setFormData({ ...formData, rack_height: parseInt(e.target.value) || 1 })}
                  />
                </div>

                <div className="form-group">
                  <label><Layout size={14} /> {t('editor.grid_size')}</label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      type="number"
                      className="input"
                      style={{ flex: 1 }}
                      value={formData.w}
                      min={1}
                      max={12}
                      onChange={(e) => setFormData({ ...formData, w: parseInt(e.target.value) })}
                    />
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>x</span>
                    <input
                      type="number"
                      className="input"
                      style={{ flex: 1 }}
                      value={formData.h}
                      min={1}
                      max={10}
                      onChange={(e) => setFormData({ ...formData, h: parseInt(e.target.value) })}
                    />
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginLeft: 4 }}>{t('editor.units')}</span>
                  </div>
                </div>

                <div className="form-group">
                  <label>{t('editor.badge', 'Special Marker (Badge)')}</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[
                      { id: null, label: t('editor.none'), color: 'var(--bg-input)' },
                      { id: 'vm', label: 'VM', color: 'rgba(217, 70, 239, 0.2)' },
                      { id: 'docker', label: 'Docker', color: 'rgba(147, 51, 234, 0.2)' }
                    ].map(type => (
                      <button
                        key={String(type.id)}
                        type="button"
                        onClick={() => setFormData({ ...formData, virtual_type: type.id as any })}
                        style={{
                          flex: 1,
                          padding: '8px 4px',
                          background: formData.virtual_type === type.id ? type.color : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${formData.virtual_type === type.id ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)'}`,
                          borderRadius: '8px',
                          color: formData.virtual_type === type.id ? 'var(--text-primary)' : 'var(--text-tertiary)',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                      >
                        {type.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Advanced Connectivity & Role */}
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr 1fr', 
                gap: '16px', 
                marginBottom: '24px' 
              }}>
                <div 
                  onClick={() => setFormData({ ...formData, is_wlan: !formData.is_wlan })}
                  style={{
                    padding: '12px',
                    background: formData.is_wlan ? 'rgba(56, 189, 248, 0.1)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${formData.is_wlan ? '#38bdf8' : 'rgba(255,255,255,0.05)'}`,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    transition: 'all 0.2s'
                  }}
                >
                  <div style={{ 
                    width: 32, 
                    height: 32, 
                    borderRadius: '8px', 
                    background: formData.is_wlan ? '#38bdf8' : 'rgba(255,255,255,0.05)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center' 
                  }}>
                    <Wifi size={16} color={formData.is_wlan ? 'white' : '#64748b'} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: formData.is_wlan ? '#f8fafc' : '#94a3b8' }}>{t('editor.wlan_client')}</span>
                    <span style={{ fontSize: '0.6rem', color: '#64748b' }}>{t('editor.wlan_client_desc')}</span>
                  </div>
                </div>

                <div 
                  onClick={() => setFormData({ ...formData, is_ap: !formData.is_ap })}
                  style={{
                    padding: '12px',
                    background: formData.is_ap ? 'rgba(34, 211, 238, 0.1)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${formData.is_ap ? '#22d3ee' : 'rgba(255,255,255,0.05)'}`,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    transition: 'all 0.2s'
                  }}
                >
                  <div style={{ 
                    width: 32, 
                    height: 32, 
                    borderRadius: '8px', 
                    background: formData.is_ap ? '#22d3ee' : 'rgba(255,255,255,0.05)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center' 
                  }}>
                    <Radio size={16} color={formData.is_ap ? 'white' : '#64748b'} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: formData.is_ap ? '#f8fafc' : '#94a3b8' }}>{t('editor.access_point')}</span>
                    <span style={{ fontSize: '0.6rem', color: '#64748b' }}>{t('editor.access_point_desc')}</span>
                  </div>
                </div>

                <div 
                  onClick={() => setFormData({ ...formData, is_host: !formData.is_host })}
                  style={{
                    padding: '12px',
                    background: formData.is_host ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${formData.is_host ? '#10b981' : 'rgba(255,255,255,0.05)'}`,
                    borderRadius: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    transition: 'all 0.2s'
                  }}
                >
                  <div style={{ 
                    width: 32, 
                    height: 32, 
                    borderRadius: '8px', 
                    background: formData.is_host ? '#10b981' : 'rgba(255,255,255,0.05)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center' 
                  }}>
                    <Server size={16} color={formData.is_host ? 'white' : '#64748b'} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: formData.is_host ? '#f8fafc' : '#94a3b8' }}>{t('editor.physical_host')}</span>
                    <span style={{ fontSize: '0.6rem', color: '#64748b' }}>{t('editor.physical_host_desc')}</span>
                  </div>
                </div>
              </div>

              {/* The parent host is chosen once, in the "Physical host" field above. */}

              <div className="form-group">
                <label>{t('editor.notes')}</label>
                <textarea
                  className="input"
                  style={{ minHeight: 80, resize: 'vertical' }}
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder={t('editor.notes_placeholder')}
                />
              </div>

              <div style={{ 
                padding: '16px', 
                background: 'rgba(15, 23, 42, 0.4)', 
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.05)',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '16px'
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700 }}>{t('editor.system_info')}</div>
                  <div style={{ fontSize: '0.85rem', display: 'grid', gridTemplateColumns: '80px 1fr', gap: '4px' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>IP:</span> <span>{currentDevice.ip}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>MAC:</span> <span style={{ fontFamily: 'monospace' }}>{currentDevice.mac || 'N/A'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                   <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700 }}>{t('editor.network_info')}</div>
                   <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                     {currentDevice.hostname || t('editor.no_dns_name')}
                     {currentDevice.hostname && currentDevice.hostname.includes('.') && (
                       <div style={{ fontSize: '0.7rem', color: 'var(--accent-primary)', marginTop: 2 }}>
                         FQDN: {currentDevice.hostname}
                       </div>
                     )}
                   </div>
                </div>
              </div>
            </form>
          ) : activeTab === 'services' ? (
            <div className="services-tab" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{t('editor.active_services')}</h4>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    className="btn btn-secondary" 
                    style={{ fontSize: '0.75rem', padding: '4px 10px', color: 'var(--accent-primary)', borderColor: 'rgba(56, 189, 248, 0.3)' }}
                    onClick={handleScanServices}
                    disabled={isScanningServices}
                  >
                    <Activity size={14} className={isScanningServices ? 'spinning' : ''} />
                    {isScanningServices ? t('dashboard.scanning') : t('network.nmap_scan')}
                  </button>
                  <button 
                    className="btn btn-secondary" 
                    style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                    onClick={async () => {
                      const name = prompt('Service Name?', 'Web Interface');
                      const port = parseInt(prompt('Port?', '80') || '0');
                      if (name && port > 0) {
                        await api.addService(currentDevice.id, { name, port, protocol: 'http' });
                        const updated = await api.getDevice(currentDevice.id);
                        setCurrentDevice(updated);
                        onSave();
                      }
                    }}
                  >
                    + {t('editor.add_service')}
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto', paddingRight: '4px' }}>
                {currentDevice.services.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
                    {t('editor.no_services')}
                  </div>
                ) : (
                  currentDevice.services.sort((a, b) => a.port - b.port).map(svc => {
                    const ServiceIcon = PROTOCOL_ICON_MAP[svc.protocol.toLowerCase()] || ExternalLink;

                    return (
                      <div key={svc.id} style={{ 
                        padding: '12px', 
                        background: 'var(--bg-input)', 
                        borderRadius: 'var(--radius-md)', 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: 'var(--space-md)',
                        border: '1px solid var(--border-subtle)',
                        transition: 'border-color 0.2s'
                      }}>
                        <div style={{ 
                          width: 40, height: 40, 
                          background: svc.is_up ? 'rgba(74, 222, 128, 0.1)' : 'rgba(248, 113, 113, 0.1)', 
                          borderRadius: '8px',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: svc.is_up ? 'var(--accent-secondary)' : 'var(--text-tertiary)',
                        }}>
                          <ServiceIcon size={18} />
                        </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input 
                            style={{ background: 'none', border: 'none', color: 'var(--text-primary)', fontWeight: 600, width: '100%' }}
                            value={svc.name}
                            onChange={async (e) => {
                              const newName = e.target.value;
                              setCurrentDevice(prev => ({
                                ...prev,
                                services: prev.services.map(s => s.id === svc.id ? { ...s, name: newName, is_auto_detected: false } : s)
                              }));
                            }}
                            onBlur={async (e) => {
                              await api.updateService(svc.id, { name: e.target.value });
                              onSave();
                            }}
                          />
                          {!svc.is_auto_detected && (
                            <span style={{ fontSize: '0.6rem', background: 'var(--accent-primary)', color: 'black', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t('editor.manual')}</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 12, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          <span style={{ display: 'flex', gap: 4 }}>
                            PROT: 
                            <select 
                              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '0.75rem', padding: 0, cursor: 'pointer' }}
                              value={svc.protocol}
                              onChange={async (e) => {
                                const newProto = e.target.value;
                                try {
                                  await api.updateService(svc.id, { protocol: newProto });
                                  const updated = await api.getDevice(currentDevice.id);
                                  setCurrentDevice(updated);
                                  onSave();
                                  showToast('success', t('notifications.info_updated', 'Info updated'), `${svc.name} is now configured as ${newProto.toUpperCase()}.`);
                                } catch (err: any) {
                                  showToast('error', t('common.error', 'Error'), `Could not save protocol: ${err.message || 'Unknown error'}`);
                                }
                              }}
                            >
                              <option value="http">HTTP</option>
                              <option value="https">HTTPS</option>
                              <option value="ssh">SSH</option>
                              <option value="tcp">TCP</option>
                              <option value="udp">UDP</option>
                            </select>
                          </span>
                          <span style={{ display: 'flex', gap: 4 }}>
                            PORT: 
                            <input 
                              type="number"
                              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '0.75rem', padding: 0, width: '50px' }}
                              value={svc.port}
                              onChange={async (e) => {
                                const newPort = parseInt(e.target.value);
                                if (!isNaN(newPort)) {
                                  setCurrentDevice(prev => ({
                                    ...prev,
                                    services: prev.services.map(s => s.id === svc.id ? { ...s, port: newPort, is_auto_detected: false } : s)
                                  }));
                                }
                              }}
                              onBlur={async (e) => {
                                const newPort = parseInt(e.target.value);
                                if (!isNaN(newPort)) {
                                  await api.updateService(svc.id, { port: newPort });
                                  onSave();
                                }
                              }}
                            />
                          </span>
                        </div>
                      </div>
                      <button 
                        className="btn-icon" 
                        style={{ color: 'var(--text-tertiary)' }}
                        onClick={async () => {
                          if (confirm(t('editor.delete_service_confirm'))) {
                            await api.deleteService(svc.id);
                            const updated = await api.getDevice(currentDevice.id);
                            setCurrentDevice(updated);
                            onSave();
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                  })
                )}
              </div>
              
              <div style={{ marginTop: 'auto', padding: '12px', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '8px', fontSize: '0.8rem', border: '1px dashed rgba(56, 189, 248, 0.3)' }}>
                <p style={{ margin: 0, color: '#38bdf8' }}>
                  <strong>{t('common.warning')}:</strong> {t('editor.service_note')}
                </p>
              </div>
            </div>
          ) : activeTab === 'history' ? (
            <div className="history-timeline" style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '8px' }}>
              {isLoadingHistory ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)' }}>
                  <RefreshCw size={24} className="spinning" style={{ marginBottom: 10 }} />
                  <p>{t('common.loading')}</p>
                </div>
              ) : history.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)' }}>
                  <p>{t('notifications.no_events')}</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                  {Array.isArray(history) && history.map((item) => (
                    <div key={item.id} style={{ 
                      padding: 'var(--space-md)', 
                      background: 'var(--bg-input)', 
                      borderRadius: 'var(--radius-md)',
                      borderLeft: `4px solid ${
                        (item.status === 'online' || item.status === 'up') 
                          ? 'var(--accent-success)' 
                          : 'var(--accent-danger)'
                      }`,
                      animation: 'slideUp 0.3s ease-out'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ 
                            fontWeight: 700, 
                            textTransform: 'uppercase', 
                            fontSize: '0.7rem', 
                            color: (item.status === 'online' || item.status === 'up') 
                              ? 'var(--accent-success)' 
                              : 'var(--accent-danger)',
                            background: (item.status === 'online' || item.status === 'up')
                              ? 'rgba(79, 209, 197, 0.1)'
                              : 'rgba(255, 107, 107, 0.1)',
                            padding: '2px 6px',
                            borderRadius: 4
                          }}>
                            {item.status}
                          </span>
                          {item.service_id && (
                            <span style={{ fontSize: '0.7rem', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4, color: 'var(--text-secondary)' }}>
                              SERVICE
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          {item.timestamp ? new Date(item.timestamp).toLocaleString() : t('common.loading')}
                        </span>
                      </div>
                      <p style={{ fontSize: '0.875rem', margin: 0, fontWeight: item.service_id ? 500 : 400, color: 'var(--text-primary)' }}>
                        {item.message}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : activeTab === 'agent' ? (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))', 
              gap: 'var(--space-lg)',
              alignItems: 'start'
            }}>
              {/* Spalte 1: Status & Metriken */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                <div style={{ 
                  padding: '16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)',
                  border: `1px solid ${agentStatus?.is_active ? 'rgba(16, 185, 129, 0.3)' : 'var(--border-subtle)'}` 
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ 
                        width: 10, height: 10, borderRadius: '50%',
                        background: agentStatus?.is_active ? '#10b981' : (agentStatus?.is_installed ? '#f59e0b' : '#64748b'),
                        boxShadow: agentStatus?.is_active ? '0 0 8px #10b981' : 'none'
                      }} />
                      <span style={{ fontWeight: 700 }}>
                        {agentStatus?.is_active ? t('agent.status_active') : (agentStatus?.is_installed ? `${t('agent.status_active')} (${t('common.offline')})` : t('agent.status_inactive'))}
                      </span>
                    </div>
                    {agentStatus?.agent_version && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {isAgentOutdated(agentStatus.agent_version, agentStatus.latest_version) && (
                          <span style={{ 
                            fontSize: '0.65rem', background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b', 
                            padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(245, 158, 11, 0.3)',
                            fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4
                          }}>
                            <RefreshCw size={10} /> {t('common.next')} Update
                          </span>
                        )}
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>v{agentStatus.agent_version}</span>
                      </div>
                    )}
                  </div>
                  {agentStatus?.last_seen && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '8px 0 0' }}>
                      {t('agent.last_report')}: {new Date(agentStatus.last_seen).toLocaleString()}
                    </p>
                  )}
                </div>

                {/* Live Metrics (only if active) */}
                {agentStatus?.is_active && (
                  <DeviceMetrics 
                    deviceId={currentDevice.id} 
                    compact={false} 
                    onUpdate={(m) => {
                      if (agentStatus) {
                        setAgentStatus({ ...agentStatus, last_seen: m.timestamp });
                      }
                    }}
                  />
                )}
              </div>

              {/* Spalte 2: Management & Config */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                {/* SSH management */}
                <section className="agent-detail__panel">
                  <h4 className="agent-detail__title"><Terminal size={14} aria-hidden="true" /> {t('agent.ssh_management')}</h4>
                  <div className="editor-ssh__grid">
                    <div className="settings-field">
                      <label className="form-label" htmlFor="editor-ssh-user">{t('agent.ssh_user')}</label>
                      <input id="editor-ssh-user" className="input" autoComplete="username" value={sshForm.ssh_user} onChange={e => setSshForm(prev => ({ ...prev, ssh_user: e.target.value }))} />
                    </div>
                    <div className="settings-field">
                      <label className="form-label" htmlFor="editor-ssh-port">{t('agent.ssh_port')}</label>
                      <input id="editor-ssh-port" className="input" type="number" value={sshForm.ssh_port} onChange={e => setSshForm(prev => ({ ...prev, ssh_port: parseInt(e.target.value) || 22 }))} />
                    </div>
                    <div className="settings-field editor-ssh__wide">
                      <label className="form-label" htmlFor="editor-ssh-password">{t('agent.ssh_password')}</label>
                      <input id="editor-ssh-password" className="input" type="password" autoComplete="current-password" value={sshForm.ssh_password} onChange={e => setSshForm(prev => ({ ...prev, ssh_password: e.target.value }))} placeholder={t('agent.password_placeholder')} />
                    </div>
                  </div>
                  <div className="agent-detail__actions">
                    {!agentStatus?.is_installed ? (
                      <button type="button" className="btn btn-primary btn-sm" onClick={handleDeploy} disabled={isDeploying || (!sshForm.ssh_password && !sshForm.ssh_key)}>
                        <Upload size={14} aria-hidden="true" /> {isDeploying ? t('common.loading') : t('agent.install_via_ssh')}
                      </button>
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary btn-sm" onClick={handleDeploy} disabled={isDeploying || (!sshForm.ssh_password && !sshForm.ssh_key)}>
                          <RefreshCw size={14} className={isDeploying ? 'spinning' : ''} aria-hidden="true" /> {isDeploying ? t('common.loading') : t('agent.update_agent')}
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={handleUninstall} disabled={isDeploying || (!sshForm.ssh_password && !sshForm.ssh_key)}>
                          <Trash2 size={14} aria-hidden="true" /> {t('agent.uninstall')}
                        </button>
                      </>
                    )}
                  </div>
                </section>
                {/* Manual Installation Toggle */}
                <div style={{ marginTop: 'var(--space-sm)' }}>
                  <button 
                    onClick={() => setShowManual(!showManual)}
                    style={{ 
                      background: 'none', border: 'none', color: 'var(--text-tertiary)', 
                      fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 6,
                      cursor: 'pointer', padding: '4px 0'
                    }}
                  >
                    {showManual ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {t('agent.manual_install_options', 'Show manual installation/uninstallation options')}
                  </button>

                  {showManual && (
                    <div className="editor-manual">
                      <section className="agent-detail__panel">
                        <h4 className="agent-detail__title"><ExternalLink size={14} aria-hidden="true" /> {t('agent.manual_install')}</h4>
                        <ManualInstallCommand deviceId={currentDevice.id} />
                      </section>
                      <section className="agent-detail__panel">
                        <h4 className="agent-detail__title"><Trash2 size={14} aria-hidden="true" /> {t('agent.manual_uninstall')}</h4>
                        <ManualUninstallCommand deviceId={currentDevice.id} />
                      </section>
                    </div>
                  )}
                </div>

                {/* Agent Config (only if installed) */}
                {agentStatus?.is_installed && agentConfig && (
                  <div style={{ padding: '16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
                    <h4 style={{ margin: '0 0 12px', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Settings size={16} /> {t('agent.configuration')}
                    </h4>
                    <div className="form-group">
                      <label style={{ fontSize: '0.7rem' }}>{t('agent.report_interval')}</label>
                      <input className="input" type="number" value={agentConfig.interval} onChange={e => setAgentConfig(prev => prev ? { ...prev, interval: parseInt(e.target.value) || 30 } : prev)} />
                    </div>
                    <div className="form-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Thermometer size={12} /> {t('agent.temp_monitoring')}
                      </label>
                      <button
                        className={`btn ${agentConfig.enable_temp ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                        onClick={() => setAgentConfig(prev => prev ? { ...prev, enable_temp: !prev.enable_temp } : prev)}
                      >
                        {agentConfig.enable_temp ? t('common.activated') : t('common.deactivated')}
                      </button>
                    </div>
                    <div className="form-group">
                      <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <HardDrive size={12} /> {t('agent.disk_paths')}
                      </label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                        {(agentConfig.disk_paths || []).map((p, i) => (
                          <span key={i} style={{ 
                            background: 'var(--bg-elevated)', padding: '3px 8px', borderRadius: 4,
                            fontSize: '0.75rem', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 4
                          }}>
                            {p}
                            <button style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: 0, fontSize: '0.8rem' }}
                              onClick={() => setAgentConfig(prev => prev ? { ...prev, disk_paths: (prev.disk_paths || []).filter((_, idx) => idx !== i) } : prev)}
                            >×</button>
                          </span>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input className="input" style={{ flex: 1 }} placeholder="/mnt/data" value={newDiskPath} onChange={e => setNewDiskPath(e.target.value)} />
                        <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                          onClick={() => {
                            if (newDiskPath && !(agentConfig.disk_paths || []).includes(newDiskPath)) {
                              setAgentConfig(prev => prev ? { ...prev, disk_paths: [...(prev.disk_paths || []), newDiskPath] } : prev);
                              setNewDiskPath('');
                            }
                          }}
                        >+</button>
                      </div>
                    </div>
                    <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}
                      onClick={async () => {
                        try {
                          await api.updateAgentConfig(currentDevice.id, agentConfig);
                          showToast('success', t('notifications.saved'), t('notifications.changes_applied'));
                        } catch (err: any) {
                          showToast('error', t('common.error'), err.message);
                        }
                      }}
                    >
                      <Save size={16} /> {t('agent.save_config')}
                    </button>
                  </div>
                )}

                {/* Deployment Logs */}
                {deployLog.length > 0 && (
                  <div style={{ marginTop: 'var(--space-md)' }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: '0.8rem', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Terminal size={14} /> {t('agent.deployment_logs')}
                    </h4>
                    <div style={{ 
                      background: '#000', padding: '12px', borderRadius: '4px', 
                      fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: '#10b981',
                      maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--border-subtle)'
                    }}>
                      {deployLog.map((log, i) => (
                        <div key={i} style={{ marginBottom: 4 }}>{log}</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* Destructive action on the left, the usual Cancel / Save pair on the right */}
        <div className="inspector-footer">
          <button type="button" className="btn btn-danger btn-sm inspector-footer__delete" onClick={() => {
            if (confirm(t('editor.delete_device_confirm', 'Do you really want to permanently delete this device?'))) {
              api.deleteDevice(currentDevice.id)
                .then(() => {
                  showToast('success', t('common.success'), t('notifications.deleted'));
                  onSave();
                  onClose();
                })
                .catch((err: any) => {
                  console.error('Failed to delete device:', err);
                  showToast('error', t('common.error'), t('notifications.delete_failed', 'Delete failed'));
                });
            }
          }}>
            <Trash2 size={14} aria-hidden="true" /> {t('common.delete')}
          </button>
          <div className="inspector-footer__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={isSaving}>
              <Save size={14} aria-hidden="true" /> {isSaving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
