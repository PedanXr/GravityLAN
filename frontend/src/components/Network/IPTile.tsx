import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { Device, DiscoveredHost } from '../../types';
import type { NetworkArea } from './subnet/model';
import {
  DeviceActions, DeviceHeaderAction, DiscoveredActions, DiscoveredHeaderActions, ServiceBadges, TileMarkers, tileIcon, tileStyle,
} from './tile/TileParts';

interface IPTileProps {
  i: number;
  ip: string;
  device?: Device;
  discovered?: DiscoveredHost;
  status: string;
  group?: NetworkArea;
  isFirstRows: boolean;
  isReserved?: boolean;
  safeZoom: number;
  t: TFunction;
  onSelectDevice: (device: Device) => void;
  onUpdateDeviceField: (id: number, data: Partial<Device>) => void;
  onUpdateDiscoveredHost: (id: number, data: { custom_name?: string; is_monitored?: boolean; is_reserved?: boolean }) => void;
  onRefreshDevice: (id: number, ip: string, type: 'info' | 'services') => void;
  onScanDiscoveredHost: (ip: string) => void;
  onAddDevice: (ip: string) => void;
  onDeleteDiscoveredHost: (id: number, ip: string) => void;
  isRefreshingServices: boolean;
  isRefreshingAdd: boolean;
}

/** Re-render only when something the tile shows changes, not on new callbacks. */
function sameTile(prev: IPTileProps, next: IPTileProps): boolean {
  return (
    prev.status === next.status &&
    prev.isReserved === next.isReserved &&
    prev.safeZoom === next.safeZoom &&
    prev.device?.id === next.device?.id &&
    prev.device?.is_online === next.device?.is_online &&
    prev.device?.is_reserved === next.device?.is_reserved &&
    prev.discovered?.id === next.discovered?.id &&
    prev.discovered?.is_online === next.discovered?.is_online &&
    prev.discovered?.is_monitored === next.discovered?.is_monitored &&
    prev.isRefreshingServices === next.isRefreshingServices &&
    prev.isRefreshingAdd === next.isRefreshingAdd &&
    prev.group?.name === next.group?.name
  );
}

export const IPTile = memo((props: IPTileProps) => {
  const { i, ip, device, discovered, status, group, isReserved, safeZoom, t, onSelectDevice } = props;
  const isResponding = status === 'online';
  const known = !!(device || discovered);

  return (
    <div
      className={`ip-tile ${status}`}
      tabIndex={0}
      role="button"
      aria-label={`${t('network.device')} ${ip}, ${isResponding ? t('network.online') : t('network.offline')}`}
      style={tileStyle({ status, device, discovered, group, isReserved, safeZoom })}
      onClick={() => device && onSelectDevice(device)}
      onKeyDown={(e) => { if (e.key === 'Enter' && device) onSelectDevice(device); }}
    >
      <TileMarkers isReserved={isReserved} monitored={discovered?.is_monitored} known={known} isResponding={isResponding} safeZoom={safeZoom} />
      {device?.icon ? (
        <div style={{ fontSize: `${1.2 * safeZoom}rem`, opacity: isResponding ? 1 : 0.5 }}>{device.icon}</div>
      ) : (
        <span style={{ fontWeight: isResponding ? 'bold' : 'normal', opacity: known ? 1 : 0.4 }}>{i}</span>
      )}
      {group && (
        <div className="ip-tile__group" style={{
          position: 'absolute', top: '-8px', left: '4px', fontSize: '0.5rem',
          background: group.color, color: 'black', padding: '0 4px',
          borderRadius: '2px', fontWeight: 'bold', zIndex: 2
        }}>
          {group.name}
        </div>
      )}
      {known && <TileTooltip {...props} />}
    </div>
  );
}, sameTile);

/** Details and actions of a known address, shown on hover. */
function TileTooltip({
  ip, device, discovered, status, isFirstRows, safeZoom, t,
  onSelectDevice, onUpdateDeviceField, onUpdateDiscoveredHost, onRefreshDevice,
  onScanDiscoveredHost, onAddDevice, onDeleteDiscoveredHost, isRefreshingServices, isRefreshingAdd,
}: IPTileProps) {
  const Icon = tileIcon(device, discovered);
  const isResponding = status === 'online';
  const position = isFirstRows
    ? { top: '130%', bottom: 'auto', transformOrigin: 'top center' }
    : { bottom: '130%', top: 'auto', transformOrigin: 'bottom center' };

  return (
    <div
      className={`ip-tooltip ${isFirstRows ? 'tooltip-bottom' : 'tooltip-top'}`}
      style={{ width: `${260 * safeZoom}px`, ...position, pointerEvents: 'auto' }}
      onClick={e => e.stopPropagation()}
    >
      <h4 style={{ color: 'var(--accent-primary)', marginBottom: '12px', display: 'flex', alignItems: 'center' }}>
        {Icon && <Icon size={16 * safeZoom} style={{ marginRight: '8px' }} />}
        {device?.display_name || discovered?.custom_name || discovered?.hostname || t('network.unknown_device')}
        {device
          ? <DeviceHeaderAction device={device} t={t} onUpdateDeviceField={onUpdateDeviceField} />
          : discovered && <DiscoveredHeaderActions host={discovered} ip={ip} t={t} onUpdateDiscoveredHost={onUpdateDiscoveredHost} onDeleteDiscoveredHost={onDeleteDiscoveredHost} />}
      </h4>
      <div className="meta" style={{ fontSize: `${0.75 * safeZoom}rem` }}>
        <span className="label">IP:</span> <span className="value">{ip}</span>
        <span className="label">MAC:</span> <span className="value">{device?.mac || discovered?.mac || 'N/A'}</span>
        <span className="label">Status:</span> <span className="value" style={{ color: isResponding ? '#22c55e' : '#ef4444' }}>{isResponding ? t('network.online') : t('network.offline')}</span>
        {device && <><span className="label">Dashboard:</span> <span className="value" style={{ color: 'var(--accent-primary)' }}>{t('network.yes')}</span></>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '16px' }}>
        {device ? (
          <DeviceActions
            busy={isRefreshingServices}
            t={t}
            onOpen={() => onSelectDevice(device)}
            onScan={() => onRefreshDevice(device.id, ip, 'services')}
          />
        ) : (
          <DiscoveredActions
            host={discovered}
            scanBusy={isRefreshingServices}
            addBusy={isRefreshingAdd}
            t={t}
            onRename={(name) => discovered && onUpdateDiscoveredHost(discovered.id, { custom_name: name })}
            onAdd={() => onAddDevice(ip)}
            onScan={() => onScanDiscoveredHost(ip)}
          />
        )}
      </div>
      <ServiceBadges device={device} discovered={discovered} t={t} />
    </div>
  );
}
