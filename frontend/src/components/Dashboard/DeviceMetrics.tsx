import { useState, useEffect, useRef, type ReactNode } from 'react';
import { api, createMetricsSocket } from '../../api/client';
import { Cpu, MemoryStick, HardDrive, Thermometer, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MetricsData {
  cpu_percent: number;
  ram: { used_mb: number; total_mb: number; percent: number };
  disk: { path: string; total_gb: number; used_gb: number; percent: number }[];
  temperature: number | null;
  network: Record<string, { rx_bytes_sec: number; tx_bytes_sec: number }>;
  timestamp: string;
}

interface DeviceMetricsProps {
  deviceId: number;
  compact?: boolean;
  onUpdate?: (metrics: MetricsData) => void;
}

/** Mini progress bar for inline metrics display. */
function MiniBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div style={{
      width: '100%', height: 4, background: 'rgba(255,255,255,0.06)',
      borderRadius: 2, overflow: 'hidden'
    }}>
      <div style={{
        width: `${Math.min(percent, 100)}%`, height: '100%',
        background: color,
        borderRadius: 2,
        transition: 'width 0.5s ease'
      }} />
    </div>
  );
}

/** Determine color based on utilization percentage. */
function utilizationColor(percent: number): string {
  if (percent >= 90) return '#ef4444';
  if (percent >= 70) return '#f59e0b';
  return '#10b981';
}

/** Determine color based on temperature. */
function tempColor(temp: number): string {
  if (temp >= 80) return '#ef4444';
  if (temp >= 60) return '#f59e0b';
  return '#10b981';
}

