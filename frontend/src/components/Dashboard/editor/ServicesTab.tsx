import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ExternalLink, Globe, Lock, Monitor, Terminal, Trash2, type LucideIcon } from 'lucide-react';
import type { Device, Service } from '../../../types';
import { api } from '../../../api/client';
import { useToast } from '../../../context/ToastContext';
import { errorMessage } from './deviceForm';

const PROTOCOL_ICON_MAP: Record<string, LucideIcon> = {
  'ssh': Terminal,
  'http': Globe,
  'https': Lock,
  'rdp': Monitor,
  'tcp': Activity,
};

interface ServicesTabProps {
  device: Device;
  setDevice: Dispatch<SetStateAction<Device>>;
  onSave: () => void;
  isScanning: boolean;
  onScan: () => void;
}

export function ServicesTab({ device, setDevice, onSave, isScanning, onScan }: ServicesTabProps) {
  const { t } = useTranslation();

  const reload = async () => {
    setDevice(await api.getDevice(device.id));
    onSave();
  };

  const addService = async () => {
    const name = prompt('Service Name?', 'Web Interface');
    const port = parseInt(prompt('Port?', '80') || '0');
    if (name && port > 0) {
      await api.addService(device.id, { name, port, protocol: 'http' });
      await reload();
    }
  };

  /** Local edit while typing; saved on blur or with the device. */
  const editLocally = (id: number, patch: Partial<Service>) => setDevice(prev => ({
    ...prev,
    services: prev.services.map(s => s.id === id ? { ...s, ...patch, is_auto_detected: false } : s)
  }));

  const services = [...device.services].sort((a, b) => a.port - b.port);

  return (
    <div className="services-tab" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{t('editor.active_services')}</h4>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.75rem', padding: '4px 10px', color: 'var(--accent-primary)', borderColor: 'rgba(56, 189, 248, 0.3)' }}
            onClick={onScan}
            disabled={isScanning}
          >
            <Activity size={14} className={isScanning ? 'spinning' : ''} />
            {isScanning ? t('dashboard.scanning') : t('network.nmap_scan')}
          </button>
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.75rem', padding: '4px 10px' }}
            onClick={addService}
          >
            + {t('editor.add_service')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto', paddingRight: '4px' }}>
        {services.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
            {t('editor.no_services')}
          </div>
        ) : (
          services.map(svc => (
            <ServiceRow key={svc.id} svc={svc} onEdit={editLocally} onReload={reload} onSave={onSave} />
          ))
        )}
      </div>

      <div style={{ marginTop: 'auto', padding: '12px', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '8px', fontSize: '0.8rem', border: '1px dashed rgba(56, 189, 248, 0.3)' }}>
        <p style={{ margin: 0, color: '#38bdf8' }}>
          <strong>{t('common.warning')}:</strong> {t('editor.service_note')}
        </p>
      </div>
    </div>
  );
}

interface ServiceRowProps {
  svc: Service;
  onEdit: (id: number, patch: Partial<Service>) => void;
  onReload: () => Promise<void>;
  onSave: () => void;
}

function ServiceRow({ svc, onEdit, onReload, onSave }: ServiceRowProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const ServiceIcon = PROTOCOL_ICON_MAP[svc.protocol.toLowerCase()] || ExternalLink;

  const changeProtocol = async (newProto: string) => {
    try {
      await api.updateService(svc.id, { protocol: newProto });
      await onReload();
      showToast('success', t('notifications.info_updated', 'Info updated'), `${svc.name} is now configured as ${newProto.toUpperCase()}.`);
    } catch (err) {
      showToast('error', t('common.error', 'Error'), `Could not save protocol: ${errorMessage(err) || 'Unknown error'}`);
    }
  };

  const savePort = async (value: string) => {
    const newPort = parseInt(value);
    if (!isNaN(newPort)) {
      await api.updateService(svc.id, { port: newPort });
      onSave();
    }
  };

  const remove = async () => {
    if (confirm(t('editor.delete_service_confirm'))) {
      await api.deleteService(svc.id);
      await onReload();
    }
  };

  return (
    <div style={{
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
            onChange={(e) => onEdit(svc.id, { name: e.target.value })}
            onBlur={async (e) => {
              await api.updateService(svc.id, { name: e.target.value });
              onSave();
            }}
          />
          {!svc.is_auto_detected && (
            <span style={{ fontSize: '0.6rem', background: 'var(--accent-primary)', color: 'black', padding: '1px 4px', borderRadius: '3px', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t('editor.manual')}</span>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          <span style={{ display: 'flex', gap: 4 }}>
            PROT:
            <select
              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '0.75rem', padding: 0, cursor: 'pointer' }}
              value={svc.protocol}
              onChange={(e) => changeProtocol(e.target.value)}
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
              onChange={(e) => {
                const newPort = parseInt(e.target.value);
                if (!isNaN(newPort)) onEdit(svc.id, { port: newPort });
              }}
              onBlur={(e) => savePort(e.target.value)}
            />
          </span>
          {(svc.protocol?.toLowerCase() === 'https' || svc.port === 443 || svc.port === 8443 || svc.port === 5001 || svc.ignore_ssl) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }} title={t('health_page.ignore_ssl_hint')}>
              <input
                type="checkbox"
                checked={Boolean(svc.ignore_ssl)}
                onChange={async (e) => {
                  const val = e.target.checked;
                  onEdit(svc.id, { ignore_ssl: val });
                  await api.updateService(svc.id, { ignore_ssl: val });
                  onSave();
                }}
              />
              <span style={{ color: svc.ignore_ssl ? 'var(--text-tertiary)' : 'var(--accent-primary)' }}>
                {t('health_page.ignore_ssl_btn')}
              </span>
            </label>
          )}
        </div>
      </div>
      <button
        className="btn-icon"
        style={{ color: 'var(--text-tertiary)' }}
        onClick={remove}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
