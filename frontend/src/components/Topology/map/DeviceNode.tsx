import React, { useMemo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Activity, Box, Cpu, Layers, Monitor, Radio, Server, Smartphone, Wifi, type LucideIcon } from 'lucide-react';
import { parseTopologyConfig, signalAnchor, signalStrength } from './graph';

/* eslint-disable @typescript-eslint/no-explicit-any -- node data is the device payload plus layout fields */

const KIND_ICONS: { match: (d: any) => boolean; Icon: LucideIcon; color: string }[] = [
  { match: (d) => d.is_ap, Icon: Radio, color: 'text-amber-400' },
  { match: (d) => d.virtual_type === 'docker', Icon: Box, color: 'text-cyan-400' },
  { match: (d) => d.virtual_type === 'vm', Icon: Monitor, color: 'text-emerald-400' },
  { match: (d) => d.is_wlan, Icon: Smartphone, color: 'text-sky-400' },
];

/** Access point, container, VM, WLAN client or server icon for a device. */
export function DeviceIcon({ data, size, baseClass, serverColor }: { data: any; size: number; baseClass?: string; serverColor?: string }) {
  const kind = KIND_ICONS.find((k) => k.match(data));
  const Icon = kind?.Icon ?? Server;
  const color = kind?.color ?? serverColor;
  const className = [baseClass, color].filter(Boolean).join(' ');
  return <Icon size={size} className={className || undefined} />;
}

/** Signal bars towards the nearest access point. */
function WlanSignal({ data }: { data: any }) {
  const dx = data.nearest_ap.x - data.x;
  const dy = data.nearest_ap.y - data.y;
  const strength = signalStrength(Math.sqrt(dx * dx + dy * dy));

  return (
    <div className="wlan-signals" style={{
      position: 'absolute',
      ...signalAnchor(dx, dy),
      display: 'flex',
      gap: '2px',
      alignItems: 'flex-end',
      height: '24px',
      pointerEvents: 'none',
      zIndex: 10,
      padding: '4px',
      background: 'rgba(15, 23, 42, 0.9)',
      borderRadius: '4px',
      border: '1px solid rgba(56, 189, 248, 0.2)',
    }}>
      {[1, 2, 3, 4].map(i => {
        const isActive = i <= strength;
        return (
          <div key={i} className="signal-bar" style={{
            width: '4px',
            height: `${i * 25}%`,
            background: isActive ? '#38bdf8' : 'rgba(255,255,255,0.1)',
            borderRadius: '1px',
            opacity: isActive ? 0.4 + (i * 0.15) : 0.2,
            boxShadow: isActive ? '0 0 8px rgba(56, 189, 248, 0.4)' : 'none',
            animation: 'none'
          }} />
        );
      })}
    </div>
  );
}

function NodeMetrics({ metrics }: { metrics: any }) {
  const ram = metrics.ram?.percent || 0;
  return (
    <div className="node-metrics">
      <div className="metric-item">
        <Cpu size={10} />
        <div className="metric-bar-bg">
          <div className="metric-bar-fill cpu" style={{ width: `${metrics.cpu_percent}%` }} />
        </div>
        <span>{Math.round(metrics.cpu_percent)}%</span>
      </div>
      <div className="metric-item">
        <Activity size={10} />
        <div className="metric-bar-bg">
          <div className="metric-bar-fill ram" style={{ width: `${ram}%` }} />
        </div>
        <span>{Math.round(ram)}%</span>
      </div>
    </div>
  );
}

const accepts = (handleType: string, type: 'target' | 'source') => handleType === type || handleType === 'both';

/** Connection points per side, as set in the device's topology config. */
function NodeHandles({ topologyConfig }: { topologyConfig: string | null | undefined }) {
  const config = useMemo(() => parseTopologyConfig(topologyConfig), [topologyConfig]);
  const top = config.top_handle_type || 'target';
  const bottom = config.bottom_handle_type || 'source';
  return (
    <>
      {accepts(top, 'target') && <Handle type="target" position={Position.Top} className="node-handle top target" id="top-target" />}
      {accepts(top, 'source') && <Handle type="source" position={Position.Top} className="node-handle top source" id="top-source" />}
      {accepts(bottom, 'target') && <Handle type="target" position={Position.Bottom} className="node-handle bottom target" id="bottom-target" />}
      {accepts(bottom, 'source') && <Handle type="source" position={Position.Bottom} className="node-handle bottom source" id="bottom-source" />}
    </>
  );
}

export const DeviceNode = React.memo(({ data, selected }: NodeProps) => {
  const isOnline = data.is_online;

  return (
    <div className={`topology-node ${isOnline ? 'online' : 'offline'} ${selected ? 'selected' : ''}`}>
      <div className="node-header">
        <div className="node-icon-container">
          <DeviceIcon data={data} size={18} baseClass="node-icon" />
          <div className={`status-indicator ${isOnline ? 'active' : 'inactive'}`} />
          {data.is_wlan && <Wifi size={10} className="wlan-badge" />}
        </div>
        <div className="node-title-area">
          <div className="node-label">{data.label}</div>
          <div className="node-sublabel">{data.ip}</div>
        </div>
        <div className="node-actions">
           {data.is_host && (
             <div className="host-badge" title="Physical Host System">
               <Server size={10} />
               <span>HOST</span>
             </div>
           )}
           {data.has_agent && <Activity size={12} className="text-sky-400" />}
        </div>
      </div>

      {data.parent_name && (
        <div className="node-parent-info">
          <Layers size={10} />
          <span>On: {data.parent_name}</span>
        </div>
      )}

      {data.is_wlan && data.nearest_ap && <WlanSignal data={data} />}
      {data.has_agent && data.metrics && <NodeMetrics metrics={data.metrics} />}

      <NodeHandles topologyConfig={data.topology_config} />

      {/* Port status indicator if max_ports is set */}
      {data.max_ports > 0 && (
        <div className="port-count">
          <Layers size={8} /> {data.link_count || 0} / {data.max_ports} Ports
        </div>
      )}
    </div>
  );
});
