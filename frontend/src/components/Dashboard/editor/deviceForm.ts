import type { Device, Service } from '../../../types';
import { api } from '../../../api/client';

export type EditorTab = 'settings' | 'services' | 'interfaces' | 'history' | 'agent';

/** The editable fields of the "General" tab, sent as-is to PUT /api/devices/{id}. */
export interface DeviceFormData {
  display_name: string;
  notes: string;
  group_id: number | null;
  vendor: string;
  w: number;
  h: number;
  virtual_type: Device['virtual_type'];
  parent_id: number | null;
  rack_id: number | null;
  rack_unit: number | null;
  rack_height: number;
  is_wlan: boolean;
  is_ap: boolean;
  is_host: boolean;
  alert_offline: boolean;
}

export type SetFormData = (update: (prev: DeviceFormData) => DeviceFormData) => void;

export function initialFormData(device: Device): DeviceFormData {
  return {
    display_name: device.display_name || '',
    notes: device.notes || '',
    group_id: device.group_id,
    vendor: device.vendor || '',
    w: device.w || 2,
    h: device.h || 3,
    virtual_type: device.virtual_type || null,
    parent_id: device.parent_id || null,
    rack_id: device.rack_id || null,
    rack_unit: device.rack_unit || null,
    rack_height: device.rack_height || 1,
    is_wlan: device.is_wlan || false,
    is_ap: device.is_ap || false,
    is_host: device.is_host || false,
    alert_offline: device.alert_offline ?? true,
  };
}

/** `<select>`/number input value to an id, empty meaning "none". */
export function intOrNull(value: string): number | null {
  return value ? parseInt(value) : null;
}

/** A device moved to another group lands at the bottom of that group's grid. */
export function computeGroupPlacement(formData: DeviceFormData, currentDevice: Device, devices: Device[]): { x: number; y: number } | null {
  if (formData.group_id === currentDevice.group_id) return null;
  const targetGroupDevices = devices.filter(d => d.group_id === formData.group_id && d.id !== currentDevice.id);
  let maxY = 0;
  targetGroupDevices.forEach(d => {
    const bottom = (d.y || 0) + (d.h || 1);
    if (bottom > maxY) maxY = bottom;
  });
  return { x: 0, y: maxY };
}

/** Save services whose port/name/protocol were edited but not yet blurred. */
export function syncModifiedServices(device: Device, currentDevice: Device): Promise<unknown>[] {
  const originalServices = device.services || [];
  const currentServices = currentDevice.services || [];
  return currentServices.map(async (svc: Service) => {
    const originalSvc = originalServices.find(s => s.id === svc.id);
    if (originalSvc && (
      originalSvc.port !== svc.port ||
      originalSvc.name !== svc.name ||
      originalSvc.protocol !== svc.protocol
    )) {
      return api.updateService(svc.id, {
        port: svc.port,
        name: svc.name,
        protocol: svc.protocol,
      });
    }
  });
}

/** Parents from the outermost host down to this device (e.g. Proxmox › Docker VM), cycle-safe. */
export function networkPathOf(parentId: number | null, devices: Device[]): Device[] {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const chain: Device[] = [];
  const seen = new Set<number>();
  let next = parentId;
  while (next && byId.has(next) && !seen.has(next)) {
    seen.add(next);
    const parent = byId.get(next)!;
    chain.unshift(parent);
    next = parent.parent_id;
  }
  return chain;
}

export function deviceRoleOf(device: Device): string | null {
  if (device.virtual_type === 'docker') return 'Docker';
  if (device.virtual_type === 'vm') return 'VM';
  return device.virtual_type || (device.is_host ? 'Host' : null);
}

export function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : (err as { message?: string } | null)?.message;
}
