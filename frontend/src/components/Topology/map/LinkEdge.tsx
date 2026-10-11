import React, { createContext, useContext } from 'react';
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from 'reactflow';
import { Trash2 } from 'lucide-react';
import { particleSeconds, speedColor } from './graph';

/** Particle speed multiplier and particles per link, set in the flow controls. */
export const FlowSettingsContext = createContext({
  speed: 1.0,
  intensity: 3,
});

/** Particles running along a wired, online link: a glow, a core and a white centre each. */
function Particles({ path, color, speed }: { path: string; color: string; speed: string }) {
  const { speed: globalSpeed, intensity } = useContext(FlowSettingsContext);
  const duration = `${particleSeconds(speed) / globalSpeed}s`;

  return (
    <>
      {Array.from({ length: intensity }).map((_, i) => {
        const begin = `${-(i * (parseFloat(duration) / intensity))}s`;
        const motion = <animateMotion dur={duration} repeatCount="indefinite" path={path} begin={begin} />;
        return (
          <React.Fragment key={i}>
            <circle r="4.5" fill={color} opacity="0.25">{motion}</circle>
            <circle r="3" fill={color} opacity="0.9">{motion}</circle>
            <circle r="1.5" fill="#fff" opacity="0.8">{motion}</circle>
          </React.Fragment>
        );
      })}
    </>
  );
}

export const LinkEdge = React.memo(({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
  selected,
}: EdgeProps) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetPosition,
    targetX,
    targetY,
  });

  const speed = data?.link_type || '1GbE';
  const isOnline = data?.source_online && data?.target_online;
  const color = speedColor(speed, isOnline);
  const { intensity } = useContext(FlowSettingsContext);

  return (
    <>
      <path
        style={{ fill: 'none', stroke: 'transparent', strokeWidth: 20 }}
        className="react-flow__edge-interaction"
        d={edgePath}
      />
      <path
        id={id}
        style={{
          ...style,
          stroke: color,
          strokeWidth: selected ? 4 : 2,
          strokeOpacity: selected ? 1 : (isOnline ? 0.6 : 0.3),
          strokeDasharray: data.is_wireless || !isOnline ? '5,5' : 'none',
          transition: 'stroke-width 0.2s, stroke-opacity 0.2s',
          shapeRendering: 'optimizeSpeed',
        }}
        className={`react-flow__edge-path ${selected ? 'selected' : ''}`}
        d={edgePath}
        markerEnd={markerEnd}
      />

      {/* Particle Animation (only if online and not wireless) */}
      {isOnline && !data.is_wireless && intensity > 0 && <Particles path={edgePath} color={color} speed={speed} />}

      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            fontSize: 10,
            pointerEvents: 'all',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            zIndex: 1000,
          }}
          className={`edge-label-container ${selected ? 'selected' : ''}`}
        >
          <div
            className="edge-speed-badge"
            style={{ backgroundColor: color, cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              data.onRotateSpeed(id, speed);
            }}
          >
            {speed}
          </div>
          {selected && (
             <button
                className="edge-delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onDeleteLink(id);
                }}
              >
                <Trash2 size={10} />
              </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
