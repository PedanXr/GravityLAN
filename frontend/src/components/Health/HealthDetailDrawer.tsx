import React, { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Layers,
  Server,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Lock,
  Cpu,
  Thermometer,
  RotateCcw,
  Loader2,
  Clock,
  Bell,
  BellOff,
} from 'lucide-react';
import { api } from '../../api/client';
import { IncidentTimeline } from './IncidentTimeline';
import type { DeviceHealthItem, DeviceHealthDetailResponse } from '../../types';

interface HealthDetailDrawerProps {
  device: DeviceHealthItem | null;
  period: '24h' | '7d' | '30d';
  onClose: () => void;
  onUpdated?: () => void;
}

export const HealthDetailDrawer: React.FC<HealthDetailDrawerProps> = ({
  device,
  period,
  onClose,
  onUpdated,
}) => {
  const { t } = useTranslation();
  const [detailData, setDetailData] = useState<DeviceHealthDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [togglingSvcId, setTogglingSvcId] = useState<number | null>(null);
  const [togglingAlert, setTogglingAlert] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState<{
    x: number;
    y: number;
    isOnline: boolean;
    latency: number | null;
    time: string;
  } | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const deviceId = device?.id ?? null;

  const handleToggleAlertOffline = async (devId: number, currentAlert: boolean) => {
    setTogglingAlert(true);
    try {
      await api.updateDevice(devId, { alert_offline: !currentAlert });
      if (deviceId !== null) {
        const refreshed = await api.getDeviceHealthDetail(deviceId, period);
        setDetailData(refreshed);
      }
      onUpdated?.();
    } catch (err) {
      console.error('Failed to toggle alert_offline:', err);
    } finally {
      setTogglingAlert(false);
    }
  };

  const handleToggleIgnoreSsl = async (serviceId: number, currentIgnore: boolean) => {
    setTogglingSvcId(serviceId);
    try {
      await api.updateService(serviceId, { ignore_ssl: !currentIgnore });
      if (deviceId !== null) {
        const refreshed = await api.getDeviceHealthDetail(deviceId, period);
        setDetailData(refreshed);
      }
      onUpdated?.();
    } catch (err) {
      console.error('Failed to toggle ignore_ssl:', err);
    } finally {
      setTogglingSvcId(null);
    }
  };

  useEffect(() => {
    if (deviceId === null) {
      setDetailData(null);
      return;
    }

    let isMounted = true;
    setLoading(true);

    api.getDeviceHealthDetail(deviceId, period)
      .then((data) => {
        if (isMounted) {
          setDetailData(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load device health detail:', err);
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [deviceId, period]);

  if (!device) return null;

  const isMatchingDetail = detailData?.device.id === device.id;
  const currentDev = isMatchingDetail ? detailData.device : device;

  // Format date helper
  const formatDate = (isoStr: string | null) => {
    if (!isoStr) return '-';
    try {
      return new Date(isoStr).toLocaleString();
    } catch {
      return isoStr;
    }
  };

  // Render SVG time-series chart
  const renderDetailChart = () => {
    const samples = isMatchingDetail ? detailData.time_series : [];
    if (samples.length < 2) {
      return (
        <div className="h-32 flex items-center justify-center text-xs font-mono text-slate-500 bg-[#0E1116] rounded border border-[#1F2732]">
          {loading ? (
            <Loader2 size={16} className="animate-spin text-sky-400" />
          ) : (
            t('health_page.not_enough_samples')
          )}
        </div>
      );
    }

    const latencies = samples.map((s) => s.latency_ms).filter((v): v is number => v !== null);
    const minLat = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLat = latencies.length > 0 ? Math.max(...latencies) : 10;
    const range = maxLat - minLat || 1;

    const width = 480;
    const height = 120;
    const padding = 20;

    const points = samples.map((s, idx) => {
      const x = padding + (idx / (samples.length - 1)) * (width - padding * 2);
      const y = s.latency_ms !== null
        ? height - padding - ((s.latency_ms - minLat) / range) * (height - padding * 2)
        : height - padding;
      return { x, y, isOnline: s.is_online, latency: s.latency_ms, time: s.timestamp };
    });

    const pathData = points
      .filter((p) => p.latency !== null)
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');

    const handlePointerMove = (clientX: number) => {
      if (!chartContainerRef.current || points.length === 0) return;
      const rect = chartContainerRef.current.getBoundingClientRect();
      const relX = clientX - rect.left;
      const svgX = (relX / rect.width) * width;
      let closest = points[0];
      let minDist = Math.abs(points[0].x - svgX);
      for (let i = 1; i < points.length; i++) {
        const dist = Math.abs(points[i].x - svgX);
        if (dist < minDist) {
          minDist = dist;
          closest = points[i];
        }
      }
      setHoveredPoint(closest);
    };

    return (
      <div className="bg-[#0E1116] p-3 rounded-lg border border-[#1F2732] flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-200">{t('health_page.drawer_telemetry')}</span>
            {hoveredPoint && (
              <span className="text-[11px] font-mono flex items-center gap-1.5 animate-in fade-in duration-100">
                <span className={`w-1.5 h-1.5 rounded-full ${hoveredPoint.isOnline ? 'bg-sky-400' : 'bg-rose-400'}`} />
                <span className="text-slate-300">
                  {new Date(hoveredPoint.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}:
                </span>
                <span className={`font-bold ${hoveredPoint.isOnline ? 'text-sky-400' : 'text-rose-400'}`}>
                  {hoveredPoint.latency !== null ? `${hoveredPoint.latency.toFixed(1)} ms` : t('common.offline')}
                </span>
              </span>
            )}
          </div>
          <span className="font-mono text-[11px] text-slate-500">
            Min: {minLat.toFixed(1)}ms · Max: {maxLat.toFixed(1)}ms
          </span>
        </div>

        <div
          ref={chartContainerRef}
          onMouseMove={(e) => handlePointerMove(e.clientX)}
          onMouseLeave={() => setHoveredPoint(null)}
          onTouchMove={(e) => {
            if (e.touches[0]) handlePointerMove(e.touches[0].clientX);
          }}
          onTouchEnd={() => setHoveredPoint(null)}
          className="relative w-full h-32 cursor-crosshair select-none"
        >
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
            <defs>
              <linearGradient id="detail-lat-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3DB8F5" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#3DB8F5" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Horizontal Grid lines */}
            <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="#1F2732" strokeDasharray="3 3" />
            <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="#1F2732" strokeDasharray="3 3" />
            <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#1F2732" />

            {/* Area gradient under line */}
            {pathData && points.length > 1 && (
              <path
                d={`${pathData} L ${points[points.length - 1].x.toFixed(1)} ${(height - padding).toFixed(1)} L ${points[0].x.toFixed(1)} ${(height - padding).toFixed(1)} Z`}
                fill="url(#detail-lat-grad)"
              />
            )}

            {/* Latency line */}
            {pathData && (
              <path
                d={pathData}
                fill="none"
                stroke="#3DB8F5"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Normal points */}
            {points.map((p, idx) => (
              <circle
                key={idx}
                cx={p.x}
                cy={p.y}
                r={p.isOnline ? 2.5 : 3.5}
                fill={p.isOnline ? '#3DB8F5' : '#F47067'}
              />
            ))}

            {/* Hover vertical crosshair & pulsing active dot */}
            {hoveredPoint && (
              <>
                <line
                  x1={hoveredPoint.x}
                  y1={padding - 4}
                  x2={hoveredPoint.x}
                  y2={height - padding + 4}
                  stroke="#38BDF8"
                  strokeWidth="1.25"
                  strokeDasharray="3 3"
                  opacity="0.75"
                />
                <circle
                  cx={hoveredPoint.x}
                  cy={hoveredPoint.y}
                  r={5.5}
                  fill={hoveredPoint.isOnline ? '#38BDF8' : '#F47067'}
                  stroke="#0E1116"
                  strokeWidth="2.5"
                />
              </>
            )}
          </svg>

          {/* Interactive Floating Tooltip */}
          {hoveredPoint && (
            <div
              className="absolute z-20 pointer-events-none bg-[#151A21] border border-[#1F2732] rounded-lg px-2.5 py-1.5 shadow-2xl text-xs flex flex-col gap-0.5 transition-all duration-75"
              style={{
                left: `${Math.min(Math.max((hoveredPoint.x / width) * 100, 16), 84)}%`,
                top: `${Math.max(6, Math.min(hoveredPoint.y - 42, 60))}px`,
                transform: 'translate(-50%, -100%)',
              }}
            >
              <div className="text-[10px] text-slate-400 font-mono flex items-center justify-between gap-3">
                <span>{new Date(hoveredPoint.time).toLocaleDateString([], { month: 'short', day: '2-digit' })}</span>
                <span>{new Date(hoveredPoint.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              <div className="flex items-center gap-2 font-mono">
                <span className={`w-2 h-2 rounded-full ${hoveredPoint.isOnline ? 'bg-sky-400' : 'bg-rose-400'}`} />
                <span className="font-bold text-slate-100">
                  {hoveredPoint.latency !== null ? `${hoveredPoint.latency.toFixed(1)} ms` : t('common.offline')}
                </span>
                <span className={`text-[10px] px-1 rounded ${hoveredPoint.isOnline ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                  {hoveredPoint.isOnline ? 'OK' : 'OFFLINE'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-y-0 right-0 w-full sm:w-[580px] lg:w-[650px] xl:w-[700px] bg-[#151A21] border-l border-[#1F2732] z-50 shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-right duration-200"
      role="dialog"
      aria-labelledby="drawer-title"
    >
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-[#1F2732] flex items-center justify-between bg-[#11141A] gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 id="drawer-title" className="font-bold text-base text-slate-100 truncate">
              {currentDev.display_name}
            </h2>
            <span className="font-mono text-xs px-2 py-0.5 rounded bg-[#1F2732] text-slate-300">
              {currentDev.ip}
            </span>
            {currentDev.group_name && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1F2732] text-slate-400 border border-slate-700/50">
                {currentDev.group_name}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-0.5 truncate">
            {currentDev.hostname || currentDev.device_type}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* 24/7 Monitoring Toggle */}
          <button
            type="button"
            disabled={togglingAlert}
            onClick={() => handleToggleAlertOffline(currentDev.id, currentDev.alert_offline ?? true)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
              (currentDev.alert_offline ?? true)
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200 hover:border-slate-600'
            }`}
            title={t('health_page.alert_offline_hint')}
          >
            {togglingAlert ? (
              <Loader2 size={12} className="animate-spin text-sky-400" />
            ) : (currentDev.alert_offline ?? true) ? (
              <>
                <Bell size={13} />
                <span className="hidden sm:inline">{t('health_page.alert_offline_24_7')}</span>
              </>
            ) : (
              <>
                <BellOff size={13} />
                <span className="hidden sm:inline">{t('health_page.alert_offline_client')}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-[#1F2732] transition-colors"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content Scrollable */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
        {/* Metric Cards Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-lg bg-[#0E1116] border border-[#1F2732]">
            <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              {t('health_page.table_uptime')}
            </div>
            <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
              {currentDev.uptime.uptime_pct.toFixed(1)}%
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-0.5">
              24h: {currentDev.uptime.uptime_24h.toFixed(1)}% · 7d: {currentDev.uptime.uptime_7d.toFixed(1)}%
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[#0E1116] border border-[#1F2732]">
            <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              {t('health_page.avg_latency')}
            </div>
            <div className="text-xl font-bold font-mono text-sky-400 mt-1">
              {currentDev.latency.avg_ms !== null ? `${currentDev.latency.avg_ms.toFixed(1)} ms` : '-'}
            </div>
            <div className="text-[11px] font-mono text-slate-500 mt-0.5">
              Jitter: ±{currentDev.latency.jitter_ms !== null ? currentDev.latency.jitter_ms.toFixed(1) : '-'} ms
            </div>
          </div>
        </div>

        {/* Latency Telemetry Chart */}
        {renderDetailChart()}

        {/* Services & Port Probes */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Layers size={14} className="text-sky-400" />
              {t('health_page.drawer_services')} ({currentDev.services.length})
            </h3>
          </div>

          {currentDev.services.length === 0 ? (
            <div className="p-3 text-center text-xs text-slate-500 bg-[#0E1116] rounded border border-[#1F2732]">
              {t('health_page.no_services_discovered')}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {currentDev.services.map((srv) => {
                const isSslIgnored = Boolean(srv.ignore_ssl);
                const isSslWarning = !isSslIgnored && srv.ssl_expiry_days !== null && srv.ssl_expiry_days <= 14;
                const isSslExpired = !isSslIgnored && srv.ssl_expiry_days !== null && srv.ssl_expiry_days <= 0;
                const isSslCandidate =
                  srv.protocol?.toLowerCase() === 'https' ||
                  srv.port === 443 ||
                  srv.port === 8443 ||
                  srv.port === 5001 ||
                  srv.ssl_expiry_days !== null ||
                  isSslIgnored;

                return (
                  <div
                    key={srv.id}
                    className="flex items-center justify-between p-2.5 rounded-lg bg-[#0E1116] border border-[#1F2732] text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${srv.is_up ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                      <span className="font-semibold text-slate-200">{srv.name}</span>
                      <span className="text-slate-500">:{srv.port}</span>
                    </div>

                    <div className="flex items-center gap-2 sm:gap-3">
                      {srv.latency_ms !== null && (
                        <span className="text-slate-400">
                          {srv.latency_ms.toFixed(1)} ms
                        </span>
                      )}

                      {isSslIgnored ? (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium border flex items-center gap-1 bg-slate-800 text-slate-400 border-slate-700"
                          title={t('health_page.ignore_ssl_hint')}
                        >
                          <ShieldOff size={10} className="text-slate-400" />
                          {t('health_page.ssl_ignored')}
                        </span>
                      ) : srv.ssl_expiry_days !== null ? (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium border flex items-center gap-1 ${
                            isSslExpired
                              ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                              : isSslWarning
                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                              : 'bg-[#1F2732] text-slate-400 border-slate-700'
                          }`}
                        >
                          <Lock size={10} />
                          {isSslExpired
                            ? t('health_page.ssl_expired')
                            : t('health_page.ssl_days_left', { days: srv.ssl_expiry_days })}
                        </span>
                      ) : null}

                      {isSslCandidate && (
                        <button
                          type="button"
                          disabled={togglingSvcId === srv.id}
                          onClick={() => handleToggleIgnoreSsl(srv.id, isSslIgnored)}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors flex items-center gap-1 ${
                            isSslIgnored
                              ? 'bg-sky-500/10 text-sky-400 border-sky-500/30 hover:bg-sky-500/20'
                              : 'bg-[#151A21] text-slate-400 border-[#1F2732] hover:text-amber-400 hover:border-amber-500/30'
                          }`}
                          title={t('health_page.ignore_ssl_hint')}
                        >
                          {togglingSvcId === srv.id ? (
                            <Loader2 size={10} className="animate-spin text-sky-400" />
                          ) : isSslIgnored ? (
                            <>
                              <ShieldCheck size={10} />
                              <span>{t('health_page.unignore_ssl_btn')}</span>
                            </>
                          ) : (
                            <>
                              <ShieldOff size={10} />
                              <span>{t('health_page.ignore_ssl_btn')}</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Agent Telemetry & Alerts (if installed) */}
        {currentDev.agent?.has_agent && (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Server size={14} className="text-sky-400" />
              {t('health_page.drawer_agent_health')}
            </h3>

            <div className="p-3 rounded-lg bg-[#0E1116] border border-[#1F2732] flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">{t('health_page.agent_version_label')}</span>
                <span className="text-slate-200">{currentDev.agent.agent_version || 'v1.0'}</span>
              </div>

              {/* Hardware gauges */}
              <div className="grid grid-cols-3 gap-2 text-center text-xs font-mono">
                <div className="p-2 rounded bg-[#151A21] border border-[#1F2732]">
                  <div className="text-[10px] text-slate-400 flex items-center justify-center gap-1">
                    <Cpu size={12} /> CPU
                  </div>
                  <div className="font-bold text-slate-100 mt-1">
                    {currentDev.agent.cpu_percent !== null ? `${currentDev.agent.cpu_percent.toFixed(0)}%` : '-'}
                  </div>
                </div>

                <div className="p-2 rounded bg-[#151A21] border border-[#1F2732]">
                  <div className="text-[10px] text-slate-400">RAM</div>
                  <div className="font-bold text-slate-100 mt-1">
                    {currentDev.agent.ram_percent !== null ? `${currentDev.agent.ram_percent.toFixed(0)}%` : '-'}
                  </div>
                </div>

                <div className="p-2 rounded bg-[#151A21] border border-[#1F2732]">
                  <div className="text-[10px] text-slate-400 flex items-center justify-center gap-1">
                    <Thermometer size={12} /> Temp
                  </div>
                  <div className="font-bold text-slate-100 mt-1">
                    {currentDev.agent.temperature !== null ? `${currentDev.agent.temperature.toFixed(0)}°C` : '-'}
                  </div>
                </div>
              </div>

              {/* Patches and reboot warnings */}
              {(currentDev.agent.patch_security > 0 || currentDev.agent.reboot_required) && (
                <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                  <ShieldAlert size={16} className="text-rose-400 shrink-0 mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    {currentDev.agent.patch_security > 0 && (
                      <div>
                        {t('health_page.critical_patches_count', { count: currentDev.agent.patch_security })}
                      </div>
                    )}
                    {currentDev.agent.reboot_required && (
                      <div className="flex items-center gap-1 font-semibold">
                        <RotateCcw size={12} /> {t('health_page.reboot_required_desc')}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Metadata Details */}
        <div className="p-3 rounded-lg bg-[#0E1116] border border-[#1F2732] flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between text-slate-400">
            <span>{t('health_page.last_seen')}:</span>
            <span className="font-mono text-slate-200">{formatDate(currentDev.last_seen)}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>{t('health_page.status_changed')}:</span>
            <span className="font-mono text-slate-200">{formatDate(currentDev.status_changed_at)}</span>
          </div>
          {currentDev.ip_changed_at && (
            <div className="flex justify-between text-slate-400">
              <span>{t('health_page.ip_changed')}:</span>
              <span className="font-mono text-slate-200">{formatDate(currentDev.ip_changed_at)}</span>
            </div>
          )}
        </div>

        {/* Device Incident History */}
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <Clock size={14} className="text-sky-400" />
            {t('health_page.drawer_history')}
          </h3>
          <IncidentTimeline incidents={isMatchingDetail ? detailData.incidents : []} layout="list" />
        </div>
      </div>
    </div>
  );
};
