import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, List, Pencil, Plus, Search, ShieldCheck, SquareTerminal, Trash2, X } from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { MobileHeader } from '../MobileHeader';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import type { Device, SshKey, SshKnownHost, SshProfile, SshSessionRequest, SshStatus } from '../../types';
import { TerminalPane, type TerminalStatus } from './TerminalPane';
import { ConnectDialog, PasswordPrompt, ProfileDialog, deviceLabel } from './SshDialogs';
import { KeysPanel, KnownHostsPanel } from './SshPanels';

type Section = 'terminal' | 'keys' | 'known_hosts';

interface Session {
  id: number;
  label: string;
  request: SshSessionRequest;
  status: TerminalStatus;
}

function hasSsh(device: Device): boolean {
  return device.services?.some((s) => s.protocol?.toLowerCase() === 'ssh' || s.port === 22) ?? false;
}

export function SshView() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [section, setSection] = useState<Section>('terminal');

  const [devices, setDevices] = useState<Device[]>([]);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [knownHosts, setKnownHosts] = useState<SshKnownHost[]>([]);
  const [status, setStatus] = useState<SshStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [search, setSearch] = useState('');
  const [showAllDevices, setShowAllDevices] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  const nextId = useRef(1);

  // undefined = dialog closed; null = dialog for "any host" / "new profile"
  const [connectDevice, setConnectDevice] = useState<Device | null | undefined>(undefined);
  const [editProfile, setEditProfile] = useState<SshProfile | null | undefined>(undefined);
  const [askProfile, setAskProfile] = useState<SshProfile | null>(null);

  const loadKeys = useCallback(() => api.getSshKeys().then(setKeys), []);
  const loadProfiles = useCallback(() => api.getSshProfiles().then(setProfiles), []);
  const loadKnownHosts = useCallback(() => api.getSshKnownHosts().then(setKnownHosts), []);

  useEffect(() => {
    Promise.all([
      api.getDevices().then(setDevices),
      loadKeys(),
      loadProfiles(),
      loadKnownHosts(),
      api.getSshStatus().then(setStatus),
    ])
      .catch((err) => showToast('error', t('ssh.title'), err instanceof Error ? err.message : String(err)))
      .finally(() => setLoaded(true));
  }, [loadKeys, loadProfiles, loadKnownHosts, showToast, t]);

  const openSession = useCallback((request: SshSessionRequest, label: string) => {
    const id = nextId.current++;
    setSessions((prev) => [...prev, { id, label, request, status: 'connecting' }]);
    setActiveId(id);
    setSection('terminal');
    setPickerOpen(false);
    setConnectDevice(undefined);
    setAskProfile(null);
  }, []);

  const connectProfile = useCallback((profile: SshProfile) => {
    if (profile.auth_method === 'ask') setAskProfile(profile);
    else openSession({ profile_id: profile.id }, profile.name);
  }, [openSession]);

  // Deep link from a device card: /ssh?device=<id> (handled once, even when effects run twice)
  const handledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const deviceParam = searchParams.get('device');
    if (!loaded || !deviceParam || handledDeepLink.current === deviceParam) return;
    handledDeepLink.current = deviceParam;
    const device = devices.find((d) => d.id === Number(deviceParam));
    setSearchParams({}, { replace: true });
    if (!device) return;
    const profile = profiles.find((p) => p.device_id === device.id);
    if (profile) connectProfile(profile);
    else setConnectDevice(device);
  }, [loaded, searchParams, devices, profiles, connectProfile, setSearchParams]);

  const closeSession = (id: number) => {
    const rest = sessions.filter((s) => s.id !== id);
    setSessions(rest);
    if (activeId === id) setActiveId(rest.length ? rest[rest.length - 1].id : null);
    if (!rest.length) setPickerOpen(true);
  };

  const setSessionStatus = useCallback((id: number, next: TerminalStatus) => {
    setSessions((prev) => prev.map((s) => (s.id === id && s.status !== next ? { ...s, status: next } : s)));
  }, []);

  const deleteProfile = async (profile: SshProfile) => {
    if (!confirm(t('ssh.profiles.delete_confirm', { name: profile.name }))) return;
    try {
      await api.deleteSshProfile(profile.id);
      loadProfiles();
    } catch (err) {
      showToast('error', t('ssh.title'), err instanceof Error ? err.message : String(err));
    }
  };

  const query = search.trim().toLowerCase();
  const filteredProfiles = useMemo(() => profiles.filter((p) =>
    !query || [p.name, p.username, p.target_host, p.device_name].some((v) => v?.toLowerCase().includes(query)),
  ), [profiles, query]);
  const filteredDevices = useMemo(() => devices
    .filter((d) => !d.is_hidden && (showAllDevices || hasSsh(d)))
    .filter((d) => !query || [deviceLabel(d), d.ip, d.hostname].some((v) => v?.toLowerCase().includes(query)))
    .sort((a, b) => Number(b.is_online) - Number(a.is_online) || deviceLabel(a).localeCompare(deviceLabel(b))),
  [devices, showAllDevices, query]);
  const profileDeviceIds = useMemo(() => new Set(profiles.map((p) => p.device_id)), [profiles]);

  const sectionTabs: { id: Section; label: string; icon: typeof KeyRound; count?: number }[] = [
    { id: 'terminal', label: t('ssh.tabs.terminal'), icon: SquareTerminal, count: sessions.length || undefined },
    { id: 'keys', label: t('ssh.tabs.keys'), icon: KeyRound, count: keys.length || undefined },
    { id: 'known_hosts', label: t('ssh.tabs.known_hosts'), icon: ShieldCheck },
  ];

  return (
    <div className="app-layout">
      <Sidebar active="ssh" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <main className="app-main app-main--fill ssh-page">
        <MobileHeader onMenuClick={() => setIsSidebarOpen(true)} title={t('ssh.title')} />

        <header className="page-header ssh-page__header">
          <div>
            <h1 className="page-header__title visually-hidden-mobile">{t('ssh.title')}</h1>
            <p className="page-header__subtitle">{t('ssh.subtitle')}</p>
          </div>
          <div className="segmented ssh-page__sections" role="group" aria-label={t('ssh.title')}>
            {sectionTabs.map(({ id, label, icon: Icon, count }) => (
              <button key={id} type="button" aria-pressed={section === id} className="segmented__option segmented__option--icon"
                onClick={() => { setSection(id); if (id === 'known_hosts') loadKnownHosts(); }}>
                <Icon size={14} aria-hidden="true" /> {label}
                {count !== undefined && <span className="ssh-count">{count}</span>}
              </button>
            ))}
          </div>
        </header>

        {/* Terminal workspace stays mounted so open sessions survive switching sections */}
        <div className="ssh-workspace" hidden={section !== 'terminal'} data-picker={pickerOpen || sessions.length === 0 ? 'open' : 'closed'}>
          <aside className="ssh-targets" aria-label={t('ssh.targets.label')}>
            <div className="agents-toolbar__search ssh-targets__search">
              <Search size={16} aria-hidden="true" />
              <input type="search" className="input" placeholder={t('ssh.targets.search')} aria-label={t('ssh.targets.search')}
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            <div className="ssh-targets__group">
              <div className="ssh-targets__head">
                <h2>{t('ssh.targets.profiles')}</h2>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditProfile(null)}>
                  <Plus size={14} aria-hidden="true" /> {t('ssh.targets.new_profile')}
                </button>
              </div>
              {filteredProfiles.length === 0 ? (
                <p className="ssh-empty-text">{profiles.length ? t('ssh.targets.no_match') : t('ssh.targets.no_profiles')}</p>
              ) : (
                <ul className="ssh-target-list">
                  {filteredProfiles.map((p) => (
                    <li key={p.id} className="ssh-target">
                      <button type="button" className="ssh-target__main" onClick={() => connectProfile(p)} title={t('ssh.targets.connect')}>
                        <SquareTerminal size={16} className="ssh-target__icon" aria-hidden="true" />
                        <span className="ssh-target__text">
                          <span className="ssh-target__name">{p.name}</span>
                          <span className="ssh-target__meta">{p.username}@{p.target_host}{p.port !== 22 ? `:${p.port}` : ''}</span>
                        </span>
                        <span className="device-tag ssh-target__auth">
                          {p.auth_method === 'key' ? (p.key_name || t('ssh.auth.key')) : t(`ssh.auth.${p.auth_method}`)}
                        </span>
                      </button>
                      <button type="button" className="btn-icon" onClick={() => setEditProfile(p)} aria-label={t('common.edit')} title={t('common.edit')}>
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" className="btn-icon btn-icon--danger" onClick={() => deleteProfile(p)} aria-label={t('common.delete')} title={t('common.delete')}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ssh-targets__group">
              <div className="ssh-targets__head">
                <h2>{t('ssh.targets.devices')}</h2>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConnectDevice(null)}>
                  <Plus size={14} aria-hidden="true" /> {t('ssh.targets.other_host')}
                </button>
              </div>
              <label className="ssh-check ssh-check--small">
                <input type="checkbox" checked={showAllDevices} onChange={(e) => setShowAllDevices(e.target.checked)} />
                {t('ssh.targets.show_all')}
              </label>
              {filteredDevices.length === 0 ? (
                <p className="ssh-empty-text">{loaded ? t('ssh.targets.no_devices') : t('common.loading')}</p>
              ) : (
                <ul className="ssh-target-list">
                  {filteredDevices.map((d) => (
                    <li key={d.id} className="ssh-target">
                      <button type="button" className="ssh-target__main" onClick={() => setConnectDevice(d)} title={t('ssh.targets.connect')}>
                        <span className={`status-dot ${d.is_online ? 'status-dot--online' : 'status-dot--offline'}`} aria-hidden="true" />
                        <span className="ssh-target__text">
                          <span className="ssh-target__name">{deviceLabel(d)}</span>
                          <span className="ssh-target__meta">{d.ip}</span>
                        </span>
                        {profileDeviceIds.has(d.id) && <span className="device-tag ssh-target__auth">{t('ssh.targets.has_profile')}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          <section className="ssh-sessions" aria-label={t('ssh.sessions.label')}>
            {sessions.length > 0 && (
              <div className="ssh-tabs" role="tablist" aria-label={t('ssh.sessions.label')}>
                <button type="button" className="btn-icon ssh-tabs__picker mobile-only" onClick={() => setPickerOpen((v) => !v)}
                  aria-label={t('ssh.targets.label')} aria-expanded={pickerOpen}>
                  <List size={16} aria-hidden="true" />
                </button>
                {sessions.map((s) => (
                  <div key={s.id} className={`ssh-tab${s.id === activeId ? ' is-active' : ''}`}>
                    <button type="button" role="tab" aria-selected={s.id === activeId} className="ssh-tab__select"
                      onClick={() => { setActiveId(s.id); setPickerOpen(false); }}>
                      <span className={`ssh-tab__dot is-${s.status}`} aria-hidden="true" />
                      <span className="ssh-tab__label">{s.label}</span>
                    </button>
                    <button type="button" className="ssh-tab__close" onClick={() => closeSession(s.id)} aria-label={t('ssh.sessions.close', { name: s.label })}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {sessions.length === 0 ? (
              <div className="ssh-empty">
                <SquareTerminal size={32} aria-hidden="true" />
                <p className="ssh-empty__title">{t('ssh.sessions.empty_title')}</p>
                <p className="ssh-empty-text">{t('ssh.sessions.empty_text')}</p>
                {keys.length === 0 && loaded && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSection('keys')}>
                    <KeyRound size={14} aria-hidden="true" /> {t('ssh.sessions.add_key')}
                  </button>
                )}
              </div>
            ) : (
              <div className="ssh-panes">
                {sessions.map((s) => (
                  <div key={s.id} className="ssh-panes__item" hidden={s.id !== activeId}>
                    <TerminalPane
                      request={s.request}
                      active={section === 'terminal' && s.id === activeId}
                      onStatusChange={(next) => setSessionStatus(s.id, next)}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {section === 'keys' && <KeysPanel keys={keys} status={status} onChanged={() => { loadKeys(); loadProfiles(); }} />}
        {section === 'known_hosts' && <KnownHostsPanel hosts={knownHosts} onChanged={loadKnownHosts} />}

        {connectDevice !== undefined && (
          <ConnectDialog
            device={connectDevice}
            keys={keys}
            onClose={() => setConnectDevice(undefined)}
            onConnect={openSession}
            onProfileSaved={loadProfiles}
          />
        )}
        {editProfile !== undefined && (
          <ProfileDialog
            profile={editProfile}
            devices={devices}
            keys={keys}
            onClose={() => setEditProfile(undefined)}
            onSaved={() => { setEditProfile(undefined); loadProfiles(); }}
          />
        )}
        {askProfile && (
          <PasswordPrompt
            profile={askProfile}
            onClose={() => setAskProfile(null)}
            onConnect={(password) => openSession({ profile_id: askProfile.id, password }, askProfile.name)}
          />
        )}
      </main>
    </div>
  );
}
