import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { History, KeyRound, List, Pencil, Plus, Save, SquareTerminal, Trash2, X } from 'lucide-react';
import type { Device, SshHistoryEntry, SshProfile } from '../../../types';
import { TerminalPane, type AgentUpdate, type TerminalStatus } from '../TerminalPane';
import { deviceLabel } from '../SshDialogs';
import type { Session } from './sshModel';
import type { TabMenuState } from './sshHooks';

function TargetGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="ssh-targets__group">
      <div className="ssh-targets__head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

/** One row of a target list: the main "connect" button plus optional icon actions. */
function TargetRow({ icon, name, meta, tag, onConnect, children }: {
  icon: ReactNode; name: string; meta: string; tag?: ReactNode; onConnect: () => void; children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className="ssh-target">
      <button type="button" className="ssh-target__main" onClick={onConnect} title={t('ssh.targets.connect')}>
        {icon}
        <span className="ssh-target__text">
          <span className="ssh-target__name">{name}</span>
          <span className="ssh-target__meta">{meta}</span>
        </span>
        {tag}
      </button>
      {children}
    </li>
  );
}

const portSuffix = (port: number) => (port !== 22 ? `:${port}` : '');

interface ProfilesGroupProps {
  profiles: SshProfile[];
  hasAny: boolean;
  onNew: () => void;
  onConnect: (p: SshProfile) => void;
  onEdit: (p: SshProfile) => void;
  onDelete: (p: SshProfile) => void;
}

export function ProfilesGroup({ profiles, hasAny, onNew, onConnect, onEdit, onDelete }: ProfilesGroupProps) {
  const { t } = useTranslation();
  return (
    <TargetGroup
      title={t('ssh.targets.profiles')}
      action={<button type="button" className="btn btn-secondary btn-sm" onClick={onNew}><Plus size={14} aria-hidden="true" /> {t('ssh.targets.new_profile')}</button>}
    >
      {profiles.length === 0 ? (
        <p className="ssh-empty-text">{hasAny ? t('ssh.targets.no_match') : t('ssh.targets.no_profiles')}</p>
      ) : (
        <ul className="ssh-target-list">
          {profiles.map((p) => (
            <TargetRow
              key={p.id}
              icon={<SquareTerminal size={16} className="ssh-target__icon" aria-hidden="true" />}
              name={p.name}
              meta={`${p.username}@${p.target_host}${portSuffix(p.port)}`}
              tag={<span className="device-tag ssh-target__auth">{p.auth_method === 'key' ? (p.key_name || t('ssh.auth.key')) : t(`ssh.auth.${p.auth_method}`)}</span>}
              onConnect={() => onConnect(p)}
            >
              <button type="button" className="btn-icon" onClick={() => onEdit(p)} aria-label={t('common.edit')} title={t('common.edit')}>
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" className="btn-icon btn-icon--danger" onClick={() => onDelete(p)} aria-label={t('common.delete')} title={t('common.delete')}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </TargetRow>
          ))}
        </ul>
      )}
    </TargetGroup>
  );
}

interface RecentGroupProps {
  history: SshHistoryEntry[];
  onConnect: (h: SshHistoryEntry) => void;
  onSave: (h: SshHistoryEntry) => void;
  onRemove: (h: SshHistoryEntry) => void;
}

export function RecentGroup({ history, onConnect, onSave, onRemove }: RecentGroupProps) {
  const { t } = useTranslation();
  return (
    <TargetGroup title={t('ssh.targets.recent')}>
      <ul className="ssh-target-list">
        {history.map((h) => (
          <TargetRow
            key={h.id}
            icon={<History size={16} className="ssh-target__icon" aria-hidden="true" />}
            name={h.label}
            meta={`${h.target_host}${portSuffix(h.port)}`}
            tag={<span className="device-tag ssh-target__auth">{h.auth_method === 'key' ? (h.key_name || t('ssh.auth.key')) : t('ssh.auth.password')}</span>}
            onConnect={() => onConnect(h)}
          >
            <button type="button" className="btn-icon" onClick={() => onSave(h)}
              aria-label={t('ssh.targets.save_connection')} title={t('ssh.targets.save_connection')}>
              <Save size={14} aria-hidden="true" />
            </button>
            <button type="button" className="btn-icon btn-icon--danger" onClick={() => onRemove(h)}
              aria-label={t('ssh.targets.remove_recent')} title={t('ssh.targets.remove_recent')}>
              <X size={14} aria-hidden="true" />
            </button>
          </TargetRow>
        ))}
      </ul>
    </TargetGroup>
  );
}

interface DevicesGroupProps {
  devices: Device[];
  loaded: boolean;
  showAll: boolean;
  onShowAll: (all: boolean) => void;
  profileDeviceIds: Set<number | null>;
  onConnect: (d: Device | null) => void;
}

