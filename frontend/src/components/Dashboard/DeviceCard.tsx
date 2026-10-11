import { memo, type MouseEvent, type ReactNode } from 'react';
import type { Device } from '../../types';
import { ServiceBadge } from './ServiceBadge';
import { DeviceMetrics } from './DeviceMetrics';
import { Move, Settings, RefreshCw, Check, Trash2, ShieldAlert, ArrowRight, X, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { isAgentOutdated } from '../../utils/version';

interface DeviceCardProps {
  device: Device;
  isEditMode?: boolean;
  onEdit?: (e: React.MouseEvent) => void;
  onRefresh?: () => void;
  isSelected?: boolean;
  onSelect?: (selected: boolean) => void;
}

/** Short role label: physical host, VM or container. */
function roleLabel(device: Device): string | null {
  if (device.virtual_type === 'docker') return 'Docker';
  if (device.virtual_type === 'vm') return 'VM';
  if (device.virtual_type) return device.virtual_type;
  if (device.is_host) return 'Host';
  return null;
}

/** Re-render only when something the card shows changes, not on new callbacks. */
function sameCard(prev: DeviceCardProps, next: DeviceCardProps): boolean {
  return (
    prev.isEditMode === next.isEditMode &&
    prev.isSelected === next.isSelected &&
    prev.device.id === next.device.id &&
    prev.device.is_online === next.device.is_online &&
    prev.device.display_name === next.device.display_name &&
    prev.device.ip === next.device.ip &&
    prev.device.old_ip === next.device.old_ip &&
    prev.device.has_pending_token === next.device.has_pending_token &&
    prev.device.parent_id === next.device.parent_id &&
    prev.device.parent_name === next.device.parent_name &&
    prev.device.virtual_type === next.device.virtual_type &&
    prev.device.is_host === next.device.is_host &&
    JSON.stringify(prev.device.services) === JSON.stringify(next.device.services) &&
    prev.device.agent_info?.agent_version === next.device.agent_info?.agent_version &&
    prev.device.agent_info?.latest_version === next.device.agent_info?.latest_version
  );
}

/** Run a card action without opening the card, then refresh the dashboard. */
async function runCardAction(action: () => Promise<unknown>, onRefresh: (() => void) | undefined, failure: string) {
  try {
    await action();
    onRefresh?.();
  } catch (err) {
    console.error(failure, err);
  }
}

export const DeviceCard = memo(({ device, isEditMode, onEdit, onRefresh, isSelected, onSelect }: DeviceCardProps) => {
  const displayName = device.display_name || device.hostname || device.ip;
  const services = [...device.services].sort((a, b) => a.sort_order - b.sort_order);
  const hasSsh = services.some((s) => s.protocol.toLowerCase() === 'ssh' || s.port === 22);

  return (
    <article
      className={`device-card ${isEditMode ? 'is-editing' : ''} ${isSelected ? 'is-selected' : ''} ${device.is_online ? '' : 'is-offline'}`}
      style={{ height: '100%', width: '100%', position: 'relative' }}
    >
      {isEditMode && onSelect && <SelectToggle selected={isSelected} onSelect={onSelect} />}

      {isEditMode && (
        <div className="device-card__handle" style={{ right: 8, top: 8, left: 'auto' }}>
          <Move size={14} />
        </div>
      )}

      <CardHeader device={device} displayName={displayName}>
        {!isEditMode && <CardActions device={device} displayName={displayName} hasSsh={hasSsh} onEdit={onEdit} onRefresh={onRefresh} />}
      </CardHeader>

      <CardFlags device={device} isEditMode={!!isEditMode} onRefresh={onRefresh} />

      {!isEditMode && <DeviceMetrics deviceId={device.id} compact={true} />}

      {/* Every service stays one click away; the row wraps (and scrolls if the card is too short) */}
      {services.length > 0 && (
        <div className="device-card__services">
          {services.map((service) => (
            <ServiceBadge key={service.id} service={service} ip={device.ip} disabled={isEditMode} />
          ))}
        </div>
      )}
    </article>
  );
}, sameCard);

function SelectToggle({ selected, onSelect }: { selected?: boolean; onSelect: (selected: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`device-card__select ${selected ? 'is-selected' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(!selected);
      }}
      aria-pressed={selected}
      aria-label={t('dashboard.delete_selected', { count: 1 })}
      title={t('dashboard.delete_selected', { count: 1 })}
    >
      {selected ? <Check size={16} /> : <Trash2 size={12} />}
    </button>
  );
}

function CardHeader({ device, displayName, children }: { device: Device; displayName: string; children: ReactNode }) {
  const { t } = useTranslation();
  const role = roleLabel(device);
  const status = device.is_online ? t('network.online') : t('network.offline');
  return (
    <header className="device-card__header">
      <span
        className={`status-dot ${device.is_online ? 'status-dot--online' : 'status-dot--offline'}`}
        role="img"
        aria-label={status}
        title={status}
      />
      <div className="device-card__title">
        <h3 className="device-card__name" title={displayName}>{displayName}</h3>
        <div className="device-card__meta">
          <span className="device-card__ip">{device.ip}</span>
          {role && <span className="device-tag">{role}</span>}
          {device.parent_id && (
            <span className="device-card__parent">{t('dashboard.on_host', { host: device.parent_name || 'Host' })}</span>
          )}
        </div>
      </div>
      {children}
    </header>
  );
}

interface CardActionsProps {
  device: Device;
  displayName: string;
  hasSsh: boolean;
  onEdit?: (e: React.MouseEvent) => void;
  onRefresh?: () => void;
}

function CardActions({ device, displayName, hasSsh, onEdit, onRefresh }: CardActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const refreshInfo = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    try {
      await api.refreshDeviceInfo(device.id);
      onRefresh?.();
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 1000);
    }
  };

  return (
    <div className="device-card__actions">
      {hasSsh && (
        <button
          type="button"
          className="device-card__icon-btn"
          onClick={(e) => { e.stopPropagation(); navigate(`/ssh?device=${device.id}`); }}
          aria-label={`${t('ssh.open_terminal')}: ${displayName}`}
          title={t('ssh.open_terminal')}
        >
          <SquareTerminal size={15} />
        </button>
      )}
      <button type="button" className="device-card__icon-btn" onClick={refreshInfo} aria-label={t('dashboard.refresh_info')} title={t('dashboard.refresh_info')}>
        <RefreshCw size={14} />
      </button>
      <button type="button" className="device-card__icon-btn" onClick={onEdit} aria-label={`${t('dashboard.edit_device')}: ${displayName}`} title={t('dashboard.edit_device')}>
        <Settings size={15} />
      </button>
    </div>
  );
}

/** Agent update, new agent key (adopt) and IP change (dismiss) under the header. */
function CardFlags({ device, isEditMode, onRefresh }: { device: Device; isEditMode: boolean; onRefresh?: () => void }) {
  const { t } = useTranslation();
  const agent = device.agent_info;
  const hasAgentUpdate = !isEditMode && isAgentOutdated(agent?.agent_version, agent?.latest_version);
  const hasPendingKey = !isEditMode && !!device.has_pending_token;
  if (!hasAgentUpdate && !hasPendingKey && !device.old_ip) return null;

  const adoptKey = (e: MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t('agent.adopt_confirm', 'Permanently accept this new agent key?'))) return;
    runCardAction(() => api.adoptAgent(device.id), onRefresh, 'Adoption failed:');
  };
  const clearIpChange = (e: MouseEvent) => {
    e.stopPropagation();
    runCardAction(() => api.updateDevice(device.id, { old_ip: null, ip_changed_at: null }), onRefresh, 'Failed to clear IP change badge:');
  };

  return (
    <div className="device-card__flags">
      {hasAgentUpdate && (
        <span className="device-tag device-tag--warn" title={t('common.update_available', { version: agent?.latest_version })}>
          <RefreshCw size={11} aria-hidden="true" /> {t('dashboard.agent_update')}
        </span>
      )}
      {hasPendingKey && (
        <span className="device-tag device-tag--danger">
          <ShieldAlert size={11} aria-hidden="true" /> {t('dashboard.security_alert')}
          <button type="button" className="device-tag__action" onClick={adoptKey}>{t('dashboard.adopt')}</button>
        </span>
      )}
      {device.old_ip && (
        <button
          type="button"
          className="device-tag device-tag--info"
          onClick={clearIpChange}
          title={t('dashboard.ip_changed_hint', 'IP has changed. Click to hide.')}
        >
          {device.old_ip} <ArrowRight size={11} aria-hidden="true" /> {device.ip} <X size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
