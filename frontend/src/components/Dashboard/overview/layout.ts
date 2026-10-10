import type { Device, DeviceGroup } from '../../../types';

/** Group id as used in grid class names and the collapsed set; unassigned devices are 'null'. */
export type GroupKey = number | string;

export interface GridItemAttrs {
  x: number | undefined;
  y: number | undefined;
  w: number;
  h: number;
  autoPosition: boolean;
}

/**
 * Gridstack attributes for a device tile. Devices without a saved layout get a
 * size that fits their card: agent cards (2×2 metric grid) three per row, plain
 * cards (header + service chips) narrower and lower, one more row per extra row
 * of service chips.
 */
export function gridItemAttrs(device: Device): GridItemAttrs {
  let defaultW = 3;
  let defaultH = 3;
  if (device.has_agent) {
    defaultW = 4;
    defaultH = 5;
  }
  const chipsPerRow = device.has_agent ? 3 : 2;
  const chipRows = Math.ceil((device.services?.length || 0) / chipsPerRow);
  if (chipRows > 1) defaultH += chipRows - 1;

  const x = device.x !== null ? device.x : undefined;
  return {
    x,
    y: device.y !== null ? device.y : undefined,
    w: (device.w !== null && device.w !== undefined) ? device.w : defaultW,
    h: (device.h !== null && device.h !== undefined) ? device.h : defaultH,
    autoPosition: x === undefined,
  };
}

export interface GroupOrderChange {
  groups: DeviceGroup[];
  updates: { id: number; sort_order: number }[];
}

/** Swap a group with its neighbour; null at either end of the list. */
export function swapGroupOrder(groups: DeviceGroup[], group: DeviceGroup, direction: 'up' | 'down'): GroupOrderChange | null {
  const currentIndex = groups.findIndex(g => g.id === group.id);
  if (currentIndex === -1) return null;

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= groups.length) return null;

  const targetGroup = groups[targetIndex];
  const currentOrder = group.sort_order ?? currentIndex;
  const targetOrder = targetGroup.sort_order ?? targetIndex;

  let newCurrentOrder = targetOrder;
  const newTargetOrder = currentOrder;
  if (newCurrentOrder === newTargetOrder) {
    newCurrentOrder = direction === 'up' ? targetOrder - 1 : targetOrder + 1;
  }

  const next = [...groups];
  next[currentIndex] = { ...group, sort_order: newCurrentOrder };
  next[targetIndex] = { ...targetGroup, sort_order: newTargetOrder };
  next.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  return {
    groups: next,
    updates: [
      { id: group.id, sort_order: newCurrentOrder },
      { id: targetGroup.id, sort_order: newTargetOrder },
    ],
  };
}
