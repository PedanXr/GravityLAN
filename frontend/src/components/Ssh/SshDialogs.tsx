import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Plug, Server, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Device, SshAuthMethod, SshKey, SshProfile, SshProfileInput, SshSessionRequest } from '../../types';

export function deviceLabel(device: Pick<Device, 'display_name' | 'hostname' | 'ip'>): string {
  return device.display_name || device.hostname || device.ip;
}

interface DialogShellProps {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}

function DialogShell({ title, icon, onClose, onSubmit, children, footer, wide }: DialogShellProps) {
  const { t } = useTranslation();
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal-content ssh-dialog${wide ? ' ssh-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header">
          <h2 id={titleId}>{icon} {title}</h2>
          <button type="button" className="btn-close" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="modal-body ssh-form">
          {children}
          <div className="modal-footer">{footer}</div>
        </form>
      </div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="segmented__option" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KeySelect({ keys, value, onChange, id }: { keys: SshKey[]; value: number | null; onChange: (id: number | null) => void; id: string }) {
  const { t } = useTranslation();
  if (keys.length === 0) {
    return <p className="field-hint">{t('ssh.dialog.no_keys')}</p>;
  }
  return (
    <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} required>
      <option value="">{t('ssh.dialog.choose_key')}</option>
      {keys.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.key_type})</option>)}
    </select>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="field-error" role="alert">{error}</p>;
}

// --- Quick connect -------------------------------------------------------------

/** Values to start the connect dialog with, e.g. from a recent connection. */
export interface ConnectInitial {
  host?: string;
  port?: number;
  username?: string;
  auth?: 'key' | 'password';
  keyId?: number | null;
}

interface ConnectDialogProps {
  device: Device | null;
  keys: SshKey[];
  initial?: ConnectInitial;
  onClose: () => void;
  onConnect: (request: SshSessionRequest, label: string) => void;
  onProfileSaved: () => void;
}

