import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, ChevronDown, ChevronRight, Package, RotateCcw, Server, ShieldAlert, ShieldCheck } from 'lucide-react';

export interface AgentSummary {
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

export interface OverviewData {
  agents: AgentSummary[];
  total_agents: number;
  active_agents: number;
  total_data_points: number;
  avg_cpu: number;
  avg_ram: number;
}

/** Neutral KPI tile: label, value, optional note; colour only for the note's state. */
export function StatCard({ title, value, icon, note, noteTone }: {
  title: string;
  value: ReactNode;
  icon: ReactNode;
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

/** CPU/RAM meter; the bar turns amber at 75 % and red at 90 %. */
export function AgentMeter({ label, value }: { label: string; value: number }) {
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

function hourTone(val: number | null): string {
  if (val === null || val < 0) return '';
  if (val >= 100) return ' is-up';
  return val > 0 ? ' is-partial' : ' is-down';
}

/** Last 24 hours, one bar per hour: up, partly up, down, or no data. The % next to it carries the value. */
function UptimeStatusGrid({ data }: { data: number[] }) {
  const { t } = useTranslation();
  const hours: (number | null)[] = data && data.length > 0 ? data : Array(24).fill(null);
  return (
    <span className="uptime-bars" aria-hidden="true">
      {hours.map((val, i) => (
        <span
          key={i}
          className={`uptime-bars__bar${hourTone(val)}`}
          title={val === null || val < 0 ? undefined : t('agent_detail.uptime_hour', { hours: hours.length - 1 - i, pct: val.toFixed(1) })}
        />
      ))}
    </span>
  );
}

export function osLabelOf(agent: AgentSummary): string | null {
  if (agent.os_pretty) return agent.os_pretty;
  if (!agent.os_name) return null;
  return agent.os_version ? `${agent.os_name} ${agent.os_version}` : agent.os_name;
}

/** Updates, reboot and release-upgrade tags under the agent's name. */
function AgentTags({ agent }: { agent: AgentSummary }) {
  const { t } = useTranslation();
  const osLabel = osLabelOf(agent);
  return (
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
  );
}

/** The clickable summary line of an agent: identity, connection, load, uptime, last report. */
export function AgentSummaryRow({ agent, isOpen, onToggle }: { agent: AgentSummary; isOpen: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const lastSeen = agent.last_seen ? new Date(agent.last_seen) : null;
  return (
    <button
      type="button"
      className="agent-row__summary"
      aria-expanded={isOpen}
      aria-controls={`agent-detail-${agent.device_id}`}
      onClick={onToggle}
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
          <AgentTags agent={agent} />
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
        <span>{lastSeen ? lastSeen.toLocaleTimeString() : t('agent_detail.never')}</span>
        <span className="agent-row__seen-date">{lastSeen ? lastSeen.toLocaleDateString() : '–'}</span>
      </span>
    </button>
  );
}

/** The agent reported a key other than the stored one: offer to adopt it. */
export function PendingKeyAlert({ onAdopt }: { onAdopt: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="callout callout--danger agent-row__alert">
      <ShieldCheck size={16} className="callout__icon" aria-hidden="true" />
      <p className="callout__body">{t('agent_detail.token_mismatch')}</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onAdopt}>
        {t('dashboard.adopt')}
      </button>
    </div>
  );
}
