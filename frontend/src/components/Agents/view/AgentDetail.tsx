import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, Cpu, HardDrive, Lock, MemoryStick as Memory, RefreshCw, RotateCcw, Shield, Terminal, Thermometer } from 'lucide-react';
import { api } from '../../../api/client';
import type { SshKey } from '../../../types';
import type { AgentSummary } from './AgentParts';
import { DetailGraph, GraphPanel } from './Graphs';

interface DiskSample { path: string; percent: number; used_gb: number; total_gb: number }
interface MetricSnapshot { cpu_percent: number; ram: { percent: number }; temperature?: number | null; timestamp: string; disk?: DiskSample[] }
interface PatchPackage { package: string; current_version: string; new_version: string; repo?: string }

/** Metric history of one agent for the chosen range; the range list comes from the server's retention. */
function useAgentHistory(deviceId: number, active: boolean) {
  const [selectedRange, setSelectedRange] = useState('24h');
  const [availableRanges, setAvailableRanges] = useState<string[]>(['6h', '24h', '7d', '30d']);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [history, setHistory] = useState<MetricSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    api.getAgentMetrics(deviceId, undefined, selectedRange)
      .then((res) => {
        // The client still declares the stored-row shape (AgentSnapshot); the endpoint returns report payloads
        setHistory(res.snapshots as unknown as MetricSnapshot[]);
        const ranges = res.available_ranges;
        if (ranges) {
          setAvailableRanges(ranges);
          if (!ranges.includes(selectedRange)) setSelectedRange(ranges[ranges.length - 1]);
        }
        if (res.retention_days !== undefined) setRetentionDays(res.retention_days);
      })
      .catch((err) => console.error('Failed to fetch history:', err))
      .finally(() => setLoading(false));
  }, [deviceId, selectedRange, active]);

  return { selectedRange, setSelectedRange, availableRanges, retentionDays, history, loading };
}

type Telemetry = ReturnType<typeof useAgentHistory>;

type SshCreds = {
  ssh_user: string;
  ssh_password?: string;
  ssh_key?: string;
  key_id?: number | null;
  key_passphrase?: string;
  auth_type: 'password' | 'key' | 'stored_key';
  ssh_port: number;
};

// SSH secrets are kept in memory only (never in web storage), so they are gone on reload
const sshCredCache = new Map<number, SshCreds>();

/** SSH access for update checks and runs, optionally remembered in memory until reload. */
function useSshCredentials(deviceId: number) {
  const [sshUser, setSshUser] = useState('root');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [authType, setAuthType] = useState<'password' | 'key' | 'stored_key'>('password');
  const [keyId, setKeyId] = useState<number | null>(null);
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [storedKeys, setStoredKeys] = useState<SshKey[]>([]);
  const [saveCreds, setSaveCreds] = useState(true);
  const [showForm, setShowForm] = useState(true);

  // Load available stored keys from the SSH vault
  useEffect(() => {
    let mounted = true;
    api.getSshKeys()
      .then((keys) => {
        if (!mounted) return;
        setStoredKeys(keys);
        const cached = sshCredCache.get(deviceId);
        if (!cached && keys.length > 0) {
          // If keys exist and no credentials cached, default to stored key
          setAuthType('stored_key');
          setKeyId(keys[0].id);
        }
      })
      .catch((err) => console.error('Failed to load SSH keys:', err));
    return () => { mounted = false; };
  }, [deviceId]);

  // Load remembered credentials; drop plaintext copies older versions left in sessionStorage
  useEffect(() => {
    try {
      sessionStorage.removeItem(`agent_ssh_creds_${deviceId}`);
    } catch { /* storage blocked */ }
    const cached = sshCredCache.get(deviceId);
    if (cached) {
      setSshUser(cached.ssh_user || 'root');
      setSshPassword(cached.ssh_password || '');
      setSshKey(cached.ssh_key || '');
      setKeyId(cached.key_id ?? null);
      setKeyPassphrase(cached.key_passphrase || '');
      setSshPort(cached.ssh_port || 22);
      setAuthType(cached.auth_type || (cached.ssh_key ? 'key' : 'password'));
      setSaveCreds(true);
      setShowForm(false);
    }
  }, [deviceId]);

  /** The request body, remembering (or forgetting) the credentials as the checkbox says. */
  const payload = () => {
    const body = {
      ssh_user: sshUser,
      ssh_password: authType === 'password' ? sshPassword : undefined,
      ssh_key: authType === 'key' ? sshKey : undefined,
      key_id: authType === 'stored_key' ? (keyId ?? undefined) : undefined,
      key_passphrase: authType === 'stored_key' && keyPassphrase ? keyPassphrase : undefined,
      ssh_port: sshPort,
    };
    if (saveCreds) {
      sshCredCache.set(deviceId, {
        ssh_user: sshUser,
        ssh_password: authType === 'password' ? sshPassword : '',
        ssh_key: authType === 'key' ? sshKey : '',
        key_id: authType === 'stored_key' ? keyId : null,
        key_passphrase: authType === 'stored_key' ? keyPassphrase : '',
        auth_type: authType,
        ssh_port: sshPort,
      });
    } else {
      sshCredCache.delete(deviceId);
    }
    return body;
  };

  return {
    sshUser, setSshUser, sshPassword, setSshPassword, sshKey, setSshKey, sshPort,
    authType, setAuthType, keyId, setKeyId, keyPassphrase, setKeyPassphrase, storedKeys,
    saveCreds, setSaveCreds, showForm, setShowForm,
    hasStored: sshCredCache.has(deviceId),
    payload,
  };
}

