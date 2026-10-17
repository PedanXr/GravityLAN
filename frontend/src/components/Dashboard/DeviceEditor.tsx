import { useCallback, useState, useMemo, Fragment, type KeyboardEvent } from 'react';
import type { Device, DeviceInterface } from '../../types';
import { api } from '../../api/client';
import { X, Save, Trash2 } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { useTranslation } from 'react-i18next';
import {
  computeGroupPlacement,
  deviceRoleOf,
  errorMessage,
  initialFormData,
  networkPathOf,
  syncModifiedServices,
  type DeviceFormData,
  type EditorTab,
} from './editor/deviceForm';
import { useAgentPanel, useDeviceHistory, useEditorOptions, useModalFocusTrap } from './editor/hooks';
import { SettingsTab } from './editor/SettingsTab';
import { ServicesTab } from './editor/ServicesTab';
import { HistoryTab } from './editor/HistoryTab';
import { InterfacesTab } from './editor/InterfacesTab';
import { AgentTab } from './editor/AgentTab';

interface DeviceEditorProps {
  device: Device;
  devices?: Device[]; // Made optional for backward compatibility if needed
  onClose: () => void;
  onSave: () => void;
  initialTab?: EditorTab;
}

export function DeviceEditor({ device, devices = [], onClose, onSave, initialTab = 'settings' }: DeviceEditorProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [currentDevice, setCurrentDevice] = useState<Device>(device);
  const [formData, setFormData] = useState<DeviceFormData>(() => initialFormData(device));
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isScanningServices, setIsScanningServices] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>(initialTab);

  const panelRef = useModalFocusTrap<HTMLElement>(onClose);
  const { groups, racks } = useEditorOptions();
  const { history, isLoading: isLoadingHistory } = useDeviceHistory(currentDevice.id, activeTab === 'history');
  const agentPanel = useAgentPanel(currentDevice, activeTab === 'agent');

  const networkPath = useMemo(() => networkPathOf(currentDevice.parent_id, devices || []), [devices, currentDevice.parent_id]);
  const updateInterfaces = useCallback(
    (interfaces: DeviceInterface[]) => setCurrentDevice((prev) => ({ ...prev, interfaces })),
    [],
  );

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
    } catch (err) {
      console.error('Failed to refresh device info:', err);
      showToast('error', t('common.error'), t('notifications.refresh_failed', { error: errorMessage(err) || t('common.unknown') }));
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
    } catch (err) {
      console.error('Failed to scan services:', err);
      showToast('error', t('common.error'), errorMessage(err) || t('common.unknown'));
    } finally {
      setIsScanningServices(false);
    }
  };

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setIsSaving(true);
    const placement = computeGroupPlacement(formData, currentDevice, devices);
    const updateData = placement ? { ...formData, ...placement } : { ...formData };

    try {
      // Find and save any modified services to prevent race conditions from onBlur / typing
      await Promise.all(syncModifiedServices(device, currentDevice).filter(Boolean));
      await api.updateDevice(currentDevice.id, updateData);
      onSave();
      onClose();
    } catch (err) {
      console.error('Failed to save device:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = () => {
    if (!confirm(t('editor.delete_device_confirm', 'Do you really want to permanently delete this device?'))) return;
    api.deleteDevice(currentDevice.id)
      .then(() => {
        showToast('success', t('common.success'), t('notifications.deleted'));
        onSave();
        onClose();
      })
      .catch((err) => {
        console.error('Failed to delete device:', err);
        showToast('error', t('common.error'), t('notifications.delete_failed', 'Delete failed'));
      });
  };

  const deviceName = currentDevice.display_name || currentDevice.hostname || currentDevice.ip;

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
        <InspectorHeader
          device={currentDevice}
          deviceName={deviceName}
          networkPath={networkPath}
          activeTab={activeTab}
          onTab={setActiveTab}
          onClose={onClose}
        />

        <div
          className="modal-body"
          id="inspector-tabpanel"
          role="tabpanel"
          aria-labelledby={`inspector-tab-${activeTab}`}
          tabIndex={0}
          style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-lg)', minHeight: 400 }}
        >
          {activeTab === 'settings' && (
            <SettingsTab
              formData={formData}
              setFormData={setFormData}
              currentDevice={currentDevice}
              devices={devices || []}
              groups={groups}
              racks={racks}
              isRefreshing={isRefreshing}
              onRefreshInfo={handleRefreshInfo}
              onSubmit={handleSubmit}
            />
          )}
          {activeTab === 'services' && (
            <ServicesTab
              device={currentDevice}
              setDevice={setCurrentDevice}
              onSave={onSave}
              isScanning={isScanningServices}
              onScan={handleScanServices}
            />
          )}
          {activeTab === 'interfaces' && (
            <InterfacesTab device={currentDevice} onChanged={onSave} onMergedAway={onClose} onInterfaces={updateInterfaces} />
          )}
          {activeTab === 'history' && <HistoryTab history={history} isLoading={isLoadingHistory} />}
          {activeTab === 'agent' && <AgentTab deviceId={currentDevice.id} panel={agentPanel} />}
        </div>

        {/* Destructive action on the left, the usual Cancel / Save pair on the right */}
        <div className="inspector-footer">
          <button type="button" className="btn btn-danger btn-sm inspector-footer__delete" onClick={handleDelete}>
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

interface InspectorHeaderProps {
  device: Device;
  deviceName: string;
  networkPath: Device[];
  activeTab: EditorTab;
  onTab: (tab: EditorTab) => void;
  onClose: () => void;
}

function InspectorHeader({ device, deviceName, networkPath, activeTab, onTab, onClose }: InspectorHeaderProps) {
  const { t } = useTranslation();
  const deviceRole = deviceRoleOf(device);
  const interfaceCount = device.interfaces?.length ?? 0;
  const tabs: { id: EditorTab; label: string }[] = [
    { id: 'settings', label: t('editor.tabs.general') },
    { id: 'services', label: t('editor.tabs.services') },
    { id: 'interfaces', label: interfaceCount ? `${t('editor.tabs.interfaces')} (${interfaceCount + 1})` : t('editor.tabs.interfaces') },
    { id: 'history', label: t('editor.tabs.history') },
    { id: 'agent', label: t('editor.tabs.agent') },
  ];

  const onTabKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === activeTab);
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    onTab(next.id);
    document.getElementById(`inspector-tab-${next.id}`)?.focus();
  };

  return (
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
          className={`status-dot ${device.is_online ? 'status-dot--online' : 'status-dot--offline'}`}
          role="img"
          aria-label={device.is_online ? t('network.online') : t('network.offline')}
        />
        <div className="inspector-title-text">
          <h2 id="inspector-title" className="inspector-title">{deviceName}</h2>
          <span className="inspector-subtitle">{device.ip}{deviceRole ? ` · ${deviceRole}` : ''}</span>
        </div>
        <button type="button" className="btn-close" onClick={onClose} aria-label={t('common.close')}><X size={18} /></button>
      </div>
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label={t('editor.title_edit')}
        onKeyDown={onTabKeyDown}
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
            onClick={() => onTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </header>
  );
}
