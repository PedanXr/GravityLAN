import { useState, useEffect, useRef } from 'react';
import { Sidebar } from '../Sidebar';
import { MobileHeader } from '../MobileHeader';
import { api } from '../../api/client';
import { useTranslation } from 'react-i18next';
import { 
  Server, 
  Database, 
  Cpu, 
  MemoryStick as Memory, 
  RefreshCw,
  Search,
  Activity,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Thermometer,
  HardDrive,
  X,
  LineChart,
  History,
  Lock,
  Terminal,
  Shield,
  ShieldAlert,
  Package,
  RotateCcw,
  ArrowUpCircle
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';

interface AgentSummary {
  device_id: number;
  hostname: string;
  ip: string;
  is_online: boolean;
  has_pending_token?: boolean;
  agent_version: string | null;
  os_pretty?: string | null;
  os_name?: string | null;
  os_version?: string | null;
  last_seen: string | null;
  cpu_usage: number;
  ram_usage: number;
  temp: number | null;
  uptime_pct: number;
  uptime_history: number[];
  metrics_count: number;
  patch_available: number;
  patch_security: number;
  patch_manager: string | null;
  reboot_required: boolean;
  major_upgrade_available: string | null;
}

interface OverviewData {
  agents: AgentSummary[];
  total_agents: number;
  active_agents: number;
  total_data_points: number;
  avg_cpu: number;
  avg_ram: number;
}

export function AgentsView() {
  const { t } = useTranslation();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showGlobalMetrics, setShowGlobalMetrics] = useState(false);

  const loadData = async () => {
    try {
      const res = await api.getAgentsOverview();
      setData(res as any);
    } catch (err) {
      console.error('Failed to load agents overview:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const filteredAgents = data?.agents.filter(a => 
    a.hostname.toLowerCase().includes(search.toLowerCase()) || 
    a.ip.includes(search)
  ) || [];

  return (
    <div className="app-layout">
      <Sidebar active="agents" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      
      <main className="app-main">
        <MobileHeader onMenuClick={() => setIsSidebarOpen(true)} title={t('agents_page.title')} />
        
        <header className="page-header" style={{ marginBottom: 'var(--space-xl)' }}>
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center w-full gap-4">
            <div>
              <h1 className="visually-hidden-mobile" style={{ margin: '0 0 4px', fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.01em' }}>{t('agents_page.title')}</h1>
              <p className="text-slate-400 text-sm">{t('agents_page.subtitle', { count: data?.total_agents || 0 })}</p>
            </div>
            <div className="flex gap-3">
              <button type="button" className="btn btn-secondary" onClick={loadData} disabled={loading}>
                <RefreshCw size={18} className={loading ? 'spinning' : ''} />
                {t('agents_page.sync')}
              </button>
            </div>
          </div>
        </header>

        {/* Global stats (real values only; no decorative trend lines) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            title={t('agents_page.nodes')}
            value={data?.total_agents || 0}
            icon={<Server size={18} />}
            note={t('agents_page.active', { count: data?.active_agents || 0 })}
            noteTone="ok"
          />
          <StatCard
            title={t('agents_page.avg_cpu')}
            value={`${(data?.avg_cpu || 0).toFixed(1)} %`}
            icon={<Cpu size={18} />}
            noteTone={(data?.avg_cpu || 0) >= 80 ? 'warn' : 'muted'}
          />
          <StatCard
            title={t('agents_page.avg_ram')}
            value={`${(data?.avg_ram || 0).toFixed(1)} %`}
            icon={<Memory size={18} />}
          />
          <StatCard
            title={t('agents_page.snapshots')}
            value={(data?.total_data_points || 0).toLocaleString()}
            icon={<Database size={18} />}
            note={t('agents_page.snapshots_note')}
          />
        </div>

        {/* Search and global analytics */}
        <div className="agents-toolbar">
          <div className="agents-toolbar__search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              className="input"
              placeholder={t('agents_page.search_placeholder')}
              aria-label={t('agents_page.search_placeholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => setShowGlobalMetrics(true)}>
            <Activity size={16} aria-hidden="true" /> {t('agents_page.global_analytics')}
          </button>
        </div>

        {/* Agents: one grid row per agent on wide screens, a card on phones */}
        <div className="agent-list">
          <div className="agent-list__head" aria-hidden="true">
            <span>{t('agents_page.col_agent')}</span>
            <span>{t('agents_page.col_connection')}</span>
            <span>{t('agents_page.col_performance')}</span>
            <span>{t('agents_page.col_uptime')}</span>
            <span className="agent-list__head-end">{t('agents_page.col_activity')}</span>
          </div>
          <ul className="agent-list__items">
            {filteredAgents.map((agent) => {
              const isOpen = expandedId === agent.device_id;
              const osLabel = agent.os_pretty
                || (agent.os_name ? `${agent.os_name}${agent.os_version ? ` ${agent.os_version}` : ''}` : null);
              return (
                <li key={agent.device_id} className={`agent-row${isOpen ? ' is-open' : ''}`}>
                  <button
                    type="button"
                    className="agent-row__summary"
                    aria-expanded={isOpen}
                    aria-controls={`agent-detail-${agent.device_id}`}
                    onClick={() => setExpandedId(isOpen ? null : agent.device_id)}
                  >
                    <span className="agent-row__identity">
                      {isOpen
                        ? <ChevronDown size={16} className="agent-row__chevron" aria-hidden="true" />
                        : <ChevronRight size={16} className="agent-row__chevron" aria-hidden="true" />}
                      <span className={`agent-row__icon${agent.is_online ? '' : ' is-offline'}`} aria-hidden="true">
                        <Server size={18} />
                      </span>
                      <span className="agent-row__text">
                        <span className="agent-row__name">{agent.hostname}</span>
                        <span className="agent-row__meta">{agent.ip} · v{agent.agent_version || '0.0.0'}</span>
                        <span className="agent-row__tags">
                          {osLabel && <span className="device-tag agent-row__os" title={osLabel}>{osLabel}</span>}
                          {agent.patch_available > 0 && (
                            <span
                              className={`device-tag ${agent.patch_security > 0 ? 'device-tag--danger' : 'device-tag--warn'}`}
                              title={t('agent_detail.updates_badge', { count: agent.patch_available, security: agent.patch_security })}
                            >
                              {agent.patch_security > 0
                                ? <ShieldAlert size={11} aria-hidden="true" />
                                : <Package size={11} aria-hidden="true" />}
                              {agent.patch_available}
                            </span>
                          )}
                          {agent.reboot_required && (
                            <span className="device-tag device-tag--danger">
                              <RotateCcw size={11} aria-hidden="true" /> {t('agent_detail.reboot_badge')}
                            </span>
                          )}
                          {agent.major_upgrade_available && (
                            <span className="device-tag device-tag--info" title={t('agent_detail.major_upgrade', { target: agent.major_upgrade_available })}>
                              <ArrowUpCircle size={11} aria-hidden="true" /> {agent.major_upgrade_available}
                            </span>
                          )}
                        </span>
                      </span>
                    </span>

                    <span className={`agent-row__status${agent.is_online ? ' is-online' : ' is-offline'}`}>
                      <span className={`status-dot ${agent.is_online ? 'status-dot--online' : 'status-dot--offline'}`} aria-hidden="true" />
                      {agent.is_online ? t('agents_page.connected') : t('agents_page.disconnected')}
                    </span>

                    <span className="agent-row__meters">
                      <AgentMeter label="CPU" value={agent.cpu_usage} />
                      <AgentMeter label="RAM" value={agent.ram_usage} />
                    </span>

                    <span className="agent-row__uptime">
                      <span className={`agent-row__uptime-value ${uptimeTone(agent.uptime_pct)}`}>{agent.uptime_pct.toFixed(1)} %</span>
                      <UptimeStatusGrid data={agent.uptime_history} />
                    </span>

                    <span className="agent-row__seen">
                      <span>{agent.last_seen ? new Date(agent.last_seen).toLocaleTimeString() : t('agent_detail.never')}</span>
                      <span className="agent-row__seen-date">{agent.last_seen ? new Date(agent.last_seen).toLocaleDateString() : '–'}</span>
                    </span>
                  </button>

                  {agent.has_pending_token && (
                    <div className="callout callout--danger agent-row__alert">
                      <ShieldCheck size={16} className="callout__icon" aria-hidden="true" />
                      <p className="callout__body">{t('agent_detail.token_mismatch')}</p>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          if (confirm(t('agent.adopt_confirm', 'Permanently accept this new agent key?'))) {
                            api.adoptAgent(agent.device_id).then(() => {
                              alert(t('agent.adopt_success'));
                              window.location.reload();
                            });
                          }
                        }}
                      >
                        {t('dashboard.adopt')}
                      </button>
                    </div>
                  )}

                  {isOpen && (
                    <div id={`agent-detail-${agent.device_id}`} className="agent-row__detail">
                      <AgentDetailView deviceId={agent.device_id} agent={agent} onRefresh={loadData} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {filteredAgents.length === 0 && !loading && (
            <p className="settings-empty agent-list__empty">{t('agent_detail.no_agents')}</p>
          )}
        </div>

        {/* Global Metrics Overlay */}
        <AnimatePresence>
          {showGlobalMetrics && (
            <GlobalMetricsOverlay onClose={() => setShowGlobalMetrics(false)} />
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

/** CPU/RAM meter; the bar turns amber at 75 % and red at 90 %. */
function AgentMeter({ label, value }: { label: string; value: number }) {
  const tone = value >= 90 ? ' is-danger' : value >= 75 ? ' is-warn' : '';
  return (
    <span className={`agent-meter${tone}`}>
      <span className="agent-meter__label">
        <span>{label}</span>
        <span className="agent-meter__value">{value.toFixed(1)} %</span>
      </span>
      <span className="agent-meter__track">
        <span className="agent-meter__fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </span>
    </span>
  );
}

function uptimeTone(pct: number): string {
  if (pct < 80) return 'is-danger';
  if (pct < 95) return 'is-warn';
  return '';
}

/** Last 24 hours, one bar per hour: up, partly up, down, or no data. The % next to it carries the value. */
function UptimeStatusGrid({ data }: { data: number[] }) {
  const { t } = useTranslation();
  const hours: (number | null)[] = data && data.length > 0 ? data : Array(24).fill(null);
  return (
    <span className="uptime-bars" aria-hidden="true">
      {hours.map((val, i) => {
        const tone = val === null || val < 0 ? '' : val >= 100 ? ' is-up' : val > 0 ? ' is-partial' : ' is-down';
        return (
          <span
            key={i}
            className={`uptime-bars__bar${tone}`}
            title={val === null || val < 0 ? undefined : t('agent_detail.uptime_hour', { hours: hours.length - 1 - i, pct: val.toFixed(1) })}
          />
        );
      })}
    </span>
  );
}

function GlobalMetricsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.getGlobalMetrics();
        setHistory(Array.isArray(res.history) ? res.history : []);
      } catch (err) {
        console.error('Failed to load global metrics:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Escape closes the dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const average = (key: 'avg_cpu' | 'avg_ram') =>
    history.reduce((sum, h) => sum + (h[key] || 0), 0) / (history.length || 1);
  const peakSamples = history.reduce((max, h) => Math.max(max, h.data_points || 0), 0);

  return (
    <div className="modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="modal-content global-metrics"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-metrics-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="global-metrics-title"><LineChart size={18} aria-hidden="true" /> {t('global_metrics.title')}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body global-metrics__body">
          <p className="field-hint global-metrics__subtitle">{t('global_metrics.subtitle')}</p>
          {loading ? (
            <p className="agent-detail__loading" role="status">
              <RefreshCw size={16} className="spinning" aria-hidden="true" /> {t('global_metrics.loading')}
            </p>
          ) : history.length === 0 ? (
            <p className="settings-empty">{t('global_metrics.no_data')}</p>
          ) : (
            <>
              <section className="agent-detail__panel">
                <div className="global-metrics__legend">
                  <span><span className="global-metrics__swatch is-cpu" aria-hidden="true" /> {t('global_metrics.cpu')}</span>
                  <span><span className="global-metrics__swatch is-ram" aria-hidden="true" /> {t('global_metrics.ram')}</span>
                  <span className="global-metrics__window"><History size={14} aria-hidden="true" /> {t('global_metrics.window')}</span>
                </div>
                <div className="global-metrics__graph">
                  <MultiGraph
                    series={[
                      { data: history.map(h => ({ value: h.avg_cpu, timestamp: h.timestamp })), color: '#3DB8F5', label: 'CPU' },
                      { data: history.map(h => ({ value: h.avg_ram, timestamp: h.timestamp })), color: '#4FB3A6', label: 'RAM' },
                    ]}
                  />
                </div>
              </section>

              <dl className="global-metrics__stats">
                <div>
                  <dt>{t('global_metrics.avg_cpu')}</dt>
                  <dd>{average('avg_cpu').toFixed(1)} %</dd>
                </div>
                <div>
                  <dt>{t('global_metrics.avg_ram')}</dt>
                  <dd>{average('avg_ram').toFixed(1)} %</dd>
                </div>
                <div>
                  <dt>{t('global_metrics.peak')}</dt>
                  <dd>{peakSamples} <span className="rack-side__of">/ 15 min</span></dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MultiGraph({ series }: { series: { data: any[], color: string, label: string }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!series[0]?.data.length) return null;

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    const index = Math.round(pct * (series[0].data.length - 1));
    setHoverIdx(index);
  };

  return (
    <div 
      className="relative h-full w-full group cursor-crosshair"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {series.map((s, idx) => {
          const points = s.data.map((d, i) => {
            const x = (i / (s.data.length - 1)) * 100;
            const y = 100 - d.value;
            return `${x},${y}`;
          }).join(' ');
          
          return (
            <React.Fragment key={idx}>
              <defs>
                <linearGradient id={`grad-global-${idx}`} x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.1" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`M 0,100 L ${points} L 100,100 Z`} fill={`url(#grad-global-${idx})`} />
              <path
                d={`M ${points}`} 
                fill="none" 
                stroke={s.color} 
                strokeWidth="2" 
                strokeLinecap="round" 
              />
            </React.Fragment>
          );
        })}

        {hoverIdx !== null && series[0].data[hoverIdx] && (
          <line 
            x1={(hoverIdx / (series[0].data.length - 1)) * 100} 
            y1="0" 
            x2={(hoverIdx / (series[0].data.length - 1)) * 100} 
            y2="100" 
            stroke="white" 
            strokeOpacity="0.2" 
            strokeWidth="0.5" 
          />
        )}
      </svg>

      {/* Global Tooltip */}
      {hoverIdx !== null && series[0].data[hoverIdx] && (
        <div 
          className="absolute z-[110] bg-slate-900 border border-white/20 p-3 rounded-lg shadow-2xl pointer-events-none min-w-[120px]"
          style={{ 
            left: `${Math.min((hoverIdx / (series[0].data.length - 1)) * 100, 80)}%`, 
            top: '0%',
            transform: 'translateY(-110%)'
          }}
        >
          <div className="text-xs text-slate-400 mb-1.5 border-b border-white/5 pb-1">
            {new Date(series[0].data[hoverIdx].timestamp).toLocaleString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
          {series.map((s, i) => (
            <div key={i} className="flex justify-between gap-4 items-center">
              <span className="text-xs text-slate-400">{s.label}</span>
              <span className="text-sm font-black" style={{ color: s.color }}>{s.data[hoverIdx].value.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type SshCreds = { ssh_user: string; ssh_password: string; ssh_key: string; ssh_port: number };

// SSH secrets are kept in memory only (never in web storage), so they are gone on reload
const sshCredCache = new Map<number, SshCreds>();

function AgentDetailView({ deviceId, agent, onRefresh }: { deviceId: number; agent: AgentSummary; onRefresh: () => void }) {
  const { t } = useTranslation();
  const hasStoredCreds = sshCredCache.has(deviceId);
  const [activeTab, setActiveTab] = useState<'telemetry' | 'patching'>('telemetry');
  
  // SSH Credentials
  const [sshUser, setSshUser] = useState('root');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [authType, setAuthType] = useState<'password' | 'key'>('password');
  const [saveCreds, setSaveCreds] = useState(true);
  const [showCredForm, setShowCredForm] = useState(true);

  // States for Patch operations
  const [querying, setQuerying] = useState(false);
  const [patching, setPatching] = useState(false);
  const [packages, setPackages] = useState<{ package: string; current_version: string; new_version: string; repo?: string }[]>([]);
  const [majorUpgrade, setMajorUpgrade] = useState<string | null>(null);
  const [patchManager, setPatchManager] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);

  // Telemetry metric states
  const [selectedRange, setSelectedRange] = useState<string>('24h');
  const [availableRanges, setAvailableRanges] = useState<string[]>(['6h', '24h', '7d', '30d']);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const terminalContainerRef = useRef<HTMLDivElement>(null);

  // Load telemetry
  useEffect(() => {
    if (activeTab !== 'telemetry') return;
    const fetchHistory = async () => {
      setLoadingHistory(true);
      try {
        const res = await api.getAgentMetrics(deviceId, undefined, selectedRange);
        setHistory(res.snapshots);
        if (res.available_ranges) {
          setAvailableRanges(res.available_ranges);
          if (!res.available_ranges.includes(selectedRange)) {
            setSelectedRange(res.available_ranges[res.available_ranges.length - 1]);
          }
        }
        if (res.retention_days !== undefined) {
          setRetentionDays(res.retention_days);
        }
      } catch (err) {
        console.error('Failed to fetch history:', err);
      } finally {
        setLoadingHistory(false);
      }
    };
    fetchHistory();
  }, [deviceId, selectedRange, activeTab]);

  // Load remembered SSH credentials; drop plaintext copies older versions left in sessionStorage
  useEffect(() => {
    try {
      sessionStorage.removeItem(`agent_ssh_creds_${deviceId}`);
    } catch {}
    const cached = sshCredCache.get(deviceId);
    if (cached) {
      setSshUser(cached.ssh_user || 'root');
      setSshPassword(cached.ssh_password);
      setSshKey(cached.ssh_key);
      setSshPort(cached.ssh_port || 22);
      setAuthType(cached.ssh_key ? 'key' : 'password');
      setSaveCreds(true);
      setShowCredForm(false);
    }
  }, [deviceId]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalContainerRef.current) {
      terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  const getSshPayload = () => {
    return {
      ssh_user: sshUser,
      ssh_password: authType === 'password' ? sshPassword : undefined,
      ssh_key: authType === 'key' ? sshKey : undefined,
      ssh_port: sshPort
    };
  };

  const handleSaveCreds = (payload: any) => {
    if (saveCreds) {
      sshCredCache.set(deviceId, {
        ...payload,
        ssh_password: authType === 'password' ? sshPassword : '',
        ssh_key: authType === 'key' ? sshKey : ''
      });
    } else {
      sshCredCache.delete(deviceId);
    }
  };

  const queryUpdates = async () => {
    setQuerying(true);
    setPackages([]);
    setMajorUpgrade(null);
    setPatchManager(null);

    const payload = getSshPayload();
    handleSaveCreds(payload);

    try {
      const res = await api.queryAgentPatches(deviceId, payload);
      const updateError = (res as unknown as Record<string, unknown>).error;
      if (typeof updateError === 'string' && updateError) {
        alert(`Update check failed: ${updateError}`);
      }
      setPackages(res.packages);
      setMajorUpgrade(res.major_upgrade_available);
      setPatchManager(res.patch_manager);
      setShowCredForm(false);
    } catch (err: any) {
      alert(`Failed to load updates: ${err.message || err}`);
    } finally {
      setQuerying(false);
    }
  };

  const startPatching = async (mode: 'upgrade' | 'security-only') => {
    const actionLabel = mode === 'security-only' ? 'security updates' : 'all updates';
    if (!confirm(`Are you sure you want to run ${actionLabel} on this device?`)) {
      return;
    }

    setPatching(true);
    setTerminalOutput(["[Local] Requesting update token...\r\n"]);

    const payload = getSshPayload();
    handleSaveCreds(payload);

    try {
      const res = await api.prepareAgentPatch(deviceId, { ...payload, mode });
      const patchToken = res.patch_token;
      
      setTerminalOutput(prev => [...prev, "[Local] Token received. Connecting to WebSocket...\r\n"]);

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsToken = localStorage.getItem('gravitylan_token') || '';
      if (wsToken === 'undefined') wsToken = '';
      
      const wsBase = `${protocol}//${window.location.host}`;
      const ws = new WebSocket(`${wsBase}/api/agent/patches/${deviceId}/run-ws?patch_token=${patchToken}&token=${wsToken}`);
      
      ws.onopen = () => {
        setTerminalOutput(prev => [...prev, "[Local] WebSocket connection established. Launching updates...\r\n"]);
      };
      
      ws.onmessage = (event) => {
        setTerminalOutput(prev => [...prev, event.data]);
      };
      
      ws.onclose = (event) => {
        setTerminalOutput(prev => [...prev, `\r\n[Local] Update process terminated (code: ${event.code}).\r\n`]);
        setPatching(false);
        onRefresh();
      };
      
      ws.onerror = () => {
        setTerminalOutput(prev => [...prev, `\r\n[Local] Connection error.\r\n`]);
        setPatching(false);
      };

    } catch (err: any) {
      setTerminalOutput(prev => [...prev, `\r\n[Local] Error: ${err.message || err}\r\n`]);
      setPatching(false);
    }
  };

  const latest = history[history.length - 1];
  // A fresh update check wins over the (possibly older) agent report
  const patchManagerName = patchManager ?? agent.patch_manager;
  const majorUpgradeTarget = majorUpgrade ?? agent.major_upgrade_available;

  return (
    <div className="agent-detail">
      <div className="inspector-tabs agent-detail__tabs" role="tablist" aria-label={t('agent_detail.tabs_label')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'telemetry'}
          className={`inspector-tab${activeTab === 'telemetry' ? ' active' : ''}`}
          onClick={() => setActiveTab('telemetry')}
        >
          {t('agent_detail.tab_telemetry')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'patching'}
          className={`inspector-tab${activeTab === 'patching' ? ' active' : ''}`}
          onClick={() => setActiveTab('patching')}
        >
          {t('agent_detail.tab_patching')}
          {agent.patch_available > 0 && (
            <span className={`agent-detail__count${agent.patch_security > 0 ? ' is-security' : ''}`}>{agent.patch_available}</span>
          )}
          {agent.reboot_required && <span className="agent-detail__dot" title={t('agent_detail.reboot_badge')} />}
        </button>
      </div>

      {activeTab === 'telemetry' ? (
        loadingHistory ? (
          <p className="agent-detail__loading" role="status">
            <RefreshCw size={16} className="spinning" aria-hidden="true" /> {t('agent_detail.loading_history')}
          </p>
        ) : (
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
                  <button
                    key={r}
                    type="button"
                    className="segmented__option"
                    aria-pressed={selectedRange === r}
                    onClick={() => setSelectedRange(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="agent-detail__graphs">
              <GraphPanel icon={<Cpu size={16} />} title={t('agent_detail.cpu_title')} desc={t('agent_detail.cpu_desc', { range: selectedRange })}>
                <DetailGraph
                  data={history.map(h => ({ value: h.cpu_percent, timestamp: h.timestamp }))}
                  color="#3DB8F5"
                  label="CPU"
                  suffix="%"
                />
              </GraphPanel>
              <GraphPanel icon={<Memory size={16} />} title={t('agent_detail.ram_title')} desc={t('agent_detail.ram_desc', { range: selectedRange })}>
                <DetailGraph
                  data={history.map(h => ({ value: h.ram.percent, timestamp: h.timestamp }))}
                  color="#4FB3A6"
                  label="RAM"
                  suffix="%"
                />
              </GraphPanel>
              <GraphPanel icon={<Thermometer size={16} />} title={t('agent_detail.temp_title')} desc={t('agent_detail.temp_desc', { range: selectedRange })}>
                <DetailGraph
                  data={history.map(h => ({ value: h.temperature || 0, timestamp: h.timestamp }))}
                  color="#C4A2F0"
                  label="TEMP"
                  suffix="°C"
                  max={100}
                />
              </GraphPanel>
            </div>

            <section className="agent-detail__panel">
              <h4 className="agent-detail__title"><HardDrive size={16} aria-hidden="true" /> {t('agent_detail.storage_title')}</h4>
              <div className="agent-detail__disks">
                {latest?.disk?.map((disk: any) => (
                  <div key={disk.path} className="agent-disk">
                    <div className="agent-disk__head">
                      <span className="agent-disk__path" title={disk.path}>{disk.path}</span>
                      <span className={`agent-disk__pct${disk.percent > 90 ? ' is-danger' : disk.percent > 75 ? ' is-warn' : ''}`}>
                        {disk.percent.toFixed(0)} %
                      </span>
                    </div>
                    <span className="agent-meter__track">
                      <span className="agent-meter__fill" style={{ width: `${Math.min(100, disk.percent)}%` }} />
                    </span>
                    <span className="agent-disk__meta">
                      {t('agent_detail.disk_used', { used: disk.used_gb.toFixed(1), total: disk.total_gb.toFixed(1) })}
                    </span>
                  </div>
                ))}
                {!latest?.disk?.length && <p className="settings-empty">{t('agent_detail.no_disks')}</p>}
              </div>
            </section>
          </div>
        )
      ) : (
        <div className="agent-detail__section">
          {!patchManagerName ? (
            <div className="rack-state rack-state--empty agent-detail__unsupported">
              <span className="setup-features__icon" aria-hidden="true"><Shield size={18} /></span>
              <h2>{t('agent_detail.unsupported_title')}</h2>
              <p>{t('agent_detail.unsupported_desc')}</p>
            </div>
          ) : (
            <>
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

              {showCredForm && !patching && (
                <section className="agent-detail__panel">
                  <div className="agent-detail__panel-row">
                    <h4 className="agent-detail__title"><Lock size={14} aria-hidden="true" /> {t('agent_detail.ssh_title')}</h4>
                    {hasStoredCreds && (
                      <button type="button" className="manual-command__renew" onClick={() => setShowCredForm(false)}>
                        {t('agent_detail.hide')}
                      </button>
                    )}
                  </div>
                  <div className="agent-detail__creds">
                    <div className="settings-field">
                      <label className="form-label" htmlFor={`ssh-user-${deviceId}`}>{t('agent_detail.username')}</label>
                      <input
                        id={`ssh-user-${deviceId}`}
                        type="text"
                        className="input"
                        value={sshUser}
                        onChange={e => setSshUser(e.target.value)}
                        autoComplete="username"
                      />
                    </div>
                    <div className="settings-field">
                      <label className="form-label" htmlFor={`ssh-auth-${deviceId}`}>{t('agent_detail.auth_method')}</label>
                      <select
                        id={`ssh-auth-${deviceId}`}
                        className="input"
                        value={authType}
                        onChange={e => setAuthType(e.target.value as 'password' | 'key')}
                      >
                        <option value="password">{t('agent_detail.auth_password')}</option>
                        <option value="key">{t('agent_detail.auth_key')}</option>
                      </select>
                    </div>
                    <div className="settings-field agent-detail__secret">
                      {authType === 'password' ? (
                        <>
                          <label className="form-label" htmlFor={`ssh-pass-${deviceId}`}>{t('agent_detail.auth_password')}</label>
                          <input
                            id={`ssh-pass-${deviceId}`}
                            type="password"
                            className="input"
                            placeholder={t('agent_detail.password_placeholder')}
                            value={sshPassword}
                            onChange={e => setSshPassword(e.target.value)}
                            autoComplete="current-password"
                          />
                        </>
                      ) : (
                        <>
                          <label className="form-label" htmlFor={`ssh-key-${deviceId}`}>{t('agent_detail.auth_key')}</label>
                          <textarea
                            id={`ssh-key-${deviceId}`}
                            className="input input--mono"
                            rows={3}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            value={sshKey}
                            onChange={e => setSshKey(e.target.value)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                  <div className="agent-detail__panel-row">
                    <label className="agent-detail__check">
                      <input type="checkbox" checked={saveCreds} onChange={e => setSaveCreds(e.target.checked)} />
                      {t('agent_detail.remember')}
                    </label>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={queryUpdates} disabled={querying}>
                      {querying
                        ? <><RefreshCw size={14} className="spinning" aria-hidden="true" /> {t('agent_detail.querying')}</>
                        : t('agent_detail.query_list')}
                    </button>
                  </div>
                </section>
              )}

              {!showCredForm && !patching && (
                <div className="agent-detail__panel agent-detail__panel-row">
                  <span className="field-hint">{t('agent_detail.ssh_configured', { user: sshUser, port: sshPort })}</span>
                  <button type="button" className="manual-command__renew" onClick={() => setShowCredForm(true)}>
                    {t('agent_detail.change_credentials')}
                  </button>
                </div>
              )}

              {!patching && (
                <section className="agent-detail__panel">
                  <div className="agent-detail__panel-row">
                    <div>
                      <h4 className="agent-detail__title">{t('agent_detail.upgrades_title')}</h4>
                      <p className="field-hint">
                        {t('agent_detail.upgrades_count', { count: agent.patch_available, security: agent.patch_security })}
                      </p>
                    </div>
                    <div className="agent-detail__actions">
                      {packages.length === 0 && (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={queryUpdates} disabled={querying}>
                          {querying && <RefreshCw size={14} className="spinning" aria-hidden="true" />}
                          {t('agent_detail.query_details')}
                        </button>
                      )}
                      {agent.patch_security > 0 && (
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => startPatching('security-only')} disabled={patching || querying}>
                          {t('agent_detail.security_only')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => startPatching('upgrade')}
                        disabled={patching || querying || agent.patch_available === 0}
                      >
                        {t('agent_detail.upgrade_all')}
                      </button>
                    </div>
                  </div>

                  {packages.length > 0 ? (
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
                  ) : (
                    agent.patch_available > 0 && !querying && (
                      <p className="field-hint">{t('agent_detail.details_not_loaded')}</p>
                    )
                  )}
                </section>
              )}

              {(terminalOutput.length > 0 || patching) && (
                <section className="agent-detail__panel">
                  <h4 className="agent-detail__title"><Terminal size={14} aria-hidden="true" /> {t('agent_detail.live_output')}</h4>
                  <div ref={terminalContainerRef} className="agent-terminal" role="log" aria-live="polite">
                    {terminalOutput.map((chunk, idx) => (
                      <span key={idx}>{chunk}</span>
                    ))}
                  </div>
                  {!patching && terminalOutput.length > 0 && (
                    <div className="agent-detail__panel-row agent-detail__panel-row--end">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTerminalOutput([])}>
                        {t('agent_detail.clear_output')}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GraphPanel({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="agent-detail__panel">
      <div className="agent-detail__panel-head">
        <span className="agent-detail__panel-icon" aria-hidden="true">{icon}</span>
        <div>
          <h4 className="agent-detail__title">{title}</h4>
          <p className="field-hint">{desc}</p>
        </div>
      </div>
      <div className="agent-detail__graph">{children}</div>
    </section>
  );
}

function DetailGraph({ data, color, label, suffix, max = 100 }: {
  data: { value: number; timestamp: string }[];
  color: string;
  label: string;
  suffix: string;
  max?: number;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // The SVG coordinate space follows the rendered size, so the curve fills its panel and
  // labels stay at their real font size (a fixed 600x160 space shrank both in narrow panels)
  const [size, setSize] = useState({ w: 600, h: 160 });
  const hasData = data.length > 0;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasData]);

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-xs">
        {t('agent_detail.no_history')}
      </div>
    );
  }

  const W = size.w;
  const H = size.h;
  const PAD_L = 38; // space for Y-axis labels
  const PAD_R = 10;
  const PAD_T = 10;
  const PAD_B = 24; // space for X-axis labels
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const vals = data.map(d => d.value);
  const dataMin = Math.min(...vals);
  const dataMax = Math.max(...vals);
  const dataAvg = vals.reduce((a, b) => a + b, 0) / vals.length;

  const firstTime = new Date(data[0].timestamp).getTime();
  const lastTime = new Date(data[data.length - 1].timestamp).getTime();
  const diffHours = (lastTime - firstTime) / (1000 * 60 * 60);

  const formatLabel = (tsStr: string) => {
    const d = new Date(tsStr);
    if (diffHours <= 26) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (diffHours <= 180) {
      return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: '2-digit' });
  };

  // Map value → Y pixel (with 5% top/bottom padding so the line never hits the edge)
  const MARGIN = 0.05;
  const mapY = (v: number) =>
    PAD_T + chartH - ((Math.min(v, max) / max) * (1 - 2 * MARGIN) + MARGIN) * chartH;

  const mapX = (i: number) => PAD_L + (i / Math.max(data.length - 1, 1)) * chartW;

  const pts = data.map((d, i) => `${mapX(i).toFixed(1)},${mapY(d.value).toFixed(1)}`);
  const lineD = `M ${pts.join(' L ')}`;
  const areaD = `M ${PAD_L},${PAD_T + chartH} L ${pts.join(' L ')} L ${PAD_L + chartW},${PAD_T + chartH} Z`;

  const gradId = `dg-grad-${label}`;
  const clipId = `dg-clip-${label}`;

  const yTicks = [0, 25, 50, 75, 100].filter(t => t <= max);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    // Account for PAD_L as a fraction of total rendered width
    const relX = (e.clientX - rect.left - (PAD_L / W) * rect.width);
    const usableW = (chartW / W) * rect.width;
    const pct = Math.max(0, Math.min(1, relX / usableW));
    setHoverIdx(Math.round(pct * (data.length - 1)));
  };

  const hov = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <div className="relative w-full h-full flex flex-col gap-2">
      {/* Stats pill row */}
      <div className="flex gap-2 text-xs font-medium">
        <span className="px-2 py-0.5 rounded" style={{ background: `${color}18`, color }}>
          Min {dataMin.toFixed(1)}{suffix}
        </span>
        <span className="px-2 py-0.5 rounded bg-white/5 text-slate-400">
          Ø {dataAvg.toFixed(1)}{suffix}
        </span>
        <span className="px-2 py-0.5 rounded" style={{ background: `${color}18`, color }}>
          Max {dataMax.toFixed(1)}{suffix}
        </span>
      </div>

      {/* SVG chart — proper fixed coordinate viewport */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity="0.5" />
              <stop offset="70%" stopColor={color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
            <clipPath id={clipId}>
              <rect x={PAD_L} y={PAD_T} width={chartW} height={chartH} />
            </clipPath>
          </defs>

          {/* Y-axis ticks + grid lines */}
          {yTicks.map(tick => {
            const y = mapY(tick);
            return (
              <React.Fragment key={tick}>
                <line
                  x1={PAD_L} y1={y} x2={PAD_L + chartW} y2={y}
                  stroke="white" strokeOpacity={tick === 0 ? 0.12 : 0.05} strokeWidth="1"
                  strokeDasharray={tick === 0 ? 'none' : '4,4'}
                />
                <text
                  x={PAD_L - 6} y={y + 4}
                  textAnchor="end"
                  fontSize={11}
                  fill="rgba(148,163,184,0.6)"
                  fontFamily="monospace"
                >
                  {tick}
                </text>
              </React.Fragment>
            );
          })}

          {/* AVG line */}
          <line
            x1={PAD_L} y1={mapY(dataAvg)}
            x2={PAD_L + chartW} y2={mapY(dataAvg)}
            stroke={color} strokeOpacity="0.25" strokeWidth="1"
            strokeDasharray="6,4"
            clipPath={`url(#${clipId})`}
          />

          {/* Area fill */}
          <path d={areaD} fill={`url(#${gradId})`} clipPath={`url(#${clipId})`} />

          {/* Line */}
          <path
            d={lineD}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            clipPath={`url(#${clipId})`}
          />

          {/* X-axis labels: first and last timestamp */}
          <text x={PAD_L} y={H - 6} fontSize={11} fill="rgba(100,116,139,0.7)" fontFamily="monospace">
            {formatLabel(data[0].timestamp)}
          </text>
          <text x={PAD_L + chartW} y={H - 6} fontSize={11} fill="rgba(100,116,139,0.7)" fontFamily="monospace" textAnchor="end">
            {formatLabel(data[data.length - 1].timestamp)}
          </text>

          {/* Hover crosshair */}
          {hov && hoverIdx !== null && (
            <>
              <line
                x1={mapX(hoverIdx)} y1={PAD_T}
                x2={mapX(hoverIdx)} y2={PAD_T + chartH}
                stroke="white" strokeOpacity="0.35" strokeWidth="1"
                strokeDasharray="3,3"
              />
              <circle
                cx={mapX(hoverIdx)} cy={mapY(hov.value)}
                r="5" fill={color} stroke="white" strokeWidth="2"
              />
            </>
          )}
        </svg>

        {/* Floating tooltip */}
        {hov && hoverIdx !== null && (
          <div
            className="absolute z-50 pointer-events-none"
            style={{
              left: `${Math.min((mapX(hoverIdx) / W) * 100, 72)}%`,
              top: `${((mapY(hov.value) - PAD_T) / H) * 100}%`,
              transform: 'translate(12px, -50%)'
            }}
          >
            <div className="bg-slate-900/95 border border-white/20 backdrop-blur-sm px-3 py-2 rounded-lg shadow-2xl">
              <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">
                {diffHours <= 26 
                  ? new Date(hov.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
                  : new Date(hov.timestamp).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </div>
              <div className="text-base font-black" style={{ color }}>
                {hov.value.toFixed(1)}{suffix}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Neutral KPI tile: label, value, optional note; colour only for the note's state. */
function StatCard({ title, value, icon, note, noteTone }: {
  title: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  note?: string;
  noteTone?: 'ok' | 'warn' | 'muted';
}) {
  const noteColor = noteTone === 'warn' ? 'var(--accent-warning)' : noteTone === 'ok' ? 'var(--accent-success)' : 'var(--text-secondary)';
  return (
    <div className="stat-card">
      <div className="stat-card__head">
        <span className="stat-card__title">{title}</span>
        <span className="stat-card__icon" aria-hidden="true">{icon}</span>
      </div>
      <div className="stat-card__value">{value}</div>
      {note && <span className="stat-card__note" style={{ color: noteColor }}>{note}</span>}
    </div>
  );
}

import React from 'react';
