import type { CSSProperties, MouseEvent } from 'react';
import type { TFunction } from 'i18next';
import { Activity, Cpu, Eye, EyeOff, Globe, Info, Lock, Monitor, Plus, Save, Server, Shield, Trash2, type LucideIcon } from 'lucide-react';
import type { Device, DiscoveredHost } from '../../../types';
import type { NetworkArea } from '../subnet/model';

const DEVICE_ICON_MAP: Record<string, LucideIcon> = {
  'Workstation': Monitor,
  'Server': Server,
  'Smartphone': Cpu,
  'Netzwerk': Shield,
  'Unbekannt': Globe,
};

export function tileIcon(device?: Device, discovered?: DiscoveredHost): LucideIcon | null {
  if (device) return DEVICE_ICON_MAP[device.device_type] || Globe;
  return discovered ? Globe : null;
}

interface TileLook {
  status: string;
  device?: Device;
  discovered?: DiscoveredHost;
  group?: NetworkArea;
  isReserved?: boolean;
  safeZoom: number;
}

/** Border, emphasis and background of a tile from what is known about its address. */
export function tileStyle({ status, device, discovered, group, isReserved, safeZoom }: TileLook): CSSProperties {
  const isResponding = status === 'online';
  const byKind = <T,>(forGroup: T, forDevice: T, otherwise: T) => (group ? forGroup : device ? forDevice : otherwise);
  return {
    fontSize: `${0.7 * safeZoom}rem`,
    borderColor: byKind<string | undefined>(group?.color, 'var(--accent-primary)', undefined),
    borderWidth: byKind('2px', '1.5px', '1px'),
    opacity: status === 'empty' ? 0.6 : 1,
    boxShadow: (discovered?.is_monitored && !isResponding) ? 'inset 0 0 10px rgba(239, 68, 68, 0.4)' : undefined,
    position: 'relative',
    cursor: (device || discovered) ? 'pointer' : 'default',
    background: (discovered && !isResponding) ? 'rgba(255, 255, 255, 0.05)' : undefined,
    borderStyle: isReserved ? 'dashed' : 'solid',
    outline: 'none'
  };
}

/** Reserved lock, monitoring eye and online dot in the tile corners. */
export function TileMarkers({ isReserved, monitored, known, isResponding, safeZoom }: {
  isReserved?: boolean; monitored?: boolean; known: boolean; isResponding: boolean; safeZoom: number;
}) {
  const dotColor = isResponding ? '#22c55e' : '#ef4444';
  return (
    <>
      {isReserved && (
        <div style={{ position: 'absolute', bottom: 2, right: 2, color: 'var(--accent-primary)', opacity: 0.8, zIndex: 3 }}>
          <Lock size={8 * safeZoom} />
        </div>
      )}
      {monitored && (
        <div style={{
          position: 'absolute', top: 2, left: 2,
          color: isResponding ? 'var(--accent-primary)' : 'var(--accent-danger)',
          zIndex: 3,
          animation: isResponding ? 'pulse 2s infinite' : 'pulse-fast 0.5s infinite',
          filter: isResponding ? 'none' : 'drop-shadow(0 0 4px var(--accent-danger))'
        }}>
          <Eye size={10 * safeZoom} />
        </div>
      )}
      {known && (
        <div style={{
          position: 'absolute', top: 4, right: 4,
          width: 6 * safeZoom, height: 6 * safeZoom,
          borderRadius: '50%', background: dotColor,
          boxShadow: `0 0 ${4 * safeZoom}px ${dotColor}`,
          zIndex: 3
        }} />
      )}
    </>
  );
}

/** Run a tooltip action without also triggering the tile's own click. */
const stop = (action: () => void) => (e: MouseEvent) => { e.stopPropagation(); action(); };

function ReserveToggle({ reserved, onToggle, t, style }: { reserved: boolean; onToggle: () => void; t: TFunction; style?: CSSProperties }) {
  return (
    <button
      style={{ ...style, background: 'transparent', border: 'none', color: reserved ? 'var(--accent-primary)' : 'var(--text-tertiary)', cursor: 'pointer' }}
      onClick={stop(onToggle)}
      title={reserved ? t('network.unreserve', 'Remove reservation') : t('network.reserve', 'Mark IP as reserved (fixed)')}
    >
      {reserved ? <Lock size={16} /> : <Lock size={16} style={{ opacity: 0.3 }} />}
    </button>
  );
}

export function DeviceHeaderAction({ device, t, onUpdateDeviceField }: { device: Device; t: TFunction; onUpdateDeviceField: (id: number, data: Partial<Device>) => void }) {
  return (
    <ReserveToggle
      reserved={!!device.is_reserved}
      onToggle={() => onUpdateDeviceField(device.id, { is_reserved: !device.is_reserved })}
      t={t}
      style={{ marginLeft: 'auto' }}
    />
  );
}

