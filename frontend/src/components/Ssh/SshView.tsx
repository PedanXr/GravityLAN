import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, Search, ShieldCheck, SquareTerminal } from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { MobileHeader } from '../MobileHeader';
import type { Device, SshKey, SshProfile, SshProfileInput, SshSessionRequest } from '../../types';
import { ConnectDialog, PasswordPrompt, ProfileDialog, deviceLabel, type ConnectInitial } from './SshDialogs';
import { KeysPanel, KnownHostsPanel } from './SshPanels';
import { filterDevices, filterHistory, filterProfiles, historyReconnect, profileInitialFrom, type Section } from './view/sshModel';
import { useSessions, useSshData, useTabMenu, type TabMenuState } from './view/sshHooks';
import { DevicesGroup, NoSession, ProfilesGroup, RecentGroup, SessionPanes, SessionTabs, TabMenu } from './view/SshParts';

/** Which dialog is open: connect (device, or null for "any host"), profile editor (null = new), password prompt. */
function useSshDialogs() {
  // undefined = dialog closed; null = dialog for "any host" / "new profile"
  const [connectDevice, setConnectDevice] = useState<Device | null | undefined>(undefined);
  const [connectInitial, setConnectInitial] = useState<ConnectInitial | undefined>(undefined);
  const [editProfile, setEditProfile] = useState<SshProfile | null | undefined>(undefined);
  const [profileInitial, setProfileInitial] = useState<Partial<SshProfileInput> | undefined>(undefined);
  const [askProfile, setAskProfile] = useState<SshProfile | null>(null);

  return {
    connectDevice, connectInitial, editProfile, profileInitial, askProfile, setAskProfile, setEditProfile,
    openConnect: (device: Device | null, initial?: ConnectInitial) => { setConnectInitial(initial); setConnectDevice(device); },
    closeConnect: () => { setConnectDevice(undefined); setConnectInitial(undefined); },
    openSave: (initial: Partial<SshProfileInput>) => { setProfileInitial(initial); setEditProfile(null); },
    closeProfile: () => { setEditProfile(undefined); setProfileInitial(undefined); },
  };
}

/** Deep link from a device card: /ssh?device=<id> (handled once, even when effects run twice). */
function useDeviceDeepLink(loaded: boolean, devices: Device[], profiles: SshProfile[], open: (device: Device, profile?: SshProfile) => void) {
  const [searchParams, setSearchParams] = useSearchParams();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const deviceParam = searchParams.get('device');
    if (!deviceParam) {
      // The page stays mounted: allow the same device to be opened again later
      handled.current = null;
      return;
    }
    if (!loaded || handled.current === deviceParam) return;
    handled.current = deviceParam;
    const device = devices.find((d) => d.id === Number(deviceParam));
    setSearchParams({}, { replace: true });
    if (device) open(device, profiles.find((p) => p.device_id === device.id));
  }, [loaded, searchParams, devices, profiles, open, setSearchParams]);
}

/**
 * The SSH page stays mounted (hidden) after the first visit, so open terminals keep
 * running while the user is elsewhere in GravityLAN; `visible` says whether /ssh is shown.
 */
