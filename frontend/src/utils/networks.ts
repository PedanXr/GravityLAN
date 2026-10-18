import type { Device } from '../types';

/**
 * One hue per subnet, the same on device chips, the gateway list and the interface tab,
 * so "IoT" reads as the same colour everywhere. Green and red stay reserved for status.
 */
const NETWORK_HUES = ['#2DD4BF', '#A78BFA', '#F472B6', '#FB923C', '#818CF8', '#A3E635', '#22D3EE', '#E879F9'];

/** Colour of a subnet: by id when the subnet is configured, else by the /24 around the address. */
export function networkColor(subnetId: number | null | undefined, ip?: string | null): string {
  if (subnetId != null) return NETWORK_HUES[(Math.abs(subnetId) - 1 + NETWORK_HUES.length) % NETWORK_HUES.length];
  const prefix = (ip || '').split('.').slice(0, 3).join('.');
  if (!prefix) return 'var(--text-tertiary)';
  let hash = 0;
  for (let i = 0; i < prefix.length; i++) hash = (hash * 31 + prefix.charCodeAt(i)) >>> 0;
  return NETWORK_HUES[hash % NETWORK_HUES.length];
}

export interface NetworkChip {
  ip: string;
  name: string | null;
  vlanId: number | null;
  label: string | null;
  isOnline: boolean;
  isPrimary: boolean;
  color: string;
  interfaceId: number | null;
}

/** The device's primary address followed by its further interfaces, one entry per network. */
export function deviceNetworks(device: Device): NetworkChip[] {
  const primary: NetworkChip = {
    ip: device.ip,
    name: device.subnet_name ?? null,
    vlanId: device.subnet_vlan_id ?? null,
    label: null,
    isOnline: device.is_online,
    isPrimary: true,
    color: networkColor(device.subnet_id, device.ip),
    interfaceId: null,
  };
  const others = (device.interfaces ?? []).map((iface): NetworkChip => ({
    ip: iface.ip,
    name: iface.subnet_name,
    vlanId: iface.vlan_id,
    label: iface.label,
    isOnline: iface.is_online,
    isPrimary: false,
    color: networkColor(iface.subnet_id, iface.ip),
    interfaceId: iface.id,
  }));
  return [primary, ...others];
}

/** "IoT", or the address when the network is not configured. */
export function chipName(chip: Pick<NetworkChip, 'name' | 'ip'>): string {
  return chip.name || chip.ip;
}
