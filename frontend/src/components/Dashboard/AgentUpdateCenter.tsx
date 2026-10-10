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

export function AgentUpdateCenter({ devices, onComplete, onClose }: AgentUpdateCenterProps) {
  const { t } = useTranslation();
  // Filter only devices that need update
  const devicesToUpdate = devices.filter(d =>
    d.has_agent && isAgentOutdated(d.agent_info?.agent_version, d.agent_info?.latest_version)
  );

  const [sshUser, setSshUser] = useState('root');
  const [sshPassword, setSshPassword] = useState('');
  const [statuses, setStatuses] = useState<Record<number, UpdateStatus>>({});
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  // Devices whose manual update command is shown (fetching it creates a single-use code)
  const [manualOpen, setManualOpen] = useState<Set<number>>(new Set());

  const toggleManual = (id: number) => {
    setManualOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleUpdate = async (device: Device) => {
    const user = sshUser;
    const pass = sshPassword;

    if (!user || !pass) {
      setStatuses(prev => ({
        ...prev,
        [device.id]: { deviceId: device.id, status: 'failed', message: t('agent.credentials_missing', 'Zugangsdaten fehlen') }
      }));
      return;
    }

    setStatuses(prev => ({
      ...prev,
      [device.id]: { deviceId: device.id, status: 'running' }
    }));

    try {
      const res = await api.deployAgent(device.id, {
        ssh_user: user,
        ssh_password: pass,
        ssh_port: 22
      });

      if (res.status === 'success') {
        setStatuses(prev => ({
          ...prev,
          [device.id]: { deviceId: device.id, status: 'success', message: res.message }
        }));
      } else {
        setStatuses(prev => ({
          ...prev,
          [device.id]: { deviceId: device.id, status: 'failed', message: res.message }
        }));
      }
    } catch (err: any) {
      setStatuses(prev => ({
        ...prev,
        [device.id]: { deviceId: device.id, status: 'failed', message: err.message || t('agent.connection_error', 'Verbindungsfehler') }
      }));
    }
  };

  const handleUpdateAll = async () => {
    setIsGlobalLoading(true);
    // Sequential update to avoid overwhelming the server or causing SSH locks
    for (const device of devicesToUpdate) {
      if (statuses[device.id]?.status !== 'success') {
        await handleUpdate(device);
      }
    }
    setIsGlobalLoading(false);
    onComplete();
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 1000 }}>
      <div className="modal-content update-center" role="dialog" aria-modal="true" aria-labelledby="update-center-title">
        <div className="modal-header">
          <h2 id="update-center-title">
            <RefreshCw size={18} className={isGlobalLoading ? 'spinning' : ''} aria-hidden="true" />
            {t('agent.update_center_title', 'Agent Update Center')}
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          {/* Credentials used for all SSH updates below */}
          <section className="update-center__creds" aria-labelledby="update-center-creds">
            <h3 id="update-center-creds"><Shield size={14} aria-hidden="true" /> {t('agent.global_credentials')}</h3>
            <div className="update-center__creds-grid">
              <div className="settings-field">
                <label className="form-label" htmlFor="uc-ssh-user">{t('agent.ssh_user')}</label>
                <input
                  id="uc-ssh-user"
                  type="text"
                  className="input"
                  value={sshUser}
                  onChange={e => setSshUser(e.target.value)}
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
                  value={sshPassword}
                  onChange={e => setSshPassword(e.target.value)}
                  placeholder={t('agent.password_placeholder')}
                  autoComplete="current-password"
                />
              </div>
            </div>
          </section>

          {devicesToUpdate.length === 0 ? (
            <p className="settings-empty update-center__empty">{t('agent.all_up_to_date')}</p>
          ) : (
            <ul className="update-center__list">
              {devicesToUpdate.map(device => {
                const status = statuses[device.id] || { status: 'idle' };
                const isManualOpen = manualOpen.has(device.id);
                return (
                  <li key={device.id} className="update-row">
                    <div className="update-row__main">
                      <div className="update-row__info">
                        <div className="update-row__name">{device.display_name || device.ip}</div>
                        <div className="update-row__meta">
                          {device.ip} · <span className="update-row__from">v{device.agent_info?.agent_version}</span>
                          {' → '}<span className="update-row__to">v{device.agent_info?.latest_version}</span>
                        </div>
                      </div>

                      <div className={`update-row__status is-${status.status}`} role="status">
                        {status.status === 'idle' && t('common.ready', 'Ready')}
                        {status.status === 'running' && <><RefreshCw size={12} className="spinning" aria-hidden="true" /> {t('agent.installing')}</>}
                        {status.status === 'success' && <><CheckCircle2 size={12} aria-hidden="true" /> {t('common.done', 'Done')}</>}
                        {status.status === 'failed' && <><AlertCircle size={12} aria-hidden="true" /> {t('common.error')}</>}
                      </div>

                      <div className="update-row__actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => toggleManual(device.id)}
                          aria-expanded={isManualOpen}
                          aria-controls={`manual-update-${device.id}`}
                        >
                          <Terminal size={14} aria-hidden="true" /> {t('agent.manual_update')}
                          {isManualOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm ${status.status === 'success' ? 'btn-secondary' : 'btn-primary'}`}
                          onClick={() => handleUpdate(device)}
                          disabled={status.status === 'running' || status.status === 'success'}
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
              })}
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
              onClick={handleUpdateAll}
              disabled={isGlobalLoading || devicesToUpdate.length === 0 || !sshPassword}
            >
              <RefreshCw size={14} className={isGlobalLoading ? 'spinning' : ''} aria-hidden="true" />
              {t('agent.update_remaining')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