export function SshView({ visible = true }: { visible?: boolean }) {
  const { t } = useTranslation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [section, setSection] = useState<Section>('terminal');
  const [search, setSearch] = useState('');
  const [showAllDevices, setShowAllDevices] = useState(false);

  const data = useSshData(visible);
  const { devices, keys, profiles, loaded, loadHistory } = data;
  const reloadHistory = useCallback(() => { loadHistory().catch(() => {}); }, [loadHistory]);
  const sessions = useSessions(reloadHistory);
  const { open: openTab } = sessions;
  const dialogs = useSshDialogs();
  const { closeConnect, setAskProfile, openConnect } = dialogs;
  const [tabMenu, setTabMenu] = useTabMenu();

  const openSession = useCallback((request: SshSessionRequest, label: string) => {
    openTab(request, label);
    setSection('terminal');
    closeConnect();
    setAskProfile(null);
  }, [openTab, closeConnect, setAskProfile]);

  const connectProfile = useCallback((profile: SshProfile) => {
    if (profile.auth_method === 'ask') setAskProfile(profile);
    else openSession({ profile_id: profile.id }, profile.name);
  }, [openSession, setAskProfile]);

  const openLinked = useCallback((device: Device, profile?: SshProfile) => {
    if (profile) connectProfile(profile);
    else openConnect(device);
  }, [connectProfile, openConnect]);
  useDeviceDeepLink(loaded, devices, profiles, openLinked);

  const query = search.trim().toLowerCase();
  const filteredProfiles = useMemo(() => filterProfiles(profiles, query), [profiles, query]);
  const filteredDevices = useMemo(() => filterDevices(devices, query, showAllDevices, deviceLabel), [devices, showAllDevices, query]);
  const filteredHistory = useMemo(() => filterHistory(data.history, query), [data.history, query]);
  const profileDeviceIds = useMemo(() => new Set(profiles.map((p) => p.device_id)), [profiles]);
  const menuSession = tabMenu ? sessions.sessions.find((s) => s.id === tabMenu.id) : undefined;

  const reconnect = (entry: Parameters<typeof historyReconnect>[0]) => {
    const how = historyReconnect(entry, keys);
    if (how.kind === 'open') openSession(how.request, entry.label);
    else openConnect(entry.device_id ? devices.find((d) => d.id === entry.device_id) ?? null : null, how.initial);
  };

  const saveTab = () => {
    if (!menuSession) return;
    setTabMenu(null);
    const r = menuSession.request;
    const device = r.device_id ? devices.find((d) => d.id === r.device_id) : undefined;
    dialogs.openSave(profileInitialFrom(r, device ? deviceLabel(device) : r.host ?? menuSession.label));
  };

  const sectionTabs: { id: Section; label: string; icon: typeof KeyRound; count?: number }[] = [
    { id: 'terminal', label: t('ssh.tabs.terminal'), icon: SquareTerminal, count: sessions.sessions.length || undefined },
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
                onClick={() => { setSection(id); if (id === 'known_hosts') data.loadKnownHosts(); }}>
                <Icon size={14} aria-hidden="true" /> {label}
                {count !== undefined && <span className="ssh-count">{count}</span>}
              </button>
            ))}
          </div>
        </header>

        {/* Terminal workspace stays mounted so open sessions survive switching sections */}
        <div className="ssh-workspace" hidden={section !== 'terminal'} data-picker={sessions.pickerOpen || sessions.sessions.length === 0 ? 'open' : 'closed'}>
          <aside className="ssh-targets" aria-label={t('ssh.targets.label')}>
            <div className="agents-toolbar__search ssh-targets__search">
              <Search size={16} aria-hidden="true" />
              <input type="search" className="input" placeholder={t('ssh.targets.search')} aria-label={t('ssh.targets.search')}
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            <ProfilesGroup
              profiles={filteredProfiles}
              hasAny={profiles.length > 0}
              onNew={() => dialogs.setEditProfile(null)}
              onConnect={connectProfile}
              onEdit={dialogs.setEditProfile}
              onDelete={data.deleteProfile}
            />
            {filteredHistory.length > 0 && (
              <RecentGroup
                history={filteredHistory}
                onConnect={reconnect}
                onSave={(h) => dialogs.openSave(profileInitialFrom(h, h.device_name || h.target_host || h.label))}
                onRemove={data.removeHistory}
              />
            )}
            <DevicesGroup
              devices={filteredDevices}
              loaded={loaded}
              showAll={showAllDevices}
              onShowAll={setShowAllDevices}
              profileDeviceIds={profileDeviceIds}
              onConnect={(d) => openConnect(d)}
            />
          </aside>

          <SessionArea
            sessions={sessions}
            visible={visible && section === 'terminal'}
            showAddKey={keys.length === 0 && loaded}
            onAddKey={() => setSection('keys')}
            onMenu={setTabMenu}
          />

        </div>

        {section === 'keys' && <KeysPanel keys={keys} status={data.status} onChanged={() => { data.loadKeys(); data.loadProfiles(); }} />}
        {section === 'known_hosts' && <KnownHostsPanel hosts={data.knownHosts} onChanged={data.loadKnownHosts} />}

        {tabMenu && menuSession && (
          <TabMenu menu={tabMenu} session={menuSession} onSave={saveTab} onClose={() => { setTabMenu(null); sessions.close(menuSession.id); }} />
        )}

        <OpenDialogs dialogs={dialogs} devices={devices} keys={keys} onConnect={openSession} onProfilesChanged={data.loadProfiles} />
      </main>
    </div>
  );
}

function SessionArea({ sessions, visible, showAddKey, onAddKey, onMenu }: {
  sessions: ReturnType<typeof useSessions>;
  visible: boolean;
  showAddKey: boolean;
  onAddKey: () => void;
  onMenu: (menu: TabMenuState) => void;
}) {
  const { t } = useTranslation();
  const hasSessions = sessions.sessions.length > 0;
  return (
    <section className="ssh-sessions" aria-label={t('ssh.sessions.label')}>
      {hasSessions && (
        <SessionTabs
          sessions={sessions.sessions}
          activeId={sessions.activeId}
          pickerOpen={sessions.pickerOpen}
          onTogglePicker={() => sessions.setPickerOpen((v) => !v)}
          onSelect={sessions.select}
          onClose={sessions.close}
          onMenu={onMenu}
        />
      )}
      {hasSessions
        ? <SessionPanes sessions={sessions.sessions} activeId={sessions.activeId} visible={visible} onStatus={sessions.setStatus} />
        : <NoSession showAddKey={showAddKey} onAddKey={onAddKey} />}
    </section>
  );
}

function OpenDialogs({ dialogs, devices, keys, onConnect, onProfilesChanged }: {
  dialogs: ReturnType<typeof useSshDialogs>;
  devices: Device[];
  keys: SshKey[];
  onConnect: (request: SshSessionRequest, label: string) => void;
  onProfilesChanged: () => void;
}) {
  const { connectDevice, editProfile, askProfile } = dialogs;
  return (
    <>
      {connectDevice !== undefined && (
        <ConnectDialog
          device={connectDevice}
          keys={keys}
          initial={dialogs.connectInitial}
          onClose={dialogs.closeConnect}
          onConnect={onConnect}
          onProfileSaved={onProfilesChanged}
        />
      )}
      {editProfile !== undefined && (
        <ProfileDialog
          profile={editProfile}
          initial={editProfile === null ? dialogs.profileInitial : undefined}
          devices={devices}
          keys={keys}
          onClose={dialogs.closeProfile}
          onSaved={() => { dialogs.closeProfile(); onProfilesChanged(); }}
        />
      )}
      {askProfile && (
        <PasswordPrompt
          profile={askProfile}
          onClose={() => dialogs.setAskProfile(null)}
          onConnect={(password) => onConnect({ profile_id: askProfile.id, password }, askProfile.name)}
        />
      )}
    </>
  );
}
