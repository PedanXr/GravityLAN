import { useState } from 'react';
import { api } from '../../api/client';
import type { Device } from '../../types';
import { RefreshCw, Shield, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, X, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ManualInstallCommand } from '../Agents/ManualInstallCommand';
import { isAgentOutdated } from '../../utils/version';

interface AgentUpdateCenterProps {
  devices: Device[];
  onComplete: () => void;
  onClose: () => void;
}

interface UpdateStatus {
  deviceId: number;
  status: 'idle' | 'running' | 'success' | 'failed';
  message?: string;
}

const IDLE = { status: 'idle' } as const;

/** SSH credentials, per-device deploy status and the sequential "update all" run. */
function useAgentUpdates(devicesToUpdate: Device[], onComplete: () => void) {
  const { t } = useTranslation();
  const [sshUser, setSshUser] = useState('root');
  const [sshPassword, setSshPassword] = useState('');
  const [statuses, setStatuses] = useState<Record<number, UpdateStatus>>({});
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);

  const setStatus = (deviceId: number, status: UpdateStatus['status'], message?: string) =>
    setStatuses((prev) => ({ ...prev, [deviceId]: { deviceId, status, message } }));

  const update = async (device: Device) => {
    if (!sshUser || !sshPassword) {
      setStatus(device.id, 'failed', t('agent.credentials_missing', 'Zugangsdaten fehlen'));
      return;
    }
    setStatus(device.id, 'running');
    try {
      const res = await api.deployAgent(device.id, { ssh_user: sshUser, ssh_password: sshPassword, ssh_port: 22 });
      setStatus(device.id, res.status === 'success' ? 'success' : 'failed', res.message);
    } catch (err) {
      setStatus(device.id, 'failed', (err as Error).message || t('agent.connection_error', 'Verbindungsfehler'));
    }
  };

  const updateAll = async () => {
    setIsGlobalLoading(true);
    // Sequential update to avoid overwhelming the server or causing SSH locks
    for (const device of devicesToUpdate) {
      if (statuses[device.id]?.status !== 'success') {
        await update(device);
      }
    }
    setIsGlobalLoading(false);
    onComplete();
  };

  return { sshUser, setSshUser, sshPassword, setSshPassword, statuses, isGlobalLoading, update, updateAll };
}