export function DevicesGroup({ devices, loaded, showAll, onShowAll, profileDeviceIds, onConnect }: DevicesGroupProps) {
  const { t } = useTranslation();
  return (
    <TargetGroup
      title={t('ssh.targets.devices')}
      action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => onConnect(null)}><Plus size={14} aria-hidden="true" /> {t('ssh.targets.other_host')}</button>}
    >
      <label className="ssh-check ssh-check--small">
        <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} />
        {t('ssh.targets.show_all')}
      </label>
      {devices.length === 0 ? (
        <p className="ssh-empty-text">{loaded ? t('ssh.targets.no_devices') : t('common.loading')}</p>
      ) : (
        <ul className="ssh-target-list">
          {devices.map((d) => (
            <TargetRow
              key={d.id}
              icon={<span className={`status-dot ${d.is_online ? 'status-dot--online' : 'status-dot--offline'}`} aria-hidden="true" />}
              name={deviceLabel(d)}
              meta={d.ip}
              tag={profileDeviceIds.has(d.id) && <span className="device-tag ssh-target__auth">{t('ssh.targets.has_profile')}</span>}
              onConnect={() => onConnect(d)}
            />
          ))}
        </ul>
      )}
    </TargetGroup>
  );
}

interface SessionTabsProps {
  sessions: Session[];
  activeId: number | null;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onMenu: (menu: TabMenuState) => void;
}

export function SessionTabs({ sessions, activeId, pickerOpen, onTogglePicker, onSelect, onClose, onMenu }: SessionTabsProps) {
  const { t } = useTranslation();
  return (
    <div className="ssh-tabs" role="tablist" aria-label={t('ssh.sessions.label')}>
      <button type="button" className="btn-icon ssh-tabs__picker mobile-only" onClick={onTogglePicker}
        aria-label={t('ssh.targets.label')} aria-expanded={pickerOpen}>
        <List size={16} aria-hidden="true" />
      </button>
      {sessions.map((s) => (
        <div key={s.id} className={`ssh-tab${s.id === activeId ? ' is-active' : ''}`}
          onContextMenu={(e) => { e.preventDefault(); onMenu({ id: s.id, x: e.clientX, y: e.clientY }); }}>
          <button type="button" role="tab" aria-selected={s.id === activeId} className="ssh-tab__select" onClick={() => onSelect(s.id)}>
            <span className={`ssh-tab__dot is-${s.status}`} aria-hidden="true" />
            <span className="ssh-tab__label">{s.label}</span>
          </button>
          <button type="button" className="ssh-tab__close" onClick={() => onClose(s.id)} aria-label={t('ssh.sessions.close', { name: s.label })}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** One terminal per session, all mounted; only the active one is shown and focused. */
export function SessionPanes({ sessions, activeId, visible, onStatus, agentUpdate }: {
  sessions: Session[]; activeId: number | null; visible: boolean; onStatus: (id: number, status: TerminalStatus) => void;
  agentUpdate: (session: Session) => AgentUpdate | null;
}) {
  return (
    <div className="ssh-panes">
      {sessions.map((s) => (
        <div key={s.id} className="ssh-panes__item" hidden={s.id !== activeId}>
          <TerminalPane request={s.request} active={visible && s.id === activeId} onStatusChange={(next) => onStatus(s.id, next)}
            agentUpdate={agentUpdate(s)} />
        </div>
      ))}
    </div>
  );
}

export function NoSession({ showAddKey, onAddKey }: { showAddKey: boolean; onAddKey: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ssh-empty">
      <SquareTerminal size={32} aria-hidden="true" />
      <p className="ssh-empty__title">{t('ssh.sessions.empty_title')}</p>
      <p className="ssh-empty-text">{t('ssh.sessions.empty_text')}</p>
      {showAddKey && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onAddKey}>
          <KeyRound size={14} aria-hidden="true" /> {t('ssh.sessions.add_key')}
        </button>
      )}
    </div>
  );
}

/** Context menu of a tab: "save as connection" for ad-hoc sessions, and close. */
export function TabMenu({ menu, session, onSave, onClose }: { menu: TabMenuState; session: Session; onSave: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="ssh-tab-menu" role="menu" onMouseDown={(e) => e.stopPropagation()}
      // Keep the menu inside the window near the right/bottom edge
      style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 268)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 120)) }}>
      {session.request.profile_id === undefined ? (
        <button type="button" role="menuitem" className="ssh-tab-menu__item" autoFocus onClick={onSave}>
          <Save size={14} aria-hidden="true" /> {t('ssh.targets.save_connection')}
        </button>
      ) : (
        <span className="ssh-tab-menu__note">{t('ssh.sessions.already_saved')}</span>
      )}
      <button type="button" role="menuitem" className="ssh-tab-menu__item" onClick={onClose}>
        <X size={14} aria-hidden="true" /> {t('ssh.sessions.close', { name: session.label })}
      </button>
    </div>
  );
}