/** Connect to a device (or any host) once, optionally saving the connection as a profile. */
export function ConnectDialog({ device, keys, initial, onClose, onConnect, onProfileSaved }: ConnectDialogProps) {
  const { t } = useTranslation();
  const ids = useId();
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(initial?.port ?? 22);
  const [username, setUsername] = useState(initial?.username ?? 'root');
  const [auth, setAuth] = useState<'key' | 'password'>(initial?.auth ?? (keys.length > 0 ? 'key' : 'password'));
  const [keyId, setKeyId] = useState<number | null>(initial?.keyId ?? (keys.length === 1 ? keys[0].id : null));
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(false);
  const [storePassword, setStorePassword] = useState(false);
  const [name, setName] = useState(device ? deviceLabel(device) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetLabel = device ? deviceLabel(device) : host.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (auth === 'key' && !keyId) { setError(t('ssh.dialog.choose_key')); return; }
    const credentials = auth === 'key' ? { key_id: keyId! } : { password };

    if (!save) {
      onConnect(
        { device_id: device?.id, host: device ? undefined : host.trim(), port, username: username.trim(), ...credentials },
        `${username.trim()}@${targetLabel}`,
      );
      return;
    }

    setBusy(true);
    try {
      const authMethod: SshAuthMethod = auth === 'key' ? 'key' : (storePassword ? 'password' : 'ask');
      const profile = await api.createSshProfile({
        name: name.trim() || targetLabel,
        device_id: device?.id ?? null,
        host: device ? null : host.trim(),
        port,
        username: username.trim(),
        auth_method: authMethod,
        key_id: auth === 'key' ? keyId : null,
        password: authMethod === 'password' ? password : undefined,
      });
      onProfileSaved();
      onConnect({ profile_id: profile.id, password: authMethod === 'ask' ? password : undefined }, profile.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={device ? t('ssh.dialog.connect_to', { name: deviceLabel(device) }) : t('ssh.dialog.connect_title')}
      icon={<Plug size={18} aria-hidden="true" />}
      onClose={onClose}
      onSubmit={submit}
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plug size={16} aria-hidden="true" />}
          {t('ssh.dialog.connect')}
        </button>
      </>}
    >
      {device ? (
        <p className="ssh-form__target"><Server size={14} aria-hidden="true" /> {device.ip}</p>
      ) : (
        <div className="form-group">
          <label htmlFor={`${ids}-host`}>{t('ssh.dialog.host')}</label>
          <input id={`${ids}-host`} className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" required autoFocus />
        </div>
      )}

      <div className="ssh-form__row">
        <div className="form-group">
          <label htmlFor={`${ids}-user`}>{t('ssh.dialog.username')}</label>
          <input id={`${ids}-user`} className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required autoFocus={!!device} />
        </div>
        <div className="form-group ssh-form__port">
          <label htmlFor={`${ids}-port`}>{t('ssh.dialog.port')}</label>
          <input id={`${ids}-port`} className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} required />
        </div>
      </div>

      <div className="form-group">
        <span className="label">{t('ssh.dialog.auth')}</span>
        <Segmented
          label={t('ssh.dialog.auth')}
          value={auth}
          onChange={setAuth}
          options={[{ value: 'key', label: t('ssh.auth.key') }, { value: 'password', label: t('ssh.auth.password') }]}
        />
      </div>

      {auth === 'key' ? (
        <div className="form-group">
          <label htmlFor={`${ids}-key`}>{t('ssh.dialog.key')}</label>
          <KeySelect id={`${ids}-key`} keys={keys} value={keyId} onChange={setKeyId} />
        </div>
      ) : (
        <div className="form-group">
          <label htmlFor={`${ids}-pw`}>{t('ssh.dialog.password')}</label>
          <input id={`${ids}-pw`} className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
        </div>
      )}

      <label className="ssh-check">
        <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
        {t('ssh.dialog.save_profile')}
      </label>
      {save && (
        <div className="ssh-form__nested">
          <div className="form-group">
            <label htmlFor={`${ids}-name`}>{t('ssh.dialog.profile_name')}</label>
            <input id={`${ids}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={targetLabel} />
          </div>
          {auth === 'password' && (
            <label className="ssh-check">
              <input type="checkbox" checked={storePassword} onChange={(e) => setStorePassword(e.target.checked)} />
              {t('ssh.dialog.store_password')}
            </label>
          )}
        </div>
      )}
      <ErrorLine error={error} />
    </DialogShell>
  );
}

// --- Password prompt ('ask' profiles) -------------------------------------------

export function PasswordPrompt({ profile, onClose, onConnect }: {
  profile: SshProfile; onClose: () => void; onConnect: (password: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [password, setPassword] = useState('');
  return (
    <DialogShell
      title={t('ssh.dialog.password_for', { name: profile.name })}
      icon={<KeyRound size={18} aria-hidden="true" />}
      onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); onConnect(password); }}
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary"><Plug size={16} aria-hidden="true" /> {t('ssh.dialog.connect')}</button>
      </>}
    >
      <p className="ssh-form__target">{profile.username}@{profile.target_host}:{profile.port}</p>
      <div className="form-group">
        <label htmlFor={id}>{t('ssh.dialog.password')}</label>
        <input id={id} className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required autoFocus />
      </div>
    </DialogShell>
  );
}

// --- Profile editor -------------------------------------------------------------

interface ProfileDialogProps {
  profile: SshProfile | null;
  /** Prefill for a new profile, e.g. "save this connection" from a tab or the history */
  initial?: Partial<SshProfileInput>;
  devices: Device[];
  keys: SshKey[];
  onClose: () => void;
  onSaved: () => void;
}

export function ProfileDialog({ profile, initial, devices, keys, onClose, onSaved }: ProfileDialogProps) {
  const { t } = useTranslation();
  const ids = useId();
  const start = profile ?? initial;
  const [name, setName] = useState(start?.name ?? '');
  const [targetMode, setTargetMode] = useState<'device' | 'host'>(start && !start.device_id && start.host ? 'host' : 'device');
  const [deviceId, setDeviceId] = useState<number | null>(start?.device_id ?? null);
  const [host, setHost] = useState(start?.host ?? '');
  const [port, setPort] = useState(start?.port ?? 22);
  const [username, setUsername] = useState(start?.username ?? 'root');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(start?.auth_method ?? (keys.length > 0 ? 'key' : 'ask'));
  const [keyId, setKeyId] = useState<number | null>(start?.key_id ?? (keys.length === 1 ? keys[0].id : null));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedDevices = [...devices].sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const selected = devices.find((d) => d.id === deviceId);
    const payload: SshProfileInput = {
      name: name.trim() || (targetMode === 'device' && selected ? deviceLabel(selected) : host.trim()),
      device_id: targetMode === 'device' ? deviceId : null,
      host: targetMode === 'host' ? host.trim() : null,
      port,
      username: username.trim(),
      auth_method: authMethod,
      key_id: authMethod === 'key' ? keyId : null,
    };
    if (authMethod === 'password' && password) payload.password = password;

    setBusy(true);
    try {
      if (profile) await api.updateSshProfile(profile.id, payload);
      else await api.createSshProfile(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title={profile ? t('ssh.dialog.edit_profile') : t('ssh.dialog.new_profile')}
      icon={<Server size={18} aria-hidden="true" />}
      onClose={onClose}
      onSubmit={submit}
      wide
      footer={<>
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
          {t('common.save')}
        </button>
      </>}
    >
      <div className="form-group">
        <label htmlFor={`${ids}-name`}>{t('ssh.dialog.profile_name')}</label>
        <input id={`${ids}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ssh.dialog.profile_name_hint')} autoFocus />
      </div>

      <div className="form-group">
        <span className="label">{t('ssh.dialog.target')}</span>
        <Segmented
          label={t('ssh.dialog.target')}
          value={targetMode}
          onChange={setTargetMode}
          options={[{ value: 'device', label: t('ssh.dialog.target_device') }, { value: 'host', label: t('ssh.dialog.target_host') }]}
        />
      </div>

      {targetMode === 'device' ? (
        <div className="form-group">
          <label htmlFor={`${ids}-device`}>{t('ssh.dialog.device')}</label>
          <select id={`${ids}-device`} className="input" value={deviceId ?? ''} onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : null)} required>
            <option value="">{t('ssh.dialog.choose_device')}</option>
            {sortedDevices.map((d) => <option key={d.id} value={d.id}>{deviceLabel(d)} ({d.ip})</option>)}
          </select>
        </div>
      ) : (
        <div className="form-group">
          <label htmlFor={`${ids}-host`}>{t('ssh.dialog.host')}</label>
          <input id={`${ids}-host`} className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.lan" required />
        </div>
      )}

      <div className="ssh-form__row">
        <div className="form-group">
          <label htmlFor={`${ids}-user`}>{t('ssh.dialog.username')}</label>
          <input id={`${ids}-user`} className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
        </div>
        <div className="form-group ssh-form__port">
          <label htmlFor={`${ids}-port`}>{t('ssh.dialog.port')}</label>
          <input id={`${ids}-port`} className="input" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} required />
        </div>
      </div>

      <div className="form-group">
        <span className="label">{t('ssh.dialog.auth')}</span>
        <Segmented
          label={t('ssh.dialog.auth')}
          value={authMethod}
          onChange={setAuthMethod}
          options={[
            { value: 'key', label: t('ssh.auth.key') },
            { value: 'password', label: t('ssh.auth.password') },
            { value: 'ask', label: t('ssh.auth.ask') },
          ]}
        />
      </div>

      {authMethod === 'key' && (
        <div className="form-group">
          <label htmlFor={`${ids}-key`}>{t('ssh.dialog.key')}</label>
          <KeySelect id={`${ids}-key`} keys={keys} value={keyId} onChange={setKeyId} />
        </div>
      )}
      {authMethod === 'password' && (
        <div className="form-group">
          <label htmlFor={`${ids}-pw`}>{t('ssh.dialog.password')}</label>
          <input
            id={`${ids}-pw`} className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off"
            placeholder={profile?.has_password ? t('ssh.dialog.password_unchanged') : ''}
            required={!profile?.has_password}
          />
          <p className="field-hint">{t('ssh.dialog.password_stored_hint')}</p>
        </div>
      )}
      {authMethod === 'ask' && <p className="field-hint">{t('ssh.dialog.ask_hint')}</p>}

      <ErrorLine error={error} />
    </DialogShell>
  );
}
