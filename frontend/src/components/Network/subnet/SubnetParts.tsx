import { useTranslation } from 'react-i18next';
import { Activity, LayoutGrid as Grid, Plus, RefreshCw, Search, Settings, Trash2 } from 'lucide-react';
import type { DiscoveredHost, Subnet } from '../../../types';
import { prefixOf, type NetworkArea } from './model';
import { GatewayFields, type GatewayPatch } from './GatewayFields';

interface SubnetTabsProps {
  subnets: Subnet[];
  activePrefix: string;
  onSelect: (prefix: string) => void;
  onDelete: (subnet: Subnet) => void;
  onAdd: () => void;
}

export function SubnetTabs({ subnets, activePrefix, onSelect, onDelete, onAdd }: SubnetTabsProps) {
  const { t } = useTranslation();
  return (
    <div className="subnet-tabs">
      {subnets.map(sub => {
        const prefix = prefixOf(sub.cidr);
        const active = activePrefix === prefix;
        const isProbe = sub.is_agent_probe === true;
        const isL2 = sub.is_direct_l2 !== false;
        const paused = sub.is_enabled === false;
        return (
          <div key={sub.id} className={`subnet-tab${active ? ' is-active' : ''}${paused ? ' is-paused' : ''}`}>
            <button
              type="button"
              className="subnet-tab__select"
              aria-label={paused ? `${sub.name} (${t('network.subnet_paused')})` : sub.name}
              aria-pressed={active}
              title={paused ? t('network.subnet_paused_hint') : undefined}
              onClick={() => onSelect(prefix)}
            >
              <span>{sub.name}</span>
              <span
                style={{
                  fontSize: '0.68rem',
                  padding: '1px 6px',
                  borderRadius: '6px',
                  fontWeight: 600,
                  marginLeft: '8px',
                  background: isProbe
                    ? 'rgba(6, 182, 212, 0.15)'
                    : (isL2 ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)'),
                  color: isProbe ? '#22d3ee' : (isL2 ? '#4ade80' : '#fbbf24'),
                  border: `1px solid ${
                    isProbe
                      ? 'rgba(6, 182, 212, 0.3)'
                      : (isL2 ? 'rgba(34, 197, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)')
                  }`,
                }}
                title={
                  isProbe
                    ? t('network.l2_probe_via', { probe: sub.probe_device_name || sub.probe_device_ip || 'Agent' })
                    : (isL2
                        ? (sub.interface_name ? t('network.l2_direct_via', { interface: sub.interface_name }) : t('network.l2_direct'))
                        : t('network.l3_routed'))
                }
              >
                {isProbe ? t('network.l2_probe') : (isL2 ? 'L2' : 'L3')}
              </span>
              {paused && <span className="subnet-tab__paused" aria-hidden="true">{t('network.subnet_paused')}</span>}
            </button>
            {active && (
              <button
                type="button"
                className="subnet-tab__delete"
                onClick={(e) => { e.stopPropagation(); onDelete(sub); }}
                title={t('common.delete')}
                aria-label={`${t('common.delete')} ${sub.cidr}`}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
      <button type="button" className="subnet-tabs__add" onClick={onAdd}>
        <Plus size={14} aria-hidden="true" /> {t('network.add_subnet')}
      </button>
    </div>
  );
}

interface SubnetHeaderProps {
  isMobile: boolean;
  onlineCount: number;
  zoom: number;
  onZoom: (zoom: number) => void;
  isDiscovering: boolean;
  onManageAreas: () => void;
  onSubnetSettings: () => void;
  onDiscover: () => void;
  currentSubnet?: Subnet;
}

export function SubnetHeader({ isMobile, onlineCount, zoom, onZoom, isDiscovering, onManageAreas, onSubnetSettings, onDiscover, currentSubnet }: SubnetHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="subnet-header" style={{ flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', width: '100%', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: '4px', flexWrap: 'wrap' }}>
            <h1 className="visually-hidden-mobile" style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.01em' }}>{t('sidebar.network_planner')}</h1>
            <div className="status-badge known" style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(34, 197, 94, 0.05)', color: '#4ade80', border: '1px solid rgba(34, 197, 94, 0.2)', padding: '6px 12px', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 600 }}>
              <Activity size={14} />
              <span>{onlineCount} {t('network.online')}</span>
            </div>
            {currentSubnet && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: currentSubnet.is_agent_probe
                    ? 'rgba(6, 182, 212, 0.1)'
                    : (currentSubnet.is_direct_l2 !== false ? 'rgba(34, 197, 94, 0.08)' : 'rgba(245, 158, 11, 0.08)'),
                  color: currentSubnet.is_agent_probe
                    ? '#22d3ee'
                    : (currentSubnet.is_direct_l2 !== false ? '#4ade80' : '#fbbf24'),
                  border: `1px solid ${
                    currentSubnet.is_agent_probe
                      ? 'rgba(6, 182, 212, 0.3)'
                      : (currentSubnet.is_direct_l2 !== false ? 'rgba(34, 197, 94, 0.25)' : 'rgba(245, 158, 11, 0.25)')
                  }`,
                  padding: '6px 12px',
                  borderRadius: '12px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'help',
                }}
                title={
                  currentSubnet.is_agent_probe
                    ? t('network.l2_probe_desc', {
                        probe: currentSubnet.probe_device_name || currentSubnet.probe_device_ip || 'Agent',
                      })
                    : (currentSubnet.is_direct_l2 !== false
                        ? t('network.l2_direct_desc')
                        : t('network.l3_routed_desc'))
                }
              >
                <span>
                  {currentSubnet.is_agent_probe
                    ? `● ${t('network.l2_probe_via', { probe: currentSubnet.probe_device_name || currentSubnet.probe_device_ip || 'Agent' })}`
                    : (currentSubnet.is_direct_l2 !== false ? `● ${t('network.l2_direct')}` : `▲ ${t('network.l3_routed')}`)}
                </span>
                {!currentSubnet.is_agent_probe && currentSubnet.interface_name && (
                  <span style={{ opacity: 0.75, fontSize: '0.75rem', fontWeight: 500 }}>({currentSubnet.interface_name})</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
          {!isMobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', padding: 'var(--space-sm) var(--space-md)', background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <label htmlFor="ip-zoom" style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{t('network.zoom')}</label>
              <input id="ip-zoom" type="range" min="0.5" max="2" step="0.1" value={zoom} onChange={e => onZoom(parseFloat(e.target.value))} />
            </div>
          )}
          <button className="btn btn-secondary btn-sm" onClick={onManageAreas}><Grid size={16} /> {!isMobile && t('network.manage_areas')}</button>
          <button className="btn btn-secondary btn-sm" onClick={onSubnetSettings}><Settings size={16} /> {!isMobile && t('network.subnet_settings')}</button>
          <button className={`btn btn-sm ${isDiscovering ? 'btn-secondary' : 'btn-primary'}`} onClick={onDiscover} disabled={isDiscovering}>
            {isDiscovering ? <RefreshCw size={16} className="spinning" /> : <><Search size={16} /> {!isMobile && t('dashboard.scan')}</>}
          </button>
        </div>
      </div>
    </header>
  );
}

export function RecentFindings({ hosts, onSelect }: { hosts: DiscoveredHost[]; onSelect: (prefix: string) => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ marginTop: '30px', padding: '24px', background: 'rgba(56, 189, 248, 0.02)', borderRadius: '16px', border: '1px solid var(--border-subtle)' }}>
      <h4 style={{ margin: '0 0 16px 0', fontSize: '0.95rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Search size={18} className="text-accent" /> {t('network.recent_findings')}
      </h4>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {hosts.map(h => (
          <div key={h.id} style={{ padding: '6px 12px', background: h.is_online ? 'rgba(34, 197, 94, 0.08)' : 'rgba(255,255,255,0.03)', color: h.is_online ? '#4ade80' : 'var(--text-secondary)', borderRadius: '8px', fontSize: '0.8rem', border: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }} onClick={() => onSelect(h.ip.split('.').slice(0, 3).join('.'))}>
            {h.ip}
          </div>
        ))}
      </div>
    </div>
  );
}

interface SubnetSettingsModalProps {
  subnets: Subnet[];
  onUpdate: (id: number, data: { name?: string; dns_server?: string | null; is_enabled?: boolean } & GatewayPatch) => void;
  onDelete: (subnet: Subnet) => void;
  onClose: () => void;
}

export function SubnetSettingsModal({ subnets, onUpdate, onDelete, onClose }: SubnetSettingsModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h3>{t('network.subnet_config')}</h3></div>
        <div className="modal-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {subnets.map(sub => {
              const isProbe = sub.is_agent_probe === true;
              const isL2 = sub.is_direct_l2 !== false;
              return (
                <div key={sub.id} style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <strong>{sub.cidr}</strong>
                      <span
                        style={{
                          fontSize: '0.72rem',
                          padding: '2px 8px',
                          borderRadius: '6px',
                          fontWeight: 600,
                          background: isProbe ? 'rgba(6, 182, 212, 0.12)' : (isL2 ? 'rgba(34, 197, 94, 0.12)' : 'rgba(245, 158, 11, 0.12)'),
                          color: isProbe ? '#22d3ee' : (isL2 ? '#4ade80' : '#fbbf24'),
                          border: `1px solid ${isProbe ? 'rgba(6, 182, 212, 0.25)' : (isL2 ? 'rgba(34, 197, 94, 0.25)' : 'rgba(245, 158, 11, 0.25)')}`,
                        }}
                      >
                        {isProbe
                          ? t('network.l2_probe_via', { probe: sub.probe_device_name || sub.probe_device_ip || 'Agent' })
                          : (isL2
                              ? (sub.interface_name ? t('network.l2_direct_via', { interface: sub.interface_name }) : t('network.l2_direct'))
                              : t('network.l3_routed_no_arp'))}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <label className="settings-check">
                        <input
                          type="checkbox"
                          checked={sub.is_enabled !== false}
                          onChange={e => onUpdate(sub.id, { is_enabled: e.target.checked })}
                          aria-label={t('network.subnet_scan_label', { cidr: sub.cidr })}
                        />
                        <span aria-hidden="true">{t('network.subnet_scan')}</span>
                      </label>
                      <button className="btn btn-danger btn-sm" style={{ display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => onDelete(sub)}>
                        <Trash2 size={14} /> <span>{t('common.delete')}</span>
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <input className="input" defaultValue={sub.name} onBlur={e => onUpdate(sub.id, { name: e.target.value })} />
                    <input className="input" defaultValue={sub.dns_server || ''} placeholder={t('network.dns_gateway', 'DNS Gateway')} onBlur={e => onUpdate(sub.id, { dns_server: e.target.value || null })} />
                  </div>
                  <GatewayFields subnet={sub} onSave={(patch) => onUpdate(sub.id, patch)} />
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-footer"><button className="btn btn-primary" onClick={onClose}>{t('common.finish')}</button></div>
      </div>
    </div>
  );
}

const AREA_ROW = { display: 'grid', gridTemplateColumns: '1fr 80px 80px 60px 48px', gap: '12px' } as const;
export const EMPTY_AREA: NetworkArea = { name: '', start: 0, end: 0, color: '#38bdf8' };

interface AreaManagerModalProps {
  areas: NetworkArea[];
  /** The "new area" row; kept by the caller so it survives closing the dialog */
  draft: NetworkArea;
  onDraft: (draft: NetworkArea) => void;
  onSave: (areas: NetworkArea[]) => void;
  onClose: () => void;
}

/** Add, edit and remove the address ranges of the current subnet; every change is saved at once. */
export function AreaManagerModal({ areas, draft, onDraft, onSave, onClose }: AreaManagerModalProps) {
  const { t } = useTranslation();
  const edit = (idx: number, patch: Partial<NetworkArea>) =>
    onSave(areas.map((area, i) => (i === idx ? { ...area, ...patch } : area)));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header"><h3>{t('network.manage_areas')}</h3></div>
        <div className="modal-body">
          <div style={{ ...AREA_ROW, marginBottom: '24px', padding: '16px', background: 'rgba(255,255,255,0.03)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
            <input className="input" placeholder={t('network.area_name', 'Area Name')} value={draft.name} onChange={e => onDraft({ ...draft, name: e.target.value })} />
            <input className="input" type="number" placeholder={t('network.start')} value={draft.start} onChange={e => onDraft({ ...draft, start: parseInt(e.target.value) })} />
            <input className="input" type="number" placeholder={t('network.end')} value={draft.end} onChange={e => onDraft({ ...draft, end: parseInt(e.target.value) })} />
            <div style={{ position: 'relative', height: '40px' }}>
              <input
                style={{ width: '100%', height: '100%', padding: '2px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: '6px', cursor: 'pointer' }}
                type="color"
                value={draft.color}
                onChange={e => onDraft({ ...draft, color: e.target.value })}
              />
            </div>
            <button
              className="btn btn-primary"
              style={{ height: '40px', padding: 0, display: 'flex', alignItems: 'center', justifyItems: 'center', justifyContent: 'center' }}
              onClick={() => { onSave([...areas, draft]); onDraft(EMPTY_AREA); }}
            >
              <Plus size={20} strokeWidth={3} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '400px', overflowY: 'auto', paddingRight: '4px' }}>
            {areas.map((area, idx) => (
              <div key={idx} style={{ ...AREA_ROW, alignItems: 'center', padding: '12px', background: 'rgba(255,255,255,0.04)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <input className="input" value={area.name} onChange={e => edit(idx, { name: e.target.value })} />
                <input className="input text-center" type="number" value={area.start} onChange={e => edit(idx, { start: parseInt(e.target.value) })} />
                <input className="input text-center" type="number" value={area.end} onChange={e => edit(idx, { end: parseInt(e.target.value) })} />
                <input
                  style={{ width: '100%', height: '32px', padding: '2px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', cursor: 'pointer' }}
                  type="color"
                  value={area.color}
                  onChange={e => edit(idx, { color: e.target.value })}
                />
                <button
                  className="btn btn-icon"
                  style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.2)', width: '40px', height: '40px' }}
                  onClick={() => onSave(areas.filter((_, i) => i !== idx))}
                  title={t('common.delete')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
