import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Device, SshProfile } from '../../types';

/**
 * Saved SSH connections that may log in for agent deploy and updates: key logins of
 * this device (linked to it, or to its address). The backend checks the same, and
 * also needs the host key confirmed in the SSH terminal (ADR-002).
 */
export function agentKeyProfiles(profiles: SshProfile[], device: Pick<Device, 'id' | 'ip'>): SshProfile[] {
  return profiles.filter((p) => p.auth_method === 'key' && p.key_id !== null
    && (p.device_id !== null ? p.device_id === device.id : p.host === device.ip));
}

/** Saved SSH connections; none when they cannot be loaded (only browser sessions may read them). */
export function useSavedSshProfiles(enabled = true): SshProfile[] {
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.getSshProfiles()
      .then((list) => { if (!cancelled) setProfiles(list); })
      .catch(() => { /* no saved connections offered */ });
    return () => { cancelled = true; };
  }, [enabled]);
  return profiles;
}

/** "user@host" (with a port other than 22) of a saved connection. */
export function profileTarget(profile: SshProfile): string {
  const port = profile.port !== 22 ? `:${profile.port}` : '';
  return `${profile.username}@${profile.target_host ?? profile.host ?? ''}${port}`;
}
