import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, Cpu, Folder, HardDrive, Layout, Monitor, Radio, RefreshCw, Server, Tag, Wifi, type LucideIcon } from 'lucide-react';
import type { Device, DeviceGroup, Rack } from '../../../types';
import { intOrNull, type DeviceFormData, type SetFormData } from './deviceForm';

interface SettingsTabProps {
  formData: DeviceFormData;
  setFormData: SetFormData;
  currentDevice: Device;
  devices: Device[];
  groups: DeviceGroup[];
  racks: Rack[];
  isRefreshing: boolean;
  onRefreshInfo: () => void;
  onSubmit: (e: FormEvent) => void;
}

export function SettingsTab({ formData, setFormData, currentDevice, devices, groups, racks, isRefreshing, onRefreshInfo, onSubmit }: SettingsTabProps) {
  const { t } = useTranslation();
  const set = <K extends keyof DeviceFormData>(key: K, value: DeviceFormData[K]) =>
    setFormData(prev => ({ ...prev, [key]: value }));

  return (
    <form onSubmit={onSubmit}>
      {/* Basic Information */}
      <div className="editor-section-grid">
        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <label><Tag size={14} /> {t('editor.display_name')}</label>
          <div style={{ display: 'flex', gap: '12px' }}>
            <input
              className="input"
              style={{ flex: 1 }}
              value={formData.display_name}
              onChange={(e) => set('display_name', e.target.value)}
              placeholder={currentDevice.hostname || currentDevice.ip}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onRefreshInfo}
              disabled={isRefreshing}
              style={{ height: 42, padding: '0 16px', display: 'flex', alignItems: 'center', gap: '8px' }}
              title={t('editor.refresh_info')}
            >
              <RefreshCw size={16} className={isRefreshing ? 'spinning' : ''} />
              <span className="hidden sm:inline">{isRefreshing ? t('common.loading') : t('editor.refresh_info')}</span>
            </button>
          </div>
        </div>

        <div className="form-group">
          <label><Folder size={14} /> {t('editor.group')}</label>
          <select
            className="input"
            value={formData.group_id || ''}
            onChange={(e) => set('group_id', intOrNull(e.target.value))}
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
            onChange={(e) => set('vendor', e.target.value)}
            placeholder={t('common.unknown')}
          />
        </div>

        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <label><Monitor size={14} /> {t('editor.parent_device', 'Physischer Host')}</label>
          <select
            className="input"
            value={formData.parent_id || ''}
            onChange={(e) => set('parent_id', intOrNull(e.target.value))}
          >
            <option value="">{t('editor.no_parent', 'Kein Host (Physisch)')}</option>
            {devices.filter(d => d.id !== currentDevice.id && d.is_host).map(dev => (
              <option key={dev.id} value={dev.id}>{dev.display_name || dev.hostname || dev.ip}</option>
            ))}
          </select>
        </div>
      </div>

      <PlacementSection formData={formData} set={set} racks={racks} />

      {/* Advanced Connectivity & Role */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: '16px',
        marginBottom: '24px'
      }}>
        {ROLE_TOGGLES.map((role) => (
          <RoleToggle
            key={role.key}
            role={role}
            on={formData[role.key]}
            onToggle={() => setFormData(prev => ({ ...prev, [role.key]: !prev[role.key] }))}
          />
        ))}
      </div>

      {/* 24/7 Offline Monitoring Alert Toggle */}
      <div
        onClick={() => setFormData(prev => ({ ...prev, alert_offline: !prev.alert_offline }))}
        style={{
          padding: '12px 16px',
          marginBottom: '24px',
          background: formData.alert_offline ? 'rgba(16, 185, 129, 0.08)' : 'rgba(255, 255, 255, 0.02)',
          border: `1px solid ${formData.alert_offline ? 'rgba(16, 185, 129, 0.3)' : 'rgba(255, 255, 255, 0.08)'}`,
          borderRadius: '12px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          transition: 'all 0.2s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 34,
            height: 34,
            borderRadius: '8px',
            background: formData.alert_offline ? '#10b981' : 'rgba(255, 255, 255, 0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {formData.alert_offline ? <Bell size={18} color="white" /> : <BellOff size={18} color="#94a3b8" />}
          </div>
          <div>
            <div style={{ fontSize: '0.825rem', fontWeight: 600, color: formData.alert_offline ? '#f8fafc' : '#94a3b8' }}>
              {formData.alert_offline ? t('health_page.alert_offline_24_7') : t('health_page.alert_offline_client')}
            </div>
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '2px' }}>
              {t('health_page.alert_offline_hint')}
            </div>
          </div>
        </div>
        <input
          type="checkbox"
          checked={formData.alert_offline}
          onChange={() => {}}
          style={{ width: 18, height: 18, accentColor: '#10b981', cursor: 'pointer' }}
        />
      </div>

      {/* The parent host is chosen once, in the "Physical host" field above. */}

      <div className="form-group">
        <label>{t('editor.notes')}</label>
        <textarea
          className="input"
          style={{ minHeight: 80, resize: 'vertical' }}
          value={formData.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder={t('editor.notes_placeholder')}
        />
      </div>

      <SystemInfo device={currentDevice} />
    </form>
  );
}

