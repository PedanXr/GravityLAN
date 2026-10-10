import type { Device, SshHistoryEntry, SshKey, SshProfile, SshProfileInput, SshSessionRequest } from '../../../types';
import type { TerminalStatus } from '../TerminalPane';
import type { ConnectInitial } from '../SshDialogs';

export type Section = 'terminal' | 'keys' | 'known_hosts';

export interface Session {
  id: number;
  label: string;
  request: SshSessionRequest;
  status: TerminalStatus;
}

export function hasSsh(device: Device): boolean {
  return device.services?.some((s) => s.protocol?.toLowerCase() === 'ssh' || s.port === 22) ?? false;
}

export function isLive(session: Session): boolean {
  return session.status !== 'closed' && session.status !== 'error';
}

/** Prefill for "save as connection" from an ad-hoc request (tab) or a history entry. */
export function profileInitialFrom(source: {
  device_id?: number | null; host?: string | null; port?: number; username?: string; key_id?: number | null;
}, name: string): Partial<SshProfileInput> {
  return {
    name,
    device_id: source.device_id ?? null,
    host: source.device_id ? null : source.host ?? null,
    port: source.port ?? 22,
    username: source.username ?? 'root',
    auth_method: source.key_id ? 'key' : 'ask',
    key_id: source.key_id ?? null,
  };
}

/**
 * How to reconnect a history entry: straight away when its key is still stored,
 * otherwise through the connect dialog (passwords are never stored).
 */
export function historyReconnect(entry: SshHistoryEntry, keys: SshKey[]):
  | { kind: 'open'; request: SshSessionRequest }
  | { kind: 'ask'; initial: ConnectInitial } {
  const keyStillStored = entry.auth_method === 'key' && entry.key_id !== null && keys.some((k) => k.id === entry.key_id);
  if (keyStillStored) {
    return {
      kind: 'open',
      request: {
        device_id: entry.device_id ?? undefined, host: entry.device_id ? undefined : entry.host ?? undefined,
        port: entry.port, username: entry.username, key_id: entry.key_id!,
      },
    };
  }
  return { kind: 'ask', initial: { host: entry.host ?? '', port: entry.port, username: entry.username, auth: 'password' } };
}

const contains = (query: string, values: (string | null | undefined)[]) =>
  !query || values.some((v) => v?.toLowerCase().includes(query));

export function filterProfiles(profiles: SshProfile[], query: string): SshProfile[] {
  return profiles.filter((p) => contains(query, [p.name, p.username, p.target_host, p.device_name]));
}

export function filterHistory(history: SshHistoryEntry[], query: string): SshHistoryEntry[] {
  return history.filter((h) => contains(query, [h.label, h.target_host, h.device_name]));
}

/** Visible devices with an SSH service (or all), matching the search, online first then by name. */
export function filterDevices(devices: Device[], query: string, showAll: boolean, label: (d: Device) => string): Device[] {
  return devices
    .filter((d) => !d.is_hidden && (showAll || hasSsh(d)))
    .filter((d) => contains(query, [label(d), d.ip, d.hostname]))
    .sort((a, b) => Number(b.is_online) - Number(a.is_online) || label(a).localeCompare(label(b)));
}
