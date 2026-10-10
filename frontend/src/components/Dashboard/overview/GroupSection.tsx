import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import type { Device, DeviceGroup } from '../../../types';
import { DeviceCard } from '../DeviceCard';
import { DeviceList } from '../DeviceList';
import { gridItemAttrs } from './layout';

interface GroupSectionProps {
  /** null renders the "unassigned devices" section */
  group: DeviceGroup | null;
  devices: Device[];
  isFirst: boolean;
  isLast: boolean;
  isCollapsed: boolean;
  isEditMode: boolean;
  viewMode: 'grid' | 'list';
  selectedIds: Set<number>;
  onToggle: () => void;
  onMove: (direction: 'up' | 'down') => void;
  onSelect: (id: number, selected: boolean) => void;
  onEdit: (device: Device) => void;
  onRefresh: () => void;
}

export function GroupSection({
  group, devices, isFirst, isLast, isCollapsed, isEditMode, viewMode, selectedIds,
  onToggle, onMove, onSelect, onEdit, onRefresh,
}: GroupSectionProps) {
  const { t } = useTranslation();
  const groupId = group ? group.id : 'null';
  const move = (e: MouseEvent, direction: 'up' | 'down') => {
    e.stopPropagation();
    onMove(direction);
  };

  return (
    <div className="group-section">
      <div
        className="group-section__header"
        onClick={onToggle}
        style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center' }}
      >
        {isCollapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
        <h2 className="group-section__title" style={{ flexGrow: 1, margin: 0 }}>
          {group ? group.name : t('dashboard.unassigned_devices')}
        </h2>

        {isEditMode && group && (
          <div style={{ display: 'flex', gap: '4px', marginRight: 'var(--space-md)' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => move(e, 'up')}
              disabled={isFirst}
              style={{ padding: '4px' }}
              title={t('dashboard.move_group_up')}
            >
              <ChevronUp size={16} />
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={(e) => move(e, 'down')}
              disabled={isLast}
              style={{ padding: '4px' }}
              title={t('dashboard.move_group_down')}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        )}

        <span className="group-section__count">{devices.length}</span>
        {isCollapsed && (
          <div style={{ marginLeft: 'var(--space-md)', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
            {t('dashboard.click_to_expand')}
          </div>
        )}
      </div>

      {!isCollapsed && (viewMode === 'grid' ? (
        <div
          className={`grid-stack grid-stack-${groupId} ${isEditMode ? 'is-editing' : ''}`}
          style={{ minHeight: devices.length > 0 ? '140px' : '0' }}
        >
          {devices.map((device) => {
            const tile = gridItemAttrs(device);
            return (
              <div
                key={device.id}
                className="grid-stack-item"
                gs-id={device.id}
                gs-x={tile.x}
                gs-y={tile.y}
                gs-w={tile.w}
                gs-h={tile.h}
                gs-min-h={2}
                gs-min-w={2}
                gs-auto-position={tile.autoPosition ? 'true' : undefined}
              >
                <div className="grid-stack-item-content">
                  <DeviceCard
                    device={device}
                    isEditMode={isEditMode}
                    isSelected={selectedIds.has(device.id)}
                    onSelect={(selected) => onSelect(device.id, selected)}
                    onRefresh={onRefresh}
                    onEdit={(e) => {
                      e.stopPropagation();
                      onEdit(device);
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <DeviceList devices={devices} onEdit={onEdit} />
      ))}
    </div>
  );
}