/** Format bytes per second to human-readable string. */
function formatBps(bytesPerSec: number): string {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_000) return `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

type RawSample = Partial<MetricsData> & {
  ram_used_mb?: number; ram_total_mb?: number; ram_percent?: number;
  disk_json?: string | null; net_json?: string | null;
};

const parseJson = (raw: string | null | undefined) => {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};

/**
 * Bring a metrics sample into one shape: live WebSocket/agent payloads are
 * nested (`ram.percent`, `disk[]`), stored history rows can be flat
 * (`ram_percent`, `disk_json`).
 */
function toMetricsData(sample: RawSample | null | undefined): MetricsData {
  if (sample?.ram) return sample as MetricsData;
  return {
    cpu_percent: sample?.cpu_percent ?? 0,
    ram: { used_mb: sample?.ram_used_mb ?? 0, total_mb: sample?.ram_total_mb ?? 0, percent: sample?.ram_percent ?? 0 },
    disk: parseJson(sample?.disk_json) ?? [],
    temperature: sample?.temperature ?? null,
    network: parseJson(sample?.net_json) ?? {},
    timestamp: sample?.timestamp ?? '',
  };
}

/** WebSocket messages are wrapped: { type: 'metrics', data: { ... } } */
function unwrap(msg: { type?: string; data?: RawSample } & RawSample): RawSample {
  return msg && msg.type === 'metrics' && msg.data ? msg.data : msg;
}

/** Accent while normal; amber/red only when a threshold is crossed. */
function meterColor(value: number, warnAt: number, dangerAt: number): string {
  if (value >= dangerAt) return 'var(--accent-danger)';
  if (value >= warnAt) return 'var(--accent-warning)';
  return 'var(--accent-primary)';
}

/**
 * Metrics of an active agent: the last stored sample first, then live values
 * from the metrics socket. Null while there is no active agent or no sample.
 */
function useLiveMetrics(deviceId: number, onUpdate?: (metrics: MetricsData) => void) {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [isAgentActive, setIsAgentActive] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadLatest = async () => {
      try {
        const history = await api.getAgentMetrics(deviceId, 1);
        if (history.snapshots.length > 0 && mounted) {
          setMetrics(toMetricsData(history.snapshots[history.snapshots.length - 1] as RawSample));
        }
      } catch { /* metrics not available yet */ }
    };

    const follow = () => {
      try {
        wsRef.current = createMetricsSocket(deviceId, (msg) => {
          if (!mounted) return;
          const snapshot = toMetricsData(unwrap(msg));
          setMetrics(snapshot);
          onUpdate?.(snapshot);
        });
      } catch { /* WebSocket unavailable */ }
    };

    api.getAgentStatus(deviceId)
      .then(async (status) => {
        if (!mounted) return;
        setIsAgentActive(status.is_active);
        if (!status.is_active) return;
        await loadLatest();
        follow();
      })
      .catch(() => { if (mounted) setIsAgentActive(false); });

    return () => {
      mounted = false;
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, [deviceId]);

  return isAgentActive ? metrics : null;
}

/**
 * Real-time device metrics overlay for DeviceCards.
 */
export function DeviceMetrics({ deviceId, compact = true, onUpdate }: DeviceMetricsProps) {
  const metrics = useLiveMetrics(deviceId, onUpdate);
  if (!metrics) return null;
  return compact ? <CompactMetrics metrics={metrics} /> : <ExpandedMetrics metrics={metrics} />;
}

interface MeterItem { key: string; label: string; percent: number; text: string; color: string }

function compactItems(metrics: MetricsData, t: (key: string) => string): MeterItem[] {
  // Show the fullest disk: that is the one worth noticing on a card.
  const fullestDisk = (metrics.disk || []).reduce<MetricsData['disk'][number] | null>(
    (max, d) => (!max || (d.percent ?? 0) > (max.percent ?? 0) ? d : max), null);
  const cpu = metrics.cpu_percent ?? 0;
  const ram = metrics.ram?.percent ?? 0;
  const items: MeterItem[] = [
    { key: 'cpu', label: t('agent.cpu'), percent: cpu, text: `${cpu.toFixed(0)} %`, color: meterColor(cpu, 80, 95) },
    { key: 'ram', label: t('agent.ram'), percent: ram, text: `${ram.toFixed(0)} %`, color: meterColor(ram, 85, 95) },
  ];
  if (fullestDisk) {
    const pct = fullestDisk.percent ?? 0;
    items.push({ key: 'disk', label: t('agent.disk'), percent: pct, text: `${pct.toFixed(0)} %`, color: meterColor(pct, 85, 95) });
  }
  if (metrics.temperature != null) {
    items.push({
      key: 'temp', label: t('agent.temp_short'), percent: Math.min(metrics.temperature, 100),
      text: `${metrics.temperature.toFixed(0)} °C`, color: meterColor(metrics.temperature, 70, 85),
    });
  }
  return items;
}

function CompactMetrics({ metrics }: { metrics: MetricsData }) {
  const { t } = useTranslation();
  return (
    <div className="metric-grid">
      {compactItems(metrics, t).map((m) => (
        <div key={m.key} className="metric">
          <div className="metric__head">
            <span>{m.label}</span>
            <span className="metric__value" style={{ color: m.color === 'var(--accent-primary)' ? undefined : m.color }}>{m.text}</span>
          </div>
          <div className="metric__track" role="meter" aria-label={m.label} aria-valuenow={Math.round(m.percent)} aria-valuemin={0} aria-valuemax={100} aria-valuetext={m.text}>
            <div className="metric__fill" style={{ width: `${Math.min(m.percent, 100)}%`, background: m.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const LABEL_STYLE = { display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: 'var(--text-secondary)' } as const;
const VALUE_STYLE = { fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' } as const;

/** Label and value above a utilization bar. */
function BarRow({ label, value, percent }: { label: ReactNode; value: ReactNode; percent: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={LABEL_STYLE}>{label}</span>
        {value}
      </div>
      <MiniBar percent={percent} color={utilizationColor(percent)} />
    </div>
  );
}

function ExpandedMetrics({ metrics }: { metrics: MetricsData }) {
  const { t } = useTranslation();
  const cpu = metrics.cpu_percent ?? 0;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: '12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)',
      width: '100%'
    }}>
      <BarRow
        label={<><Cpu size={13} /> {t('agent.cpu')}</>}
        value={<span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', fontWeight: 700, color: utilizationColor(cpu) }}>{cpu.toFixed(1)}%</span>}
        percent={cpu}
      />

      {metrics.ram && (
        <BarRow
          label={<><MemoryStick size={13} /> {t('agent.ram')}</>}
          value={<span style={VALUE_STYLE}>{((metrics.ram.used_mb || 0) / 1024).toFixed(1)} / {((metrics.ram.total_mb || 0) / 1024).toFixed(1)} GB</span>}
          percent={metrics.ram.percent ?? 0}
        />
      )}

      {(metrics.disk || []).map((d) => (
        <BarRow
          key={d.path}
          label={<><HardDrive size={13} /> {d.path}</>}
          value={<span style={VALUE_STYLE}>{d.used_gb ?? 0} / {d.total_gb ?? 0} GB</span>}
          percent={d.percent ?? 0}
        />
      ))}

      {metrics.temperature != null && <TemperatureRow temperature={metrics.temperature} />}
      {metrics.network && Object.keys(metrics.network).length > 0 && <NetworkRows network={metrics.network} />}
    </div>
  );
}

function TemperatureRow({ temperature }: { temperature: number }) {
  const { t } = useTranslation();
  const color = tempColor(temperature);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={LABEL_STYLE}>
        <Thermometer size={13} /> {t('agent.temperature')}
      </span>
      <span style={{
        fontSize: '0.85rem', fontWeight: 700, fontFamily: 'var(--font-mono)',
        color,
        padding: '2px 8px', borderRadius: 6,
        background: `${color}15`
      }}>
        {temperature.toFixed(1)}°C
      </span>
    </div>
  );
}

function NetworkRows({ network }: { network: MetricsData['network'] }) {
  const { t } = useTranslation();
  return (
    <div>
      <span style={{ ...LABEL_STYLE, marginBottom: 4 }}>
        <Activity size={13} /> {t('agent.network')}
      </span>
      {Object.entries(network).map(([iface, data]) => (
        <div key={iface} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
          <span>{iface}</span>
          <span>↓{formatBps(data?.rx_bytes_sec ?? 0)} ↑{formatBps(data?.tx_bytes_sec ?? 0)}</span>
        </div>
      ))}
    </div>
  );
}