export function AgentUpdateCenter({ devices, onComplete, onClose }: AgentUpdateCenterProps) {
  const { t } = useTranslation();
  // Filter only devices that need update
  const devicesToUpdate = devices.filter(d =>
    d.has_agent && isAgentOutdated(d.agent_info?.agent_version, d.agent_info?.latest_version)
  );
  const updates = useAgentUpdates(devicesToUpdate, onComplete);

  return (
    <div className="modal-overlay" style={{ zIndex: 1000 }}>
      <div className="modal-content update-center" role="dialog" aria-modal="true" aria-labelledby="update-center-title">
        <div className="modal-header">
          <h2 id="update-center-title">
            <RefreshCw size={18} className={updates.isGlobalLoading ? 'spinning' : ''} aria-hidden="true" />
            {t('agent.update_center_title', 'Agent Update Center')}
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <CredentialsSection
            user={updates.sshUser}
            password={updates.sshPassword}
            onUser={updates.setSshUser}
            onPassword={updates.setSshPassword}
          />

          {devicesToUpdate.length === 0 ? (
            <p className="settings-empty update-center__empty">{t('agent.all_up_to_date')}</p>
          ) : (
            <ul className="update-center__list">
              {devicesToUpdate.map(device => (
                <UpdateRow
                  key={device.id}
                  device={device}
                  status={updates.statuses[device.id] || IDLE}
                  onUpdate={() => updates.update(device)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="modal-footer update-center__footer">
          <span className="update-center__count">
            {devicesToUpdate.length} {t('agent.updates_available')}
          </span>
          <div className="update-center__footer-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('common.close')}</button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={updates.updateAll}
              disabled={updates.isGlobalLoading || devicesToUpdate.length === 0 || !updates.sshPassword}
            >
              <RefreshCw size={14} className={updates.isGlobalLoading ? 'spinning' : ''} aria-hidden="true" />
              {t('agent.update_remaining')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CredentialsSectionProps {
  user: string;
  password: string;
  onUser: (value: string) => void;
  onPassword: (value: string) => void;
}

/** Credentials used for all SSH updates below. */
function CredentialsSection({ user, password, onUser, onPassword }: CredentialsSectionProps) {
  const { t } = useTranslation();
  return (
    <section className="update-center__creds" aria-labelledby="update-center-creds">
      <h3 id="update-center-creds"><Shield size={14} aria-hidden="true" /> {t('agent.global_credentials')}</h3>
      <div className="update-center__creds-grid">
        <div className="settings-field">
          <label className="form-label" htmlFor="uc-ssh-user">{t('agent.ssh_user')}</label>
          <input
            id="uc-ssh-user"
            type="text"
            className="input"
            value={user}
            onChange={e => onUser(e.target.value)}
            placeholder={t('agent.ssh_user_placeholder', 'z.B. root')}
            autoComplete="username"
          />
        </div>
        <div className="settings-field">
          <label className="form-label" htmlFor="uc-ssh-password">{t('agent.ssh_password')}</label>
          <input
            id="uc-ssh-password"
            type="password"
            className="input"
            value={password}
            onChange={e => onPassword(e.target.value)}
            placeholder={t('agent.password_placeholder')}
            autoComplete="current-password"
          />
        </div>
      </div>
    </section>
  );
}

function StatusLabel({ status }: { status: UpdateStatus['status'] }) {
  const { t } = useTranslation();
  switch (status) {
    case 'running': return <><RefreshCw size={12} className="spinning" aria-hidden="true" /> {t('agent.installing')}</>;
    case 'success': return <><CheckCircle2 size={12} aria-hidden="true" /> {t('common.done', 'Done')}</>;
    case 'failed': return <><AlertCircle size={12} aria-hidden="true" /> {t('common.error')}</>;
    default: return <>{t('common.ready', 'Ready')}</>;
  }
}

interface UpdateRowProps {
  device: Device;
  status: Pick<UpdateStatus, 'status' | 'message'>;
  onUpdate: () => void;
}

function UpdateRow({ device, status, onUpdate }: UpdateRowProps) {
  const { t } = useTranslation();
  // Fetching the manual command creates a single-use code, so it only loads when opened
  const [isManualOpen, setManualOpen] = useState(false);
  const done = status.status === 'success';

  return (
    <li className="update-row">
      <div className="update-row__main">
        <div className="update-row__info">
          <div className="update-row__name">{device.display_name || device.ip}</div>
          <div className="update-row__meta">
            {device.ip} · <span className="update-row__from">v{device.agent_info?.agent_version}</span>
            {' → '}<span className="update-row__to">v{device.agent_info?.latest_version}</span>
          </div>
        </div>

        <div className={`update-row__status is-${status.status}`} role="status">
          <StatusLabel status={status.status} />
        </div>

        <div className="update-row__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setManualOpen((open) => !open)}
            aria-expanded={isManualOpen}
            aria-controls={`manual-update-${device.id}`}
          >
            <Terminal size={14} aria-hidden="true" /> {t('agent.manual_update')}
            {isManualOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${done ? 'btn-secondary' : 'btn-primary'}`}
            onClick={onUpdate}
            disabled={status.status === 'running' || done}
          >
            {status.status === 'failed' ? t('common.retry', 'Retry') : t('common.update', 'Update')}
          </button>
        </div>
      </div>

      {status.status === 'failed' && status.message && (
        <p className="update-row__error">{status.message}</p>
      )}

      {isManualOpen && (
        <div id={`manual-update-${device.id}`} className="update-row__manual">
          <ManualInstallCommand deviceId={device.id} />
        </div>
      )}
    </li>
  );
}
