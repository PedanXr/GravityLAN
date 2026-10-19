import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, HardDrive, KeyRound, Radio, RefreshCw, Save, Settings, Terminal, Thermometer, Trash2, Upload } from 'lucide-react';
import { DeviceMetrics } from '../DeviceMetrics';
import { ManualInstallCommand, ManualUninstallCommand } from '../../Agents/ManualInstallCommand';
import { profileTarget } from '../../Agents/savedLogins';
import { isAgentOutdated } from '../../../utils/version';
import type { AgentPanel, AgentStatus } from './hooks';

export function AgentTab({ deviceId, panel }: { deviceId: number; panel: AgentPanel }) {
  const { agentStatus, setAgentStatus } = panel;
  return (
    <div className="agent-tab-grid">
      {/* Spalte 1: Status & Metriken */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <AgentStatusCard status={agentStatus} />

        {/* Live Metrics (only if active) */}
        {agentStatus?.is_active && (
          <DeviceMetrics
            deviceId={deviceId}
            compact={false}
            onUpdate={(m) => {
              if (agentStatus) {
                setAgentStatus({ ...agentStatus, last_seen: m.timestamp });
              }
            }}
          />
        )}
      </div>

      {/* Spalte 2: Management & Config */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <SshManagementPanel panel={panel} />
        <ManualInstallToggle deviceId={deviceId} panel={panel} />
        {agentStatus?.is_installed && <AgentConfigPanel panel={panel} />}
        <DeployLog lines={panel.deployLog} />
      </div>
    </div>
  );
}

function AgentStatusCard({ status }: { status: AgentStatus | null }) {
  const { t } = useTranslation();
  const label = status?.is_active
    ? t('agent.status_active')
    : status?.is_installed ? `${t('agent.status_active')} (${t('common.offline')})` : t('agent.status_inactive');
  const dot = status?.is_active ? '#10b981' : (status?.is_installed ? '#f59e0b' : '#64748b');
  return (
    <div style={{
      padding: '16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)',
      border: `1px solid ${status?.is_active ? 'rgba(16, 185, 129, 0.3)' : 'var(--border-subtle)'}`
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: dot,
            boxShadow: status?.is_active ? '0 0 8px #10b981' : 'none'
          }} />
          <span style={{ fontWeight: 700 }}>{label}</span>
        </div>
        {status?.agent_version && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isAgentOutdated(status.agent_version, status.latest_version) && (
              <span style={{
                fontSize: '0.65rem', background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b',
                padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(245, 158, 11, 0.3)',
                fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4
              }}>
                <RefreshCw size={10} /> {t('common.next')} Update
              </span>
            )}
            <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>v{status.agent_version}</span>
          </div>
        )}
      </div>
      {status?.last_seen && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', margin: '8px 0 0' }}>
          {t('agent.last_report')}: {new Date(status.last_seen).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function SshManagementPanel({ panel }: { panel: AgentPanel }) {
  const { t } = useTranslation();
  const { sshForm, setSshForm, isDeploying, agentStatus, keyProfiles } = panel;
  const useSaved = sshForm.profile_id !== null;
  const noCredentials = !useSaved && !sshForm.ssh_password && !sshForm.ssh_key;
  const disabled = isDeploying || noCredentials;
  return (
    <section className="agent-detail__panel">
      <h4 className="agent-detail__title"><Terminal size={14} aria-hidden="true" /> {t('agent.ssh_management')}</h4>
      {keyProfiles.length > 0 && (
        <div className="segmented" role="group" aria-label={t('agent.login_method')}>
          <button type="button" className="segmented__option segmented__option--icon" aria-pressed={useSaved}
            onClick={() => setSshForm(prev => ({ ...prev, profile_id: prev.profile_id ?? keyProfiles[0].id }))}>
            <KeyRound size={14} aria-hidden="true" /> {t('agent.login_saved')}
          </button>
          <button type="button" className="segmented__option" aria-pressed={!useSaved}
            onClick={() => setSshForm(prev => ({ ...prev, profile_id: null, sudo_password: '' }))}>
            {t('agent.login_password')}
          </button>
        </div>
      )}
      {useSaved ? <SavedLoginFields panel={panel} /> : <PasswordLoginFields panel={panel} />}
      <div className="agent-detail__actions">
        {!agentStatus?.is_installed ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={panel.deploy} disabled={disabled}>
            <Upload size={14} aria-hidden="true" /> {isDeploying ? t('common.loading') : t('agent.install_via_ssh')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={panel.deploy} disabled={disabled}>
              <RefreshCw size={14} className={isDeploying ? 'spinning' : ''} aria-hidden="true" /> {isDeploying ? t('common.loading') : t('agent.update_agent')}
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={panel.uninstall} disabled={disabled}>
              <Trash2 size={14} aria-hidden="true" /> {t('agent.uninstall')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function PasswordLoginFields({ panel }: { panel: AgentPanel }) {
  const { t } = useTranslation();
  const { sshForm, setSshForm } = panel;
  return (
    <div className="editor-ssh__grid">
      <div className="settings-field">
        <label className="form-label" htmlFor="editor-ssh-user">{t('agent.ssh_user')}</label>
        <input id="editor-ssh-user" className="input" autoComplete="username" value={sshForm.ssh_user} onChange={e => setSshForm(prev => ({ ...prev, ssh_user: e.target.value }))} />
      </div>
      <div className="settings-field">
        <label className="form-label" htmlFor="editor-ssh-port">{t('agent.ssh_port')}</label>
        <input id="editor-ssh-port" className="input" type="number" value={sshForm.ssh_port} onChange={e => setSshForm(prev => ({ ...prev, ssh_port: parseInt(e.target.value) || 22 }))} />
      </div>
      <div className="settings-field editor-ssh__wide">
        <label className="form-label" htmlFor="editor-ssh-password">{t('agent.ssh_password')}</label>
        <input id="editor-ssh-password" className="input" type="password" autoComplete="current-password" value={sshForm.ssh_password} onChange={e => setSshForm(prev => ({ ...prev, ssh_password: e.target.value }))} placeholder={t('agent.password_placeholder')} />
      </div>
    </div>
  );
}

/** A saved key connection of the device; the key is only decrypted on the server. */
function SavedLoginFields({ panel }: { panel: AgentPanel }) {
  const { t } = useTranslation();
  const { sshForm, setSshForm, keyProfiles } = panel;
  return (
    <div className="editor-ssh__grid">
      <div className="settings-field editor-ssh__wide">
        <label className="form-label" htmlFor="editor-ssh-profile">{t('agent.saved_connection')}</label>
        <select id="editor-ssh-profile" className="input" value={sshForm.profile_id ?? ''}
          onChange={e => setSshForm(prev => ({ ...prev, profile_id: Number(e.target.value) }))}>
          {keyProfiles.map(p => (
            <option key={p.id} value={p.id}>{p.name} – {profileTarget(p)}{p.key_name ? ` (${p.key_name})` : ''}</option>
          ))}
        </select>
        <p className="field-hint">{t('agent.saved_connection_hint')}</p>
      </div>
      <div className="settings-field editor-ssh__wide">
        <label className="form-label" htmlFor="editor-ssh-sudo">{t('agent.sudo_password')}</label>
        <input id="editor-ssh-sudo" className="input" type="password" autoComplete="off" value={sshForm.sudo_password}
          onChange={e => setSshForm(prev => ({ ...prev, sudo_password: e.target.value }))} />
        <p className="field-hint">{t('agent.sudo_password_hint')}</p>
      </div>
    </div>
  );
}

function ManualInstallToggle({ deviceId, panel }: { deviceId: number; panel: AgentPanel }) {
  const { t } = useTranslation();
  const { showManual, setShowManual } = panel;
  return (
    <div style={{ marginTop: 'var(--space-sm)' }}>
      <button
        onClick={() => setShowManual(!showManual)}
        style={{
          background: 'none', border: 'none', color: 'var(--text-tertiary)',
          fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 6,
          cursor: 'pointer', padding: '4px 0'
        }}
      >
        {showManual ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('agent.manual_install_options', 'Show manual installation/uninstallation options')}
      </button>

      {showManual && (
        <div className="editor-manual">
          <section className="agent-detail__panel">
            <h4 className="agent-detail__title"><ExternalLink size={14} aria-hidden="true" /> {t('agent.manual_install')}</h4>
            <ManualInstallCommand deviceId={deviceId} />
          </section>
          <section className="agent-detail__panel">
            <h4 className="agent-detail__title"><Trash2 size={14} aria-hidden="true" /> {t('agent.manual_uninstall')}</h4>
            <ManualUninstallCommand deviceId={deviceId} />
          </section>
        </div>
      )}
    </div>
  );
}

function AgentConfigPanel({ panel }: { panel: AgentPanel }) {
  const { t } = useTranslation();
  const { agentConfig, setAgentConfig, newDiskPath, setNewDiskPath } = panel;
  if (!agentConfig) return null;
  const diskPaths = agentConfig.disk_paths || [];

  const addDiskPath = () => {
    if (newDiskPath && !diskPaths.includes(newDiskPath)) {
      setAgentConfig(prev => prev ? { ...prev, disk_paths: [...(prev.disk_paths || []), newDiskPath] } : prev);
      setNewDiskPath('');
    }
  };

  return (
    <div style={{ padding: '16px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
      <h4 style={{ margin: '0 0 12px', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Settings size={16} /> {t('agent.configuration')}
      </h4>
      <div className="form-group">
        <label style={{ fontSize: '0.7rem' }}>{t('agent.report_interval')}</label>
        <input className="input" type="number" value={agentConfig.interval} onChange={e => setAgentConfig(prev => prev ? { ...prev, interval: parseInt(e.target.value) || 30 } : prev)} />
      </div>
      <div className="form-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Thermometer size={12} /> {t('agent.temp_monitoring')}
        </label>
        <button
          type="button"
          className={`btn ${agentConfig.enable_temp ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '4px 12px', fontSize: '0.75rem' }}
          onClick={() => setAgentConfig(prev => prev ? { ...prev, enable_temp: !prev.enable_temp } : prev)}
        >
          {agentConfig.enable_temp ? t('common.activated') : t('common.deactivated')}
        </button>
      </div>
      <div className="form-group" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ paddingRight: 8 }}>
          <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Radio size={12} /> {t('agent.scanner_relay', 'L2 Subnetz-Scanner (Probe)')}
          </label>
          <p style={{ margin: 0, fontSize: '0.65rem', color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
            {t('agent.scanner_relay_hint', 'Liest ARP-Nachbarn im lokalen Subnetz aus und meldet MAC-Adressen an GravityLAN')}
          </p>
        </div>
        <button
          type="button"
          className={`btn ${agentConfig.enable_scanner_relay ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '4px 12px', fontSize: '0.75rem', flexShrink: 0 }}
          onClick={() => setAgentConfig(prev => prev ? { ...prev, enable_scanner_relay: !prev.enable_scanner_relay } : prev)}
        >
          {agentConfig.enable_scanner_relay ? t('common.activated') : t('common.deactivated')}
        </button>
      </div>
      <div className="form-group">
        <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 6 }}>
          <HardDrive size={12} /> {t('agent.disk_paths')}
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {diskPaths.map((p, i) => (
            <span key={i} style={{
              background: 'var(--bg-elevated)', padding: '3px 8px', borderRadius: 4,
              fontSize: '0.75rem', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 4
            }}>
              {p}
              <button style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: 0, fontSize: '0.8rem' }}
                onClick={() => setAgentConfig(prev => prev ? { ...prev, disk_paths: (prev.disk_paths || []).filter((_, idx) => idx !== i) } : prev)}
              >×</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="input" style={{ flex: 1 }} placeholder="/mnt/data" value={newDiskPath} onChange={e => setNewDiskPath(e.target.value)} />
          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={addDiskPath}>+</button>
        </div>
      </div>
      <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={panel.saveConfig}>
        <Save size={16} /> {t('agent.save_config')}
      </button>
    </div>
  );
}

function DeployLog({ lines }: { lines: string[] }) {
  const { t } = useTranslation();
  if (lines.length === 0) return null;
  return (
    <div style={{ marginTop: 'var(--space-md)' }}>
      <h4 style={{ margin: '0 0 8px', fontSize: '0.8rem', color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Terminal size={14} /> {t('agent.deployment_logs')}
      </h4>
      <div style={{
        background: '#000', padding: '12px', borderRadius: '4px',
        fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: '#10b981',
        maxHeight: '150px', overflowY: 'auto', border: '1px solid var(--border-subtle)'
      }}>
        {lines.map((log, i) => (
          <div key={i} style={{ marginBottom: 4 }}>{log}</div>
        ))}
      </div>
    </div>
  );
}
