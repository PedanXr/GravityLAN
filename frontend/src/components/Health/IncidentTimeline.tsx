import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Radio } from 'lucide-react';
import type { HealthIncident } from '../../types';

interface IncidentTimelineProps {
  incidents: HealthIncident[];
  onSelectDevice?: (deviceId: number) => void;
  layout?: 'grid' | 'list';
}

export const IncidentTimeline: React.FC<IncidentTimelineProps> = ({
  incidents,
  onSelectDevice,
  layout = 'grid',
}) => {
  const { t } = useTranslation();

  if (!incidents || incidents.length === 0) {
    return (
      <div className="health-card p-6 text-center text-slate-400">
        <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-500 opacity-80" />
        <p className="text-sm font-medium">{t('health_page.no_incidents')}</p>
      </div>
    );
  }

  const getSeverityIcon = (severity: string, status: string) => {
    if (status === 'flapping') {
      return <Radio size={16} className="text-amber-400 animate-pulse" />;
    }
    if (severity === 'critical') {
      return <AlertCircle size={16} className="text-rose-400" />;
    }
    if (severity === 'warn') {
      return <AlertTriangle size={16} className="text-amber-400" />;
    }
    if (status === 'online' || status === 'service_up') {
      return <CheckCircle2 size={16} className="text-emerald-400" />;
    }
    return <Info size={16} className="text-sky-400" />;
  };

  const formatTimestamp = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return isoString;
    }
  };

  const containerClass = layout === 'list'
    ? 'health-incidents-feed flex flex-col gap-2.5 max-h-[460px] overflow-y-auto pr-1'
    : 'health-incidents-feed grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-h-[460px] overflow-y-auto pr-1';

  return (
    <div className={containerClass}>
      {incidents.map((incident) => {
        const isCrit = incident.severity === 'critical';
        const isWarn = incident.severity === 'warn';
        const borderClass = isCrit
          ? 'border-rose-500/30 bg-rose-500/5'
          : isWarn
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-slate-800 bg-[#151A21]';

        return (
          <div
            key={incident.id}
            onClick={() => onSelectDevice?.(incident.device_id)}
            className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${borderClass} hover:border-sky-500/50 hover:bg-[#1A222C] cursor-pointer`}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onSelectDevice?.(incident.device_id);
              }
            }}
          >
            <div className="mt-0.5 shrink-0">
              {getSeverityIcon(incident.severity, incident.status)}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-xs text-slate-200 truncate">
                  {incident.device_name}
                </span>
                <span className="text-[11px] font-mono text-slate-500 shrink-0">
                  {formatTimestamp(incident.timestamp)}
                </span>
              </div>

              <div className="text-xs text-slate-300 mt-1 line-clamp-2">
                {incident.message || incident.status}
              </div>

              <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-[#1F2732]/70 text-[11px] font-mono text-slate-400">
                <span className="truncate">{incident.device_ip}</span>
                <span className={`shrink-0 uppercase font-semibold tracking-wider text-[10px] px-1.5 py-0.5 rounded ${
                  isCrit
                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                    : isWarn
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    : 'bg-[#0E1116] text-slate-400 border border-slate-800'
                }`}>
                  {incident.status}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