interface HostCallbacks {
  onUpdateDiscoveredHost: (id: number, data: { custom_name?: string; is_monitored?: boolean; is_reserved?: boolean }) => void;
  onDeleteDiscoveredHost: (id: number, ip: string) => void;
}

/** Reserve, monitor and forget buttons next to a discovered host's name. */
export function DiscoveredHeaderActions({ host, ip, t, onUpdateDiscoveredHost, onDeleteDiscoveredHost }: HostCallbacks & { host: DiscoveredHost; ip: string; t: TFunction }) {
  return (
    <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
      <ReserveToggle reserved={!!host.is_reserved} onToggle={() => onUpdateDiscoveredHost(host.id, { is_reserved: !host.is_reserved })} t={t} />
      <button
        style={{ background: 'transparent', border: 'none', color: host.is_monitored ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer' }}
        onClick={stop(() => onUpdateDiscoveredHost(host.id, { is_monitored: !host.is_monitored }))}
        title={host.is_monitored ? t('network.stop_monitoring') : t('network.start_monitoring')}
      >
        {host.is_monitored ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>
      <button
        style={{ background: 'transparent', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', padding: '0 4px', opacity: 0.8 }}
        onClick={stop(() => onDeleteDiscoveredHost(host.id, ip))}
        title={t('network.remove_from_list', 'Remove from list')}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

const ACTION_BTN: CSSProperties = { justifyContent: 'center' };

export function DeviceActions({ busy, t, onOpen, onScan }: { busy: boolean; t: TFunction; onOpen: () => void; onScan: () => void }) {
  return (
    <>
      <button className="btn btn-secondary btn-sm" style={ACTION_BTN} onClick={stop(onOpen)}><Info size={12} /> {t('editor.tabs.general')}</button>
      <button className="btn btn-secondary btn-sm" style={ACTION_BTN} onClick={stop(onScan)} disabled={busy}><Activity size={12} className={busy ? 'spinning' : ''} /> {t('network.nmap_scan')}</button>
    </>
  );
}

interface DiscoveredActionsProps {
  host?: DiscoveredHost;
  scanBusy: boolean;
  addBusy: boolean;
  t: TFunction;
  onRename: (name: string) => void;
  onAdd: () => void;
  onScan: () => void;
}

/** Custom name, "add to overview" and port scan for an address that is not in the overview. */
export function DiscoveredActions({ host, scanBusy, addBusy, t, onRename, onAdd, onScan }: DiscoveredActionsProps) {
  return (
    <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          className="input"
          style={{ padding: '4px 8px', fontSize: '0.7rem', flex: 1 }}
          placeholder={t('editor.custom_name_placeholder')}
          defaultValue={host?.custom_name || ''}
          onKeyDown={(e) => { if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value); }}
        />
        <button className="btn btn-secondary btn-sm" onClick={(e) => {
          e.stopPropagation();
          onRename((e.currentTarget.previousElementSibling as HTMLInputElement).value);
        }}>
          <Save size={14} />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <button className="btn btn-primary btn-sm" style={ACTION_BTN} onClick={stop(onAdd)} disabled={addBusy}>
          {addBusy ? <Activity size={12} className="spinning" /> : <Plus size={12} />} {t('network.status_on_dashboard')}
        </button>
        <button className="btn btn-secondary btn-sm" style={ACTION_BTN} onClick={stop(onScan)} disabled={scanBusy}><Activity size={12} className={scanBusy ? 'spinning' : ''} /> {t('network.nmap_scan')}</button>
      </div>
    </div>
  );
}

/** Running services of an overview device and the open ports found on a discovered host. */
export function ServiceBadges({ device, discovered, t }: { device?: Device; discovered?: DiscoveredHost; t: TFunction }) {
  if (!device?.services && !discovered?.ports) return null;
  return (
    <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: '0.65rem', marginBottom: '8px', opacity: 0.6, fontWeight: 'bold', textTransform: 'uppercase' }}>Services / {t('network.nmap_scan')}:</div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {device?.services?.filter(s => s.is_up).map(s => (<span key={s.id} className="service-badge" style={{ fontSize: '0.55rem', padding: '2px 6px', background: 'rgba(56, 189, 248, 0.1)', color: 'white' }}>{s.name?.replace('Service ', '') || 'Svc'}</span>))}
        {discovered?.ports?.map((p: number) => (<span key={p} className="service-badge" style={{ fontSize: '0.55rem', padding: '2px 6px', background: 'rgba(34, 197, 94, 0.1)', color: '#4ade80' }}>{p}</span>))}
      </div>
    </div>
  );
}
