import type { Device, DiscoveredHost } from '../../../types';

/** A named, coloured range of host numbers (.start–.end) within one /24, stored per subnet prefix. */
export interface NetworkArea {
  name: string;
  start: number;
  end: number;
  color: string;
}

export type AreasByPrefix = Record<string, NetworkArea[]>;

export type TileStatus = 'online' | 'offline' | 'reserved' | 'empty';

export interface Tile {
  i: number;
  ip: string;
  device?: Device;
  discovered?: DiscoveredHost;
  status: TileStatus;
  group?: NetworkArea;
  isFirstRows: boolean;
  isReserved?: boolean;
}

/** "192.168.1.0/24" -> "192.168.1"; anything without three octets stays as it is. */
export function prefixOf(cidr: string): string {
  return cidr.match(/(\d+\.\d+\.\d+)/)?.[1] ?? cidr;
}

/** Complete a typed subnet: three octets become a /24, a full address a /32. */
export function normalizeCidr(input: string): string {
  if (input.includes('/')) return input;
  const octets = input.split('.').length;
  if (octets === 3) return `${input}.0/24`;
  if (octets === 4) return `${input}/32`;
  return `${input}/24`;
}

/**
 * The `network_groups` setting: an object keyed by prefix, or (legacy) a plain
 * list, which belongs to the subnet currently shown.
 */
export function parseAreas(raw: unknown, currentPrefix: string): AreasByPrefix {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (Array.isArray(value)) return { [currentPrefix]: value };
  return (value as AreasByPrefix) || {};
}

function tileStatus(i: number, device?: Device, discovered?: DiscoveredHost): TileStatus {
  if (device) return device.is_online ? 'online' : 'offline';
  if (discovered) return discovered.is_online ? 'online' : 'offline';
  if (i === 0 || i === 255) return 'reserved';
  return 'empty';
}

/** All 256 addresses of a /24 with what is known about each. */
export function buildTiles(prefix: string, devices: Device[], discovered: DiscoveredHost[], areas: NetworkArea[], columns: number): Tile[] {
  return Array.from({ length: 256 }, (_, i) => {
    const ip = `${prefix}.${i}`;
    const device = devices.find(d => d.ip?.trim() === ip);
    const disc = discovered.find(h => h.ip?.trim() === ip);
    const group = areas.find(g => g && typeof g.start === 'number' && i >= g.start && i <= g.end);
    return {
      i,
      ip,
      device,
      discovered: disc,
      status: tileStatus(i, device, disc),
      group,
      isFirstRows: Math.floor(i / columns) < 2,
      isReserved: device?.is_reserved || disc?.is_reserved,
    };
  });
}

/** Online overview devices plus online discovered hosts that are not in the overview yet. */
export function countOnline(prefix: string, devices: Device[], discovered: DiscoveredHost[]): number {
  const known = devices.filter(d => d.ip?.startsWith(prefix) && d.is_online).length;
  const onlyDiscovered = discovered
    .filter(h => h.ip?.startsWith(prefix) && h.is_online)
    .filter(h => !devices.find(d => d.ip === h.ip)).length;
  return known + onlyDiscovered;
}

/** Up to 20 discovered hosts that are not in the overview, newest first. */
export function recentFindings(discovered: DiscoveredHost[], devices: Device[]): DiscoveredHost[] {
  return discovered
    .filter(h => !devices.find(d => d.ip === h.ip))
    .sort((a, b) => new Date(b.first_seen).getTime() - new Date(a.first_seen).getTime())
    .slice(0, 20);
}
