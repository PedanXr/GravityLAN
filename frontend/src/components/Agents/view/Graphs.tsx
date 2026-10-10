import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { History, LineChart, RefreshCw, X } from 'lucide-react';
import { api } from '../../../api/client';

export interface GraphPoint {
  value: number;
  timestamp: string;
}

interface GraphSeries {
  data: GraphPoint[];
  color: string;
  label: string;
}

/** Index of the sample under the pointer for a chart that spans the element's width. */
function hoverIndex(e: MouseEvent, el: HTMLElement | null, count: number, padLeft = 0, usable = 1): number | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const relX = e.clientX - rect.left - padLeft * rect.width;
  const pct = Math.max(0, Math.min(1, relX / (usable * rect.width)));
  return Math.round(pct * (count - 1));
}

/** Several percentage series in one 0–100 chart with a shared hover tooltip. */
function MultiGraph({ series }: { series: GraphSeries[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!series[0]?.data.length) return null;
  const count = series[0].data.length;
  const xOf = (i: number) => (i / (count - 1)) * 100;
  const hovered = hoverIdx !== null ? series[0].data[hoverIdx] : undefined;

  return (
    <div
      className="relative h-full w-full group cursor-crosshair"
      ref={containerRef}
      onMouseMove={(e) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        setHoverIdx(Math.round(((e.clientX - rect.left) / rect.width) * (count - 1)));
      }}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {series.map((s, idx) => {
          const points = s.data.map((d, i) => `${(i / (s.data.length - 1)) * 100},${100 - d.value}`).join(' ');
          return (
            <Fragment key={idx}>
              <defs>
                <linearGradient id={`grad-global-${idx}`} x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.1" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`M 0,100 L ${points} L 100,100 Z`} fill={`url(#grad-global-${idx})`} />
              <path d={`M ${points}`} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
            </Fragment>
          );
        })}

        {hoverIdx !== null && hovered && (
          <line x1={xOf(hoverIdx)} y1="0" x2={xOf(hoverIdx)} y2="100" stroke="white" strokeOpacity="0.2" strokeWidth="0.5" />
        )}
      </svg>

      {/* Global Tooltip */}
      {hoverIdx !== null && hovered && (
        <div
          className="absolute z-[110] bg-slate-900 border border-white/20 p-3 rounded-lg shadow-2xl pointer-events-none min-w-[120px]"
          style={{ left: `${Math.min(xOf(hoverIdx), 80)}%`, top: '0%', transform: 'translateY(-110%)' }}
        >
          <div className="text-xs text-slate-400 mb-1.5 border-b border-white/5 pb-1">
            {new Date(hovered.timestamp).toLocaleString([], { hour: '2-digit', minute: '2-digit' })}
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

interface GlobalPoint { avg_cpu: number; avg_ram: number; data_points?: number; timestamp: string }

/** Average CPU/RAM of all agents over the last 24 hours. */
export function GlobalMetricsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<GlobalPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getGlobalMetrics()
      .then((res) => setHistory(Array.isArray(res.history) ? res.history as GlobalPoint[] : []))
      .catch((err) => console.error('Failed to load global metrics:', err))
      .finally(() => setLoading(false));
  }, []);

  // Escape closes the dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
            <GlobalMetricsBody history={history} />
          )}
        </div>
      </div>
    </div>
  );
}

function GlobalMetricsBody({ history }: { history: GlobalPoint[] }) {
  const { t } = useTranslation();
  const average = (key: 'avg_cpu' | 'avg_ram') =>
    history.reduce((sum, h) => sum + (h[key] || 0), 0) / (history.length || 1);
  const peakSamples = history.reduce((max, h) => Math.max(max, h.data_points || 0), 0);
  return (
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
  );
}

export function GraphPanel({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: string; children: ReactNode }) {
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

const PAD = { L: 38, R: 10, T: 10, B: 24 }; // room for the Y labels (left) and X labels (bottom)
const MARGIN = 0.05; // keep the line off the top and bottom edge

/** Axis labels by the span of the data: times within a day, day + time within a week, else days. */
function timeLabel(ts: string, spanHours: number, withSeconds = false): string {
  const d = new Date(ts);
  if (spanHours <= 26) return d.toLocaleTimeString([], withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  if (spanHours <= 180 || withSeconds) return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: '2-digit' });
}

function graphScale(data: GraphPoint[], W: number, H: number, max: number) {
  const chartW = W - PAD.L - PAD.R;
  const chartH = H - PAD.T - PAD.B;
  const mapY = (v: number) => PAD.T + chartH - ((Math.min(v, max) / max) * (1 - 2 * MARGIN) + MARGIN) * chartH;
  const mapX = (i: number) => PAD.L + (i / Math.max(data.length - 1, 1)) * chartW;
  const pts = data.map((d, i) => `${mapX(i).toFixed(1)},${mapY(d.value).toFixed(1)}`);
  const vals = data.map(d => d.value);
  return {
    chartW, chartH, mapX, mapY,
    lineD: `M ${pts.join(' L ')}`,
    areaD: `M ${PAD.L},${PAD.T + chartH} L ${pts.join(' L ')} L ${PAD.L + chartW},${PAD.T + chartH} Z`,
    min: Math.min(...vals),
    max: Math.max(...vals),
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    spanHours: (new Date(data[data.length - 1].timestamp).getTime() - new Date(data[0].timestamp).getTime()) / 3_600_000,
  };
}

