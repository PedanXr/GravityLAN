import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Layers, Sliders, Wind, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';

/** Particle speed, particles per link and sticky drag, stored in the settings. */
export function useFlowSettings() {
  const [speed, setSpeed] = useState(1.0);
  const [intensity, setIntensity] = useState(2);
  const [stickyDrag, setStickyDrag] = useState(false);

  useEffect(() => {
    const loadFlowSettings = async () => {
      try {
        const settings = await api.getSettings();
        if (settings['topology.flow_speed']) setSpeed(parseFloat(settings['topology.flow_speed']));
        if (settings['topology.flow_intensity']) setIntensity(parseInt(settings['topology.flow_intensity']));
        if (settings['topology.sticky_drag']) setStickyDrag(settings['topology.sticky_drag'] === 'true');
      } catch (err) {
        console.error('Failed to load flow settings:', err);
      }
    };
    loadFlowSettings();
  }, []);

  const saveFlowSetting = useCallback(async (key: string, value: number | boolean) => {
    try {
      await api.updateSettings({ [key]: value.toString() });
    } catch (err) {
      console.error(`Failed to save flow setting ${key}:`, err);
    }
  }, []);

  return {
    speed,
    intensity,
    stickyDrag,
    changeSpeed: (val: number) => { setSpeed(val); saveFlowSetting('topology.flow_speed', val); },
    changeIntensity: (val: number) => { setIntensity(val); saveFlowSetting('topology.flow_intensity', val); },
    changeStickyDrag: (val: boolean) => { setStickyDrag(val); saveFlowSetting('topology.sticky_drag', val); },
  };
}

export type FlowSettings = ReturnType<typeof useFlowSettings>;

interface FlowRangeProps {
  icon: ReactNode;
  label: string;
  value: number;
  min: string;
  max: string;
  step: string;
  onChange: (val: number) => void;
}

const FlowRange = ({ icon, label, value, min, max, step, onChange }: FlowRangeProps) => (
  <div className="flow-control-item">
    <div className="flow-control-item__label">
      {icon}
      <span>{label}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  </div>
);

/** Collapsible overlay with the data flow animation settings; open by default on wide screens. */
export function FlowControls({ settings }: { settings: FlowSettings }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(window.innerWidth > 768);

  return (
    <div className={`flow-controls ${!isExpanded ? 'collapsed' : ''}`}>
      <div className="flow-controls__header" onClick={() => setIsExpanded(!isExpanded)} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
          <Sliders size={14} aria-hidden="true" />
          <span>{t('topology.flow_title')}</span>
        </div>
        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </div>

      {isExpanded && (
        <>
          <FlowRange
            icon={<Zap size={12} />}
            label={`Speed: ${settings.speed.toFixed(1)}x`}
            value={settings.speed}
            min="0.1"
            max="3.0"
            step="0.1"
            onChange={settings.changeSpeed}
          />

          <FlowRange
            icon={<Wind size={12} />}
            label={`Intensity: ${settings.intensity}`}
            value={settings.intensity}
            min="0"
            max="5"
            step="1"
            onChange={settings.changeIntensity}
          />

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 0',
            borderTop: '1px solid rgba(255,255,255,0.05)',
            marginTop: '4px'
          }}>
            <div className="flow-control-item__label">
              <Layers size={12} />
              <span>Sticky Drag</span>
            </div>
            <input
              type="checkbox"
              checked={settings.stickyDrag}
              onChange={(e) => settings.changeStickyDrag(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
          </div>

          {settings.intensity === 0 && (
            <div style={{ fontSize: '9px', color: '#64748b', textAlign: 'center', marginTop: '2px' }}>
              Animations Disabled
            </div>
          )}
        </>
      )}
    </div>
  );
}
