import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  ShieldAlert,
  Lock,
  Layers,
  Wifi,
  Server,
  Monitor,
  HardDrive
} from 'lucide-react';
import type { DeviceHealthItem } from '../../types';

interface HealthDeviceRowProps {
  device: DeviceHealthItem;
  isSelected: boolean;
  onSelect: (device: DeviceHealthItem) => void;
}

// Device icon based on device_type
const getDeviceIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case 'server':
      return <Server size={16} className="text-slate-400" />;
    case 'router':
    case 'gateway':
    case 'ap':
      return <Wifi size={16} className="text-slate-400" />;
    case 'nas':
    case 'storage':
      return <HardDrive size={16} className="text-slate-400" />;
    default:
      return <Monitor size={16} className="text-slate-400" />;
  }
};

// Status color styling
const getStatusBadge = (healthStatus: string, t: any) => {
  switch (healthStatus) {
    case 'healthy':
      return {
        bg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
        label: t('health_page.filter_healthy'),
        dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(46,160,67,0.6)]',
      };
    case 'flapping':
      return {
        bg: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
        label: t('health_page.filter_flapping'),
        dot: 'bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(227,179,65,0.6)]',
      };
    case 'degraded':
      return {
        bg: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        label: t('health_page.filter_degraded'),
        dot: 'bg-amber-400 shadow-[0_0_8px_rgba(227,179,65,0.6)]',
      };
    case 'critical':
      return {
        bg: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
        label: t('health_page.filter_critical'),
        dot: 'bg-rose-400 shadow-[0_0_8px_rgba(244,112,103,0.6)]',
      };
    case 'standby':
      return {
        bg: 'bg-slate-800/80 text-slate-400 border-slate-700',
        label: t('health_page.filter_standby', 'Standby'),
        dot: 'bg-slate-500',
      };
    case 'offline':
    default:
      return {
        bg: 'bg-slate-800 text-slate-400 border-slate-700',
        label: t('common.offline'),
        dot: 'bg-slate-500',
      };
  }
};

// Score badge color
const getScoreColor = (score: number, healthStatus?: string) => {
  if (healthStatus === 'standby') {
    return 'text-slate-400 border-slate-700 bg-slate-800/50';
  }
  if (score >= 90) return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
  if (score >= 70) return 'text-amber-300 border-amber-500/30 bg-amber-500/10';
  return 'text-rose-400 border-rose-500/30 bg-rose-500/10';
};

