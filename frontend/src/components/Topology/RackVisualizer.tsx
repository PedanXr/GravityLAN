import React, { useState, useEffect } from 'react';
import { Loader2, Plus, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Device, Rack } from '../../types';

interface RackVisualizerProps {
  devices: Device[];
}

interface RackSlot {
  unit: number;
  device?: Device;
}

const heightOf = (d: Device) => d.rack_height || 1;
const nameOf = (d: Device) => d.display_name || d.hostname || d.ip;
const dotClass = (d: Device) => `status-dot ${d.is_online ? 'status-dot--online' : 'status-dot--offline'}`;

/** One slot per height unit, top unit first; units covered by a taller device above are left out. */
function rackSlots(units: number, rackDevices: Device[]): RackSlot[] {
  const slots: RackSlot[] = [];
  for (let unit = units; unit >= 1; unit--) {
    const device = rackDevices.find((d) => d.rack_unit === unit);
    const isCovered = rackDevices.some((d) =>
      d.rack_unit !== null && d.rack_unit > unit && (d.rack_unit - heightOf(d) < unit)
    );
    if (device || !isCovered) slots.push({ unit, device });
  }
  return slots;
}

/** Racks from the API, the selected one, and creating a default rack when there is none. */
function useRacks() {
  const [racks, setRacks] = useState<Rack[]>([]);
  const [selectedRack, setSelectedRack] = useState<Rack | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadRacks = async () => {
      try {
        const data = await api.getRacks();
        const list = Array.isArray(data) ? data : [];
        setRacks(list);
        if (list.length > 0) setSelectedRack(list[0]);
      } catch (err) {
        console.error('Failed to load racks:', err);
      } finally {
        setIsLoading(false);
      }
    };
    loadRacks();
  }, []);

  const createDefaultRack = async () => {
    setIsLoading(true);
    try {
      const data = await api.createRack({ name: 'Main Rack', units: 42, width: 19 });
      setRacks([data]);
      setSelectedRack(data);
    } catch (err) {
      console.error('Failed to create default rack:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return { racks, selectedRack, setSelectedRack, isLoading, createDefaultRack };
}

const RackVisualizer: React.FC<RackVisualizerProps> = ({ devices }) => {
  const { t } = useTranslation();
  const { racks, selectedRack, setSelectedRack, isLoading, createDefaultRack } = useRacks();

  if (isLoading) return (
    <div className="rack-state" role="status">
      <Loader2 size={18} className="animate-spin" aria-hidden="true" /> {t('rack.loading')}
    </div>
  );

  if (!selectedRack) return (
    <div className="rack-state rack-state--empty">
      <span className="setup-features__icon" aria-hidden="true"><Server size={18} /></span>
      <h2>{t('rack.empty_title')}</h2>
      <p>{t('rack.empty_desc')}</p>
      <button type="button" className="btn btn-primary" onClick={createDefaultRack}>
        <Plus size={16} aria-hidden="true" /> {t('rack.create_default')}
      </button>
    </div>
  );

  const rackDevices = (Array.isArray(devices) ? devices : []).filter((d) => d.rack_id === selectedRack.id);

  return (
    <div className="rack-view">
      <header className="rack-view__header">
        <div>
          <h2 className="rack-view__title">{selectedRack.name}</h2>
          <p className="rack-view__meta">{t('rack.meta', { width: selectedRack.width, units: selectedRack.units })}</p>
        </div>
        {racks.length > 1 && (
          <div className="segmented" role="group" aria-label={t('rack.select_rack')}>
            {racks.map((r) => (
              <button
                key={r.id}
                type="button"
                className="segmented__option"
                aria-pressed={selectedRack.id === r.id}
                onClick={() => setSelectedRack(r)}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="rack-view__body">
        <RackFrame rack={selectedRack} rackDevices={rackDevices} />
        <RackSide rack={selectedRack} rackDevices={rackDevices} />
      </div>
    </div>
  );
};

/** The rack: one row per height unit, top unit first; a device spans rack_height rows. */
function RackFrame({ rack, rackDevices }: { rack: Rack; rackDevices: Device[] }) {
  const { t } = useTranslation();
  return (
    <div className="rack-frame" role="list" aria-label={rack.name}>
      {rackSlots(rack.units, rackDevices).map(({ unit, device }) => {
        if (!device) {
          return (
            <div key={unit} className="rack-unit" aria-hidden="true">
              <span className="rack-unit__number">{unit}</span>
            </div>
          );
        }
        const height = heightOf(device);
        return (
          <div
            key={unit}
            role="listitem"
            className="rack-device"
            style={{ height: `calc(${height} * var(--rack-unit-height))` }}
          >
            <span className="rack-unit__number">{unit}</span>
            <span className={dotClass(device)} aria-hidden="true" />
            <span className="rack-device__text">
              <span className="rack-device__name">{nameOf(device)}</span>
              <span className="rack-device__meta">{device.ip} · {t('rack.units', { count: height })}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Occupancy and the rack's devices from the top down. */
function RackSide({ rack, rackDevices }: { rack: Rack; rackDevices: Device[] }) {
  const { t } = useTranslation();
  const occupied = rackDevices.reduce((acc, d) => acc + heightOf(d), 0);
  const inventory = [...rackDevices].sort((a, b) => (b.rack_unit || 0) - (a.rack_unit || 0));

  return (
    <aside className="rack-side">
      <dl className="setup-scan__stats">
        <div>
          <dt>{t('rack.occupied')}</dt>
          <dd>{occupied} <span className="rack-side__of">/ {rack.units}</span></dd>
        </div>
        <div>
          <dt>{t('rack.devices')}</dt>
          <dd>{rackDevices.length}</dd>
        </div>
      </dl>

      <h3 className="rack-side__title">{t('rack.inventory')}</h3>
      {inventory.length === 0 ? (
        <p className="settings-empty">{t('rack.inventory_empty')}</p>
      ) : (
        <ul className="settings-list">
          {inventory.map((d) => (
            <li key={d.id} className="settings-list__row">
              <span className="rack-side__device">
                <span
                  className={dotClass(d)}
                  role="img"
                  aria-label={d.is_online ? t('network.online') : t('network.offline')}
                />
                <span className="settings-list__name">{nameOf(d)}</span>
              </span>
              <span className="device-tag">{t('rack.position', { unit: d.rack_unit, count: heightOf(d) })}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export default RackVisualizer;
