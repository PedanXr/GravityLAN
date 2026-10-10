import { useSyncExternalStore } from 'react';

/**
 * Number of live SSH terminals, shared between the (lazily loaded) SSH page and the
 * sidebar badge. Kept in its own module so the sidebar does not pull in xterm.js.
 */
let liveSessions = 0;
const listeners = new Set<() => void>();

export function setLiveSshSessions(count: number) {
  if (count === liveSessions) return;
  liveSessions = count;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLiveSshSessions(): number {
  return useSyncExternalStore(subscribe, () => liveSessions);
}