type Credentials = ReturnType<typeof useSshCredentials>;

/** Package list query and the update run over the patch WebSocket, with its live output. */
function usePatching(deviceId: number, creds: Credentials, onRefresh: () => void) {
  const [querying, setQuerying] = useState(false);
  const [patching, setPatching] = useState(false);
  const [packages, setPackages] = useState<PatchPackage[]>([]);
  const [majorUpgrade, setMajorUpgrade] = useState<string | null>(null);
  const [patchManager, setPatchManager] = useState<string | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const append = (line: string) => setOutput(prev => [...prev, line]);

  const queryUpdates = async () => {
    setQuerying(true);
    setPackages([]);
    setMajorUpgrade(null);
    setPatchManager(null);
    try {
      const res = await api.queryAgentPatches(deviceId, creds.payload());
      const updateError = (res as unknown as Record<string, unknown>).error;
      if (typeof updateError === 'string' && updateError) {
        alert(`Update check failed: ${updateError}`);
      }
      setPackages(res.packages);
      setMajorUpgrade(res.major_upgrade_available);
      setPatchManager(res.patch_manager);
      creds.setShowForm(false);
    } catch (err) {
      alert(`Failed to load updates: ${(err as Error).message || err}`);
    } finally {
      setQuerying(false);
    }
  };

  const openPatchSocket = (patchToken: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsToken = localStorage.getItem('gravitylan_token') || '';
    if (wsToken === 'undefined') wsToken = '';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/agent/patches/${deviceId}/run-ws?patch_token=${patchToken}&token=${wsToken}`);
    ws.onopen = () => append("[Local] WebSocket connection established. Launching updates...\r\n");
    ws.onmessage = (event) => append(event.data);
    ws.onclose = (event) => {
      append(`\r\n[Local] Update process terminated (code: ${event.code}).\r\n`);
      setPatching(false);
      onRefresh();
    };
    ws.onerror = () => {
      append(`\r\n[Local] Connection error.\r\n`);
      setPatching(false);
    };
  };

  const startPatching = async (mode: 'upgrade' | 'security-only') => {
    const actionLabel = mode === 'security-only' ? 'security updates' : 'all updates';
    if (!confirm(`Are you sure you want to run ${actionLabel} on this device?`)) return;

    setPatching(true);
    setOutput(["[Local] Requesting update token...\r\n"]);
    try {
      const res = await api.prepareAgentPatch(deviceId, { ...creds.payload(), mode });
      append("[Local] Token received. Connecting to WebSocket...\r\n");
      openPatchSocket(res.patch_token);
    } catch (err) {
      append(`\r\n[Local] Error: ${(err as Error).message || err}\r\n`);
      setPatching(false);
    }
  };

  return {
    querying, patching, packages, majorUpgrade, patchManager, output,
    queryUpdates, startPatching, clearOutput: () => setOutput([]),
  };
}

type Patching = ReturnType<typeof usePatching>;

/**
 * Telemetry and updates of one agent. All state lives here, so the chosen range,
 * the package list and the output of a running update survive switching tabs.
 */
export function AgentDetailView({ deviceId, agent, onRefresh }: { deviceId: number; agent: AgentSummary; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'telemetry' | 'patching'>('telemetry');
  const telemetry = useAgentHistory(deviceId, activeTab === 'telemetry');
  const creds = useSshCredentials(deviceId);
  const patch = usePatching(deviceId, creds, onRefresh);
  const tabs = [
    { id: 'telemetry' as const, label: t('agent_detail.tab_telemetry') },
    { id: 'patching' as const, label: t('agent_detail.tab_patching') },
  ];

  return (
    <div className="agent-detail">
      <div className="inspector-tabs agent-detail__tabs" role="tablist" aria-label={t('agent_detail.tabs_label')}>
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={`inspector-tab${activeTab === id ? ' active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            {label}
            {id === 'patching' && agent.patch_available > 0 && (
              <span className={`agent-detail__count${agent.patch_security > 0 ? ' is-security' : ''}`}>{agent.patch_available}</span>
            )}
            {id === 'patching' && agent.reboot_required && <span className="agent-detail__dot" title={t('agent_detail.reboot_badge')} />}
          </button>
        ))}
      </div>

      {activeTab === 'telemetry'
        ? <TelemetryTab telemetry={telemetry} />
        : <PatchingTab deviceId={deviceId} agent={agent} creds={creds} patch={patch} />}
    </div>
  );
}

