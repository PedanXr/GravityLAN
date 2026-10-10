import { useState, useEffect } from 'react';
import { Sidebar } from '../Sidebar';
import { MobileHeader } from '../MobileHeader';
import { api } from '../../api/client';
import { useTranslation } from 'react-i18next';
import { Server, Database, Cpu, MemoryStick as Memory, RefreshCw, Search, Activity } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { AgentSummaryRow, PendingKeyAlert, StatCard, type AgentSummary, type OverviewData } from './view/AgentParts';
import { GlobalMetricsOverlay } from './view/Graphs';
import { AgentDetailView } from './view/AgentDetail';

function matches(agent: AgentSummary, search: string): boolean {
  return agent.hostname.toLowerCase().includes(search.toLowerCase()) || agent.ip.includes(search);
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
      setData(await api.getAgentsOverview() as OverviewData);
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

  const adopt = (deviceId: number) => {
    if (!confirm(t('agent.adopt_confirm', 'Permanently accept this new agent key?'))) return;
    api.adoptAgent(deviceId).then(() => {
      alert(t('agent.adopt_success'));
      window.location.reload();
    });
  };

  const filteredAgents = data?.agents.filter(a => matches(a, search)) || [];

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

        <OverviewStats data={data} />

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
              return (
                <li key={agent.device_id} className={`agent-row${isOpen ? ' is-open' : ''}`}>
                  <AgentSummaryRow agent={agent} isOpen={isOpen} onToggle={() => setExpandedId(isOpen ? null : agent.device_id)} />
                  {agent.has_pending_token && <PendingKeyAlert onAdopt={() => adopt(agent.device_id)} />}
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

        <AnimatePresence>
          {showGlobalMetrics && <GlobalMetricsOverlay onClose={() => setShowGlobalMetrics(false)} />}
        </AnimatePresence>
      </main>
    </div>
  );
}

/** Global stats (real values only; no decorative trend lines) */
function OverviewStats({ data }: { data: OverviewData | null }) {
  const { t } = useTranslation();
  const avgCpu = data?.avg_cpu || 0;
  return (
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
        value={`${avgCpu.toFixed(1)} %`}
        icon={<Cpu size={18} />}
        noteTone={avgCpu >= 80 ? 'warn' : 'muted'}
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
  );
}