export const HealthDeviceRow: React.FC<HealthDeviceRowProps> = ({
  device,
  isSelected,
  onSelect,
}) => {
  const { t } = useTranslation();
  const statusBadge = getStatusBadge(device.health_status, t);

  // Sparkline rendering
  const renderSparkline = () => {
    const data = device.latency.sparkline;
    if (!data || data.length < 2) {
      return (
        <span className="text-slate-600 font-mono text-[11px]">-</span>
      );
    }

    const validVals = data.filter((v): v is number => v !== null);
    if (validVals.length < 2) {
      return <span className="text-slate-600 font-mono text-[11px]">-</span>;
    }

    const min = Math.min(...validVals);
    const max = Math.max(...validVals);
    const range = max - min || 1;
    const height = 22;
    const width = 80;

    const points = data
      .map((val, idx) => {
        if (val === null) return null;
        const x = (idx / (data.length - 1)) * width;
        const y = height - ((val - min) / range) * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(' ');

    return (
      <svg width={width} height={height} className="overflow-visible shrink-0">
        <polyline
          fill="none"
          stroke="#3DB8F5"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
      </svg>
    );
  };

  // Heartbeat availability bars (Uptime-Kuma style)
  const renderUptimeBars = () => {
    const bars = device.uptime.history_bars;
    if (!bars || bars.length === 0) {
      return (
        <div className="h-4 flex items-center text-slate-600 font-mono text-xs">
          100%
        </div>
      );
    }

    return (
      <div className="w-44 flex items-center gap-[2px] h-5" title={`Uptime: ${device.uptime.uptime_pct}%`}>
        {bars.map((pct, idx) => {
          let barBg = 'bg-slate-800';
          if (pct === null) {
            barBg = 'bg-[#1F2732]';
          } else if (pct >= 99) {
            barBg = 'bg-emerald-500';
          } else if (pct > 0) {
            barBg = 'bg-amber-400';
          } else {
            barBg = 'bg-rose-500';
          }

          return (
            <div
              key={idx}
              className={`flex-1 min-w-[2px] h-3.5 rounded-[1px] transition-all duration-150 hover:h-5 ${barBg}`}
              title={pct !== null ? `${pct}%` : 'No data'}
            />
          );
        })}
      </div>
    );
  };

  // Check for SSL expiry warning
  const sslWarningCount = device.services.filter(
    (s) => !s.ignore_ssl && s.ssl_expiry_days !== null && s.ssl_expiry_days <= 14
  ).length;

  // Check for agent warnings
  const hasAgentWarning = Boolean(
    device.agent && (device.agent.patch_security > 0 || device.agent.reboot_required)
  );

  return (
    <tr
      onClick={() => onSelect(device)}
      className={`border-b border-[#1F2732] cursor-pointer transition-colors duration-150 group ${
        isSelected ? 'bg-[#1C2430]' : 'bg-[#151A21] hover:bg-[#1A222C]'
      }`}
    >
      {/* 1. Device Info */}
      <td className="py-4.5 px-6 w-[34%] min-w-[280px]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#0E1116] border border-[#1F2732] flex items-center justify-center shrink-0">
            {getDeviceIcon(device.device_type)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-slate-100 truncate group-hover:text-sky-400 transition-colors">
                {device.display_name}
              </span>
              {device.group_name && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#1F2732] text-slate-400 border border-slate-700/50">
                  {device.group_name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-slate-400 mt-0.5">
              <span>{device.ip}</span>
              {device.hostname && device.hostname !== device.display_name && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-500 truncate max-w-[140px]">{device.hostname}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </td>

      {/* 2. Status & Score */}
      <td className="py-4.5 px-6 w-48 min-w-[180px]">
        <div className="flex items-center gap-2.5">
          <div className={`px-2 py-0.5 rounded-full border text-xs font-medium flex items-center gap-1.5 ${statusBadge.bg}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${statusBadge.dot}`} />
            {statusBadge.label}
          </div>
          <div
            className={`px-2 py-0.5 rounded font-mono font-bold text-xs border ${getScoreColor(
              device.health_score
            )}`}
            title={`Health Score: ${device.health_score}/100`}
          >
            {device.health_score}
          </div>
        </div>
      </td>

      {/* 3. Availability SLA & Heartbeat Bar */}
      <td className="py-4.5 px-6 w-56 min-w-[220px]">
        <div className="w-44 flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-semibold text-slate-200">
              {device.uptime.uptime_pct.toFixed(1)}%
            </span>
            <span className="text-[11px] text-slate-500 font-mono">
              24h: {device.uptime.uptime_24h.toFixed(0)}%
            </span>
          </div>
          {renderUptimeBars()}
        </div>
      </td>

      {/* 4. Latency & Jitter & Sparkline */}
      <td className="py-4.5 px-6 w-60 min-w-[230px]">
        <div className="flex items-center justify-between gap-5">
          <div className="text-xs font-mono">
            <div className="text-slate-200 font-semibold">
              {device.latency.current_ms !== null ? `${device.latency.current_ms.toFixed(1)} ms` : '-'}
            </div>
            <div className="text-[10px] text-slate-400">
              Ø {device.latency.avg_ms !== null ? `${device.latency.avg_ms.toFixed(1)} ms` : '-'}
              {device.latency.jitter_ms !== null && ` ±${device.latency.jitter_ms.toFixed(1)}`}
            </div>
          </div>
          <div className="hidden sm:block">
            {renderSparkline()}
          </div>
        </div>
      </td>

      {/* 5. Services & Warnings */}
      <td className="py-4.5 px-6 w-44 min-w-[170px]">
        <div className="flex items-center gap-2 flex-wrap">
          {device.services.length > 0 ? (
            <span className="px-2 py-0.5 rounded text-xs font-mono bg-[#0E1116] border border-[#1F2732] text-slate-300 flex items-center gap-1">
              <Layers size={12} className="text-slate-400" />
              {device.services.filter((s) => s.is_up).length}/{device.services.length}
            </span>
          ) : (
            <span className="text-slate-600 text-xs font-mono">-</span>
          )}

          {sslWarningCount > 0 && (
            <span
              className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center gap-1"
              title={t('health_page.ssl_expiring_soon', { count: sslWarningCount })}
            >
              <Lock size={11} />
              SSL
            </span>
          )}

          {hasAgentWarning && (
            <span
              className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center gap-1"
              title={t('health_page.agent_warning_title')}
            >
              <ShieldAlert size={11} />
              {device.agent?.reboot_required ? 'Reboot' : 'Patch'}
            </span>
          )}
        </div>
      </td>

      {/* 6. Expand Action */}
      <td className="py-4.5 px-6 text-right w-14">
        <button
          type="button"
          aria-label={t('health_page.drawer_telemetry')}
          className="p-1 rounded hover:bg-[#1F2732] text-slate-400 hover:text-sky-400 transition-colors"
        >
          <ChevronRight size={18} className={`transition-transform ${isSelected ? 'rotate-90 text-sky-400' : ''}`} />
        </button>
      </td>
    </tr>
  );
};

export function HealthMobileCard({ device, isSelected, onSelect }: HealthDeviceRowProps) {
  const { t } = useTranslation();
  const statusBadge = getStatusBadge(device.health_status, t);

  const sslWarningCount = device.services.filter(
    (s) => !s.ignore_ssl && s.ssl_expiry_days !== null && s.ssl_expiry_days <= 14
  ).length;

  const hasAgentWarning = Boolean(
    device.agent && (device.agent.patch_security > 0 || device.agent.reboot_required)
  );

  return (
    <div
      onClick={() => onSelect(device)}
      className={`p-4 rounded-xl border transition-all cursor-pointer flex flex-col gap-3.5 ${
        isSelected
          ? 'bg-[#1C2430] border-sky-500 shadow-md ring-1 ring-sky-500/20'
          : 'bg-[#151A21] border-[#1F2732] hover:border-slate-600 shadow-sm active:bg-[#1A222C]'
      }`}
    >
      {/* Top Header: Icon + Device Info + Score & Chevron */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-lg bg-[#0E1116] border border-[#1F2732] flex items-center justify-center shrink-0">
            {getDeviceIcon(device.device_type)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-slate-100 truncate">
                {device.display_name}
              </span>
              {device.group_name && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#1F2732] text-slate-400 border border-slate-700/50 shrink-0">
                  {device.group_name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs font-mono text-slate-400 mt-0.5">
              <span>{device.ip}</span>
              {device.hostname && device.hostname !== device.display_name && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-500 truncate max-w-[120px]">{device.hostname}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div
            className={`px-2 py-0.5 rounded font-mono font-bold text-xs border ${getScoreColor(
              device.health_score
            )}`}
            title={`Score: ${device.health_score}/100`}
          >
            {device.health_score}
          </div>
          <ChevronRight size={18} className={`text-slate-500 transition-transform ${isSelected ? 'rotate-90 text-sky-400' : ''}`} />
        </div>
      </div>

      {/* Status Pill & Availability */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#1F2732]/70 text-xs">
        <div className={`px-2 py-0.5 rounded-full border text-[11px] font-medium flex items-center gap-1.5 ${statusBadge.bg}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusBadge.dot}`} />
          {statusBadge.label}
        </div>

        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-slate-400 font-sans text-[11px]">{t('health_page.table_uptime')}:</span>
          <span className="font-semibold text-slate-200">
            {device.uptime.uptime_pct.toFixed(1)}%
          </span>
          <span className="text-[10px] text-slate-500">
            (24h: {device.uptime.uptime_24h.toFixed(0)}%)
          </span>
        </div>
      </div>

      {/* Heartbeat Uptime Bars */}
      <div className="w-full flex items-center gap-[2px] h-3">
        {(device.uptime.history_bars || []).map((pct, idx) => {
          let barBg = 'bg-slate-800';
          if (pct === null) barBg = 'bg-[#1F2732]';
          else if (pct >= 99) barBg = 'bg-emerald-500';
          else if (pct > 0) barBg = 'bg-amber-400';
          else barBg = 'bg-rose-500';
          return (
            <div
              key={idx}
              className={`flex-1 min-w-[2px] h-2.5 rounded-[1px] ${barBg}`}
            />
          );
        })}
      </div>

      {/* Bottom Latency & Services */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#1F2732]/60 text-xs font-mono">
        <div className="flex items-center gap-2">
          <span className="text-slate-200 font-semibold">
            {device.latency.current_ms !== null ? `${device.latency.current_ms.toFixed(1)} ms` : '-'}
          </span>
          <span className="text-[10px] text-slate-500">
            Ø {device.latency.avg_ms !== null ? `${device.latency.avg_ms.toFixed(1)} ms` : '-'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {device.services.length > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[11px] bg-[#0E1116] border border-[#1F2732] text-slate-300 flex items-center gap-1">
              <Layers size={11} className="text-slate-400" />
              {device.services.filter((s) => s.is_up).length}/{device.services.length}
            </span>
          )}

          {sslWarningCount > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center gap-1">
              <Lock size={10} />
              SSL
            </span>
          )}

          {hasAgentWarning && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/10 border border-rose-500/30 text-rose-400 flex items-center gap-1">
              <ShieldAlert size={10} />
              {device.agent?.reboot_required ? 'Reboot' : 'Patch'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