type SetField = <K extends keyof DeviceFormData>(key: K, value: DeviceFormData[K]) => void;

function PlacementSection({ formData, set, racks }: { formData: DeviceFormData; set: SetField; racks: Rack[] }) {
  const { t } = useTranslation();
  return (
    <div className="editor-section-grid">
      <div className="form-group">
        <label><Layout size={14} /> {t('editor.rack_position', 'Rack & Position')}</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <select
            className="input"
            style={{ flex: 2 }}
            value={formData.rack_id || ''}
            onChange={(e) => set('rack_id', intOrNull(e.target.value))}
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
            onChange={(e) => set('rack_unit', intOrNull(e.target.value))}
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
          onChange={(e) => set('rack_height', parseInt(e.target.value) || 1)}
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
            onChange={(e) => set('w', parseInt(e.target.value))}
          />
          <span style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>x</span>
          <input
            type="number"
            className="input"
            style={{ flex: 1 }}
            value={formData.h}
            min={1}
            max={10}
            onChange={(e) => set('h', parseInt(e.target.value))}
          />
          <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginLeft: 4 }}>{t('editor.units')}</span>
        </div>
      </div>

      <BadgePicker value={formData.virtual_type} onChange={(v) => set('virtual_type', v)} />
    </div>
  );
}

function BadgePicker({ value, onChange }: { value: DeviceFormData['virtual_type']; onChange: (v: DeviceFormData['virtual_type']) => void }) {
  const { t } = useTranslation();
  const badges: { id: DeviceFormData['virtual_type']; label: string; color: string }[] = [
    { id: null, label: t('editor.none'), color: 'var(--bg-input)' },
    { id: 'vm', label: 'VM', color: 'rgba(217, 70, 239, 0.2)' },
    { id: 'docker', label: 'Docker', color: 'rgba(147, 51, 234, 0.2)' }
  ];
  return (
    <div className="form-group">
      <label>{t('editor.badge', 'Special Marker (Badge)')}</label>
      <div style={{ display: 'flex', gap: '6px' }}>
        {badges.map(type => {
          const selected = value === type.id;
          return (
            <button
              key={String(type.id)}
              type="button"
              onClick={() => onChange(type.id)}
              style={{
                flex: 1,
                padding: '8px 4px',
                background: selected ? type.color : 'rgba(255,255,255,0.03)',
                border: `1px solid ${selected ? 'var(--accent-primary)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: '8px',
                color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              {type.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface RoleDef {
  key: 'is_wlan' | 'is_ap' | 'is_host';
  icon: LucideIcon;
  color: string;
  tint: string;
  label: string;
  desc: string;
}

const ROLE_TOGGLES: RoleDef[] = [
  { key: 'is_wlan', icon: Wifi, color: '#38bdf8', tint: 'rgba(56, 189, 248, 0.1)', label: 'editor.wlan_client', desc: 'editor.wlan_client_desc' },
  { key: 'is_ap', icon: Radio, color: '#22d3ee', tint: 'rgba(34, 211, 238, 0.1)', label: 'editor.access_point', desc: 'editor.access_point_desc' },
  { key: 'is_host', icon: Server, color: '#10b981', tint: 'rgba(16, 185, 129, 0.1)', label: 'editor.physical_host', desc: 'editor.physical_host_desc' },
];

function RoleToggle({ role, on, onToggle }: { role: RoleDef; on: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const Icon = role.icon;
  return (
    <div
      onClick={onToggle}
      style={{
        padding: '12px',
        background: on ? role.tint : 'rgba(255,255,255,0.02)',
        border: `1px solid ${on ? role.color : 'rgba(255,255,255,0.05)'}`,
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
        background: on ? role.color : 'rgba(255,255,255,0.05)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <Icon size={16} color={on ? 'white' : '#64748b'} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: on ? '#f8fafc' : '#94a3b8' }}>{t(role.label)}</span>
        <span style={{ fontSize: '0.6rem', color: '#64748b' }}>{t(role.desc)}</span>
      </div>
    </div>
  );
}

function SystemInfo({ device }: { device: Device }) {
  const { t } = useTranslation();
  return (
    <div className="editor-system-info">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700 }}>{t('editor.system_info')}</div>
        <div style={{ fontSize: '0.85rem', display: 'grid', gridTemplateColumns: '80px 1fr', gap: '4px' }}>
          <span style={{ color: 'var(--text-tertiary)' }}>IP:</span> <span>{device.ip}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>MAC:</span> <span style={{ fontFamily: 'monospace' }}>{device.mac || 'N/A'}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 700 }}>{t('editor.network_info')}</div>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {device.hostname || t('editor.no_dns_name')}
          {device.hostname && device.hostname.includes('.') && (
            <div style={{ fontSize: '0.7rem', color: 'var(--accent-primary)', marginTop: 2 }}>
              FQDN: {device.hostname}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
