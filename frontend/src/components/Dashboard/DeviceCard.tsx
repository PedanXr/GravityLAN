import { memo } from 'react';
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

export const DeviceCard = memo(({ device, isEditMode, onEdit, onRefresh, isSelected, onSelect }: DeviceCardProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const displayName = device.display_name || device.hostname || device.ip;
  const role = roleLabel(device);
  const services = [...device.services].sort((a, b) => a.sort_order - b.sort_order);
  const hasSsh = services.some((s) => s.protocol.toLowerCase() === 'ssh' || s.port === 22);
  const agent = device.agent_info;
  const hasAgentUpdate = !isEditMode && isAgentOutdated(agent?.agent_version, agent?.latest_version);
  const hasPendingKey = !isEditMode && !!device.has_pending_token;

  const refreshInfo = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    try {
      await api.refreshDeviceInfo(device.id);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 1000);
    }
  };

  const adoptKey = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t('agent.adopt_confirm', 'Permanently accept this new agent key?'))) return;
    try {
      await api.adoptAgent(device.id);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Adoption failed:", err);
    }
  };

  const clearIpChange = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateDevice(device.id, { old_ip: null, ip_changed_at: null });
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error("Failed to clear IP change badge:", err);
    }
  };

  return (
    <article
      className={`device-card ${isEditMode ? 'is-editing' : ''} ${isSelected ? 'is-selected' : ''} ${device.is_online ? '' : 'is-offline'}`}
      style={{ height: '100%', width: '100%', position: 'relative' }}
    >
      {isEditMode && onSelect && (
        <button
          type="button"
          className={`device-card__select ${isSelected ? 'is-selected' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(!isSelected);
          }}
          aria-pressed={isSelected}
          aria-label={t('dashboard.delete_selected', { count: 1 })}
          title={t('dashboard.delete_selected', { count: 1 })}
        >
          {isSelected ? <Check size={16} /> : <Trash2 size={12} />}
        </button>
      )}

      {isEditMode && (
        <div className="device-card__handle" style={{ right: 8, top: 8, left: 'auto' }}>
          <Move size={14} />
        </div>
      )}

      <header className="device-card__header">
        <span
          className={`status-dot ${device.is_online ? 'status-dot--online' : 'status-dot--offline'}`}
          role="img"
          aria-label={device.is_online ? t('network.online') : t('network.offline')}
          title={device.is_online ? t('network.online') : t('network.offline')}
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
        {!isEditMode && (
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
        )}
      </header>

      {(hasAgentUpdate || hasPendingKey || device.old_ip) && (
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
      )}

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
}, (prev, next) => {
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
});