/** One metric over time: min/avg/max pills, a filled line on a 0–max axis and a hover readout. */
export function DetailGraph({ data, color, label, suffix, max = 100 }: {
  data: GraphPoint[];
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

  const { w: W, h: H } = size;
  const g = graphScale(data, W, H, max);
  const gradId = `dg-grad-${label}`;
  const clipId = `dg-clip-${label}`;
  const yTicks = [0, 25, 50, 75, 100].filter(tick => tick <= max);
  const hov = hoverIdx !== null ? data[hoverIdx] : null;
  const pill = { background: `${color}18`, color };

  return (
    <div className="relative w-full h-full flex flex-col gap-2">
      {/* Stats pill row */}
      <div className="flex gap-2 text-xs font-medium">
        <span className="px-2 py-0.5 rounded" style={pill}>Min {g.min.toFixed(1)}{suffix}</span>
        <span className="px-2 py-0.5 rounded bg-white/5 text-slate-400">Ø {g.avg.toFixed(1)}{suffix}</span>
        <span className="px-2 py-0.5 rounded" style={pill}>Max {g.max.toFixed(1)}{suffix}</span>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 cursor-crosshair"
        onMouseMove={(e) => setHoverIdx(hoverIndex(e, containerRef.current, data.length, PAD.L / W, g.chartW / W))}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor={color} stopOpacity="0.5" />
              <stop offset="70%" stopColor={color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
            <clipPath id={clipId}>
              <rect x={PAD.L} y={PAD.T} width={g.chartW} height={g.chartH} />
            </clipPath>
          </defs>

          {/* Y-axis ticks + grid lines */}
          {yTicks.map(tick => {
            const y = g.mapY(tick);
            return (
              <Fragment key={tick}>
                <line
                  x1={PAD.L} y1={y} x2={PAD.L + g.chartW} y2={y}
                  stroke="white" strokeOpacity={tick === 0 ? 0.12 : 0.05} strokeWidth="1"
                  strokeDasharray={tick === 0 ? 'none' : '4,4'}
                />
                <text x={PAD.L - 6} y={y + 4} textAnchor="end" fontSize={11} fill="rgba(148,163,184,0.6)" fontFamily="monospace">
                  {tick}
                </text>
              </Fragment>
            );
          })}

          {/* AVG line */}
          <line
            x1={PAD.L} y1={g.mapY(g.avg)} x2={PAD.L + g.chartW} y2={g.mapY(g.avg)}
            stroke={color} strokeOpacity="0.25" strokeWidth="1" strokeDasharray="6,4"
            clipPath={`url(#${clipId})`}
          />

          <path d={g.areaD} fill={`url(#${gradId})`} clipPath={`url(#${clipId})`} />
          <path d={g.lineD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" clipPath={`url(#${clipId})`} />

          {/* X-axis labels: first and last timestamp */}
          <text x={PAD.L} y={H - 6} fontSize={11} fill="rgba(100,116,139,0.7)" fontFamily="monospace">
            {timeLabel(data[0].timestamp, g.spanHours)}
          </text>
          <text x={PAD.L + g.chartW} y={H - 6} fontSize={11} fill="rgba(100,116,139,0.7)" fontFamily="monospace" textAnchor="end">
            {timeLabel(data[data.length - 1].timestamp, g.spanHours)}
          </text>

          {/* Hover crosshair */}
          {hov && hoverIdx !== null && (
            <>
              <line
                x1={g.mapX(hoverIdx)} y1={PAD.T} x2={g.mapX(hoverIdx)} y2={PAD.T + g.chartH}
                stroke="white" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3,3"
              />
              <circle cx={g.mapX(hoverIdx)} cy={g.mapY(hov.value)} r="5" fill={color} stroke="white" strokeWidth="2" />
            </>
          )}
        </svg>

        {/* Floating tooltip */}
        {hov && hoverIdx !== null && (
          <div
            className="absolute z-50 pointer-events-none"
            style={{
              left: `${Math.min((g.mapX(hoverIdx) / W) * 100, 72)}%`,
              top: `${((g.mapY(hov.value) - PAD.T) / H) * 100}%`,
              transform: 'translate(12px, -50%)'
            }}
          >
            <div className="bg-slate-900/95 border border-white/20 backdrop-blur-sm px-3 py-2 rounded-lg shadow-2xl">
              <div className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-0.5">
                {timeLabel(hov.timestamp, g.spanHours, true)}
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
