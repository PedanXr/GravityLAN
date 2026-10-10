import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { useToast } from '../../../context/ToastContext';
import type { Device, SshHistoryEntry, SshKey, SshKnownHost, SshProfile, SshSessionRequest, SshStatus } from '../../../types';
import type { TerminalStatus } from '../TerminalPane';
import { setLiveSshSessions } from '../sessionCount';
import { isLive, type Session } from './sshModel';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Devices, keys, saved connections, known hosts, history and status of the SSH page. */
export function useSshData(visible: boolean) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [knownHosts, setKnownHosts] = useState<SshKnownHost[]>([]);
  const [history, setHistory] = useState<SshHistoryEntry[]>([]);
  const [status, setStatus] = useState<SshStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadKeys = useCallback(() => api.getSshKeys().then(setKeys), []);
  const loadProfiles = useCallback(() => api.getSshProfiles().then(setProfiles), []);
  const loadKnownHosts = useCallback(() => api.getSshKnownHosts().then(setKnownHosts), []);
  const loadHistory = useCallback(() => api.getSshHistory().then(setHistory), []);

  useEffect(() => {
    Promise.all([
      api.getDevices().then(setDevices),
      loadKeys(),
      loadProfiles(),
      loadKnownHosts(),
      loadHistory(),
      api.getSshStatus().then(setStatus),
    ])
      .catch((err) => showToast('error', t('ssh.title'), errorText(err)))
      .finally(() => setLoaded(true));
  }, [loadKeys, loadProfiles, loadKnownHosts, loadHistory, showToast, t]);

  // Device list may have changed while the page was hidden
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) api.getDevices().then(setDevices).catch(() => {});
    wasVisible.current = visible;
  }, [visible]);

  const removeHistory = async (entry: SshHistoryEntry) => {
    try {
      await api.deleteSshHistory(entry.id);
      setHistory((prev) => prev.filter((h) => h.id !== entry.id));
    } catch (err) {
      showToast('error', t('ssh.title'), errorText(err));
    }
  };

  const deleteProfile = async (profile: SshProfile) => {
    if (!confirm(t('ssh.profiles.delete_confirm', { name: profile.name }))) return;
    try {
      await api.deleteSshProfile(profile.id);
      loadProfiles();
    } catch (err) {
      showToast('error', t('ssh.title'), errorText(err));
    }
  };

  return {
    devices, keys, profiles, knownHosts, history, status, loaded,
    loadKeys, loadProfiles, loadKnownHosts, loadHistory, removeHistory, deleteProfile,
  };
}

/**
 * Open terminal tabs. Live ones are counted for the sidebar badge, and the browser
 * asks before a reload or close would end them.
 */
export function useSessions(onConnected: () => void) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  const nextId = useRef(1);

  const open = useCallback((request: SshSessionRequest, label: string) => {
    const id = nextId.current++;
    setSessions((prev) => [...prev, { id, label, request, status: 'connecting' }]);
    setActiveId(id);
    setPickerOpen(false);
  }, []);

  const close = (id: number) => {
    const rest = sessions.filter((s) => s.id !== id);
    setSessions(rest);
    if (activeId === id) setActiveId(rest.length ? rest[rest.length - 1].id : null);
    if (!rest.length) setPickerOpen(true);
  };

  const setStatus = useCallback((id: number, next: TerminalStatus) => {
    setSessions((prev) => prev.map((s) => (s.id === id && s.status !== next ? { ...s, status: next } : s)));
    // The server records ad-hoc connections when they are prepared; show them right away
    if (next === 'connected') onConnected();
  }, [onConnected]);

  const liveCount = sessions.filter(isLive).length;
  useEffect(() => { setLiveSshSessions(liveCount); }, [liveCount]);
  useEffect(() => () => setLiveSshSessions(0), []);
  useEffect(() => {
    if (!liveCount) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [liveCount]);

  const select = (id: number) => {
    setActiveId(id);
    setPickerOpen(false);
  };

  return { sessions, activeId, pickerOpen, setPickerOpen, open, close, select, setStatus };
}

export interface TabMenuState { id: number; x: number; y: number }

/** Right-click menu of a terminal tab; any click elsewhere, Escape or a resize closes it. */
export function useTabMenu() {
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  return [menu, setMenu] as const;
}