function TelemetryTab({ telemetry }: { telemetry: Telemetry }) {
  const { t } = useTranslation();
  const { selectedRange, setSelectedRange, availableRanges, retentionDays, history, loading } = telemetry;

  if (loading) {
    return (
      <p className="agent-detail__loading" role="status">
        <RefreshCw size={16} className="spinning" aria-hidden="true" /> {t('agent_detail.loading_history')}
      </p>
    );
  }

  const series = (pick: (h: MetricSnapshot) => number) => history.map(h => ({ value: pick(h), timestamp: h.timestamp }));
  const disks = history[history.length - 1]?.disk;

  return (
    <div className="agent-detail__section">
      <div className="agent-detail__panel agent-detail__panel-row">
        <div>
          <h4 className="agent-detail__title">{t('agent_detail.timeframe_title')}</h4>
          <p className="field-hint">
            {t('agent_detail.timeframe_desc')}
            {retentionDays !== null && ` · ${t('agent_detail.retention', { days: retentionDays })}`}
          </p>
        </div>
        <div className="segmented" role="group" aria-label={t('agent_detail.timeframe_title')}>
          {availableRanges.map((r) => (
            <button key={r} type="button" className="segmented__option" aria-pressed={selectedRange === r} onClick={() => setSelectedRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="agent-detail__graphs">
        <GraphPanel icon={<Cpu size={16} />} title={t('agent_detail.cpu_title')} desc={t('agent_detail.cpu_desc', { range: selectedRange })}>
          <DetailGraph data={series(h => h.cpu_percent)} color="#3DB8F5" label="CPU" suffix="%" />
        </GraphPanel>
        <GraphPanel icon={<Memory size={16} />} title={t('agent_detail.ram_title')} desc={t('agent_detail.ram_desc', { range: selectedRange })}>
          <DetailGraph data={series(h => h.ram.percent)} color="#4FB3A6" label="RAM" suffix="%" />
        </GraphPanel>
        <GraphPanel icon={<Thermometer size={16} />} title={t('agent_detail.temp_title')} desc={t('agent_detail.temp_desc', { range: selectedRange })}>
          <DetailGraph data={series(h => h.temperature || 0)} color="#C4A2F0" label="TEMP" suffix="°C" max={100} />
        </GraphPanel>
      </div>

      <section className="agent-detail__panel">
        <h4 className="agent-detail__title"><HardDrive size={16} aria-hidden="true" /> {t('agent_detail.storage_title')}</h4>
        <div className="agent-detail__disks">
          {disks?.map((disk) => <DiskUsage key={disk.path} disk={disk} />)}
          {!disks?.length && <p className="settings-empty">{t('agent_detail.no_disks')}</p>}
        </div>
      </section>
    </div>
  );
}

function DiskUsage({ disk }: { disk: DiskSample }) {
  const { t } = useTranslation();
  const tone = disk.percent > 90 ? ' is-danger' : disk.percent > 75 ? ' is-warn' : '';
  return (
    <div className="agent-disk">
      <div className="agent-disk__head">
        <span className="agent-disk__path" title={disk.path}>{disk.path}</span>
        <span className={`agent-disk__pct${tone}`}>{disk.percent.toFixed(0)} %</span>
      </div>
      <span className="agent-meter__track">
        <span className="agent-meter__fill" style={{ width: `${Math.min(100, disk.percent)}%` }} />
      </span>
      <span className="agent-disk__meta">
        {t('agent_detail.disk_used', { used: disk.used_gb.toFixed(1), total: disk.total_gb.toFixed(1) })}
      </span>
    </div>
  );
}

function PatchingTab({ deviceId, agent, creds, patch }: { deviceId: number; agent: AgentSummary; creds: Credentials; patch: Patching }) {
  const { t } = useTranslation();
  // A fresh update check wins over the (possibly older) agent report
  const patchManagerName = patch.patchManager ?? agent.patch_manager;
  const majorUpgradeTarget = patch.majorUpgrade ?? agent.major_upgrade_available;

  if (!patchManagerName) {
    return (
      <div className="agent-detail__section">
        <div className="rack-state rack-state--empty agent-detail__unsupported">
          <span className="setup-features__icon" aria-hidden="true"><Shield size={18} /></span>
          <h2>{t('agent_detail.unsupported_title')}</h2>
          <p>{t('agent_detail.unsupported_desc')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-detail__section">
      {agent.reboot_required && (
        <div className="callout callout--danger">
          <RotateCcw size={16} className="callout__icon" aria-hidden="true" />
          <p className="callout__body">{t('agent_detail.reboot_required')}</p>
        </div>
      )}
      {majorUpgradeTarget && (
        <div className="callout callout--info">
          <ArrowUpCircle size={16} className="callout__icon" aria-hidden="true" />
          <p className="callout__body">{t('agent_detail.major_upgrade', { target: majorUpgradeTarget })}</p>
        </div>
      )}

      {!patch.patching && (creds.showForm
        ? <SshCredentialsForm deviceId={deviceId} creds={creds} querying={patch.querying} onQuery={patch.queryUpdates} />
        : (
          <div className="agent-detail__panel agent-detail__panel-row">
            <span className="field-hint">{t('agent_detail.ssh_configured', { user: creds.sshUser, port: creds.sshPort })}</span>
            <button type="button" className="manual-command__renew" onClick={() => creds.setShowForm(true)}>
              {t('agent_detail.change_credentials')}
            </button>
          </div>
        ))}

      {!patch.patching && <UpdatesPanel agent={agent} patch={patch} />}

      {(patch.output.length > 0 || patch.patching) && <LiveOutput lines={patch.output} running={patch.patching} onClear={patch.clearOutput} />}
    </div>
  );
}

function SshCredentialsForm({ deviceId, creds, querying, onQuery }: { deviceId: number; creds: Credentials; querying: boolean; onQuery: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="agent-detail__panel">
      <div className="agent-detail__panel-row">
        <h4 className="agent-detail__title"><Lock size={14} aria-hidden="true" /> {t('agent_detail.ssh_title')}</h4>
        {creds.hasStored && (
          <button type="button" className="manual-command__renew" onClick={() => creds.setShowForm(false)}>
            {t('agent_detail.hide')}
          </button>
        )}
      </div>
      <div className="agent-detail__creds">
        <div className="settings-field">
          <label className="form-label" htmlFor={`ssh-user-${deviceId}`}>{t('agent_detail.username')}</label>
          <input id={`ssh-user-${deviceId}`} type="text" className="input" value={creds.sshUser} onChange={e => creds.setSshUser(e.target.value)} autoComplete="username" />
        </div>
        <div className="settings-field">
          <label className="form-label" htmlFor={`ssh-auth-${deviceId}`}>{t('agent_detail.auth_method')}</label>
          <select id={`ssh-auth-${deviceId}`} className="input" value={creds.authType} onChange={e => creds.setAuthType(e.target.value as 'password' | 'key' | 'stored_key')}>
            <option value="password">{t('agent_detail.auth_password')}</option>
            {creds.storedKeys.length > 0 && (
              <option value="stored_key">{t('agent_detail.auth_stored_key')}</option>
            )}
            <option value="key">{t('agent_detail.auth_key')}</option>
          </select>
        </div>
        <div className="settings-field agent-detail__secret">
          {creds.authType === 'password' && (
            <>
              <label className="form-label" htmlFor={`ssh-pass-${deviceId}`}>{t('agent_detail.auth_password')}</label>
              <input
                id={`ssh-pass-${deviceId}`} type="password" className="input" placeholder={t('agent_detail.password_placeholder')}
                value={creds.sshPassword} onChange={e => creds.setSshPassword(e.target.value)} autoComplete="current-password"
              />
            </>
          )}
          {creds.authType === 'stored_key' && (
            <>
              <label className="form-label" htmlFor={`ssh-stored-key-${deviceId}`}>{t('agent_detail.select_key')}</label>
              <select
                id={`ssh-stored-key-${deviceId}`}
                className="input"
                value={creds.keyId ?? ''}
                onChange={e => creds.setKeyId(Number(e.target.value) || null)}
              >
                <option value="">{t('agent_detail.choose_key')}</option>
                {creds.storedKeys.map(k => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.key_type}) – {k.fingerprint.slice(0, 16)}...
                  </option>
                ))}
              </select>
              {creds.storedKeys.find(k => k.id === creds.keyId)?.has_passphrase && (
                <input
                  type="password"
                  className="input"
                  style={{ marginTop: 8 }}
                  placeholder={t('ssh.keys.passphrase')}
                  value={creds.keyPassphrase}
                  onChange={e => creds.setKeyPassphrase(e.target.value)}
                  autoComplete="off"
                />
              )}
            </>
          )}
          {creds.authType === 'key' && (
            <>
              <label className="form-label" htmlFor={`ssh-key-${deviceId}`}>{t('agent_detail.auth_key')}</label>
              <textarea
                id={`ssh-key-${deviceId}`} className="input input--mono" rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                value={creds.sshKey} onChange={e => creds.setSshKey(e.target.value)}
              />
            </>
          )}
        </div>
      </div>
      <div className="agent-detail__panel-row">
        <label className="agent-detail__check">
          <input type="checkbox" checked={creds.saveCreds} onChange={e => creds.setSaveCreds(e.target.checked)} />
          {t('agent_detail.remember')}
        </label>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onQuery} disabled={querying}>
          {querying
            ? <><RefreshCw size={14} className="spinning" aria-hidden="true" /> {t('agent_detail.querying')}</>
            : t('agent_detail.query_list')}
        </button>
      </div>
    </section>
  );
}

function UpdatesPanel({ agent, patch }: { agent: AgentSummary; patch: Patching }) {
  const { t } = useTranslation();
  const { packages, querying, patching } = patch;
  return (
    <section className="agent-detail__panel">
      <div className="agent-detail__panel-row">
        <div>
          <h4 className="agent-detail__title">{t('agent_detail.upgrades_title')}</h4>
          <p className="field-hint">{t('agent_detail.upgrades_count', { count: agent.patch_available, security: agent.patch_security })}</p>
        </div>
        <div className="agent-detail__actions">
          {packages.length === 0 && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={patch.queryUpdates} disabled={querying}>
              {querying && <RefreshCw size={14} className="spinning" aria-hidden="true" />}
              {t('agent_detail.query_details')}
            </button>
          )}
          {agent.patch_security > 0 && (
            <button type="button" className="btn btn-danger btn-sm" onClick={() => patch.startPatching('security-only')} disabled={patching || querying}>
              {t('agent_detail.security_only')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => patch.startPatching('upgrade')}
            disabled={patching || querying || agent.patch_available === 0}
          >
            {t('agent_detail.upgrade_all')}
          </button>
        </div>
      </div>

      {packages.length > 0
        ? <PackagesTable packages={packages} />
        : agent.patch_available > 0 && !querying && <p className="field-hint">{t('agent_detail.details_not_loaded')}</p>}
    </section>
  );
}

function PackagesTable({ packages }: { packages: PatchPackage[] }) {
  const { t } = useTranslation();
  return (
    <div className="agent-packages">
      <table>
        <thead>
          <tr>
            <th scope="col">{t('agent_detail.col_package')}</th>
            <th scope="col">{t('agent_detail.col_installed')}</th>
            <th scope="col">{t('agent_detail.col_candidate')}</th>
            <th scope="col">{t('agent_detail.col_repo')}</th>
          </tr>
        </thead>
        <tbody>
          {packages.map((pkg, i) => (
            <tr key={`${pkg.package}-${i}`}>
              <td className="is-name">{pkg.package}</td>
              <td>{pkg.current_version}</td>
              <td className="is-new">{pkg.new_version}</td>
              <td>{pkg.repo || t('common.unknown')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveOutput({ lines, running, onClear }: { lines: string[]; running: boolean; onClear: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  // Keep the newest output in view
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  return (
    <section className="agent-detail__panel">
      <h4 className="agent-detail__title"><Terminal size={14} aria-hidden="true" /> {t('agent_detail.live_output')}</h4>
      <div ref={ref} className="agent-terminal" role="log" aria-live="polite">
        {lines.map((chunk, idx) => <span key={idx}>{chunk}</span>)}
      </div>
      {!running && lines.length > 0 && (
        <div className="agent-detail__panel-row agent-detail__panel-row--end">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClear}>
            {t('agent_detail.clear_output')}
          </button>
        </div>
      )}
    </section>
  );
}
