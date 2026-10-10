import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound, Loader2, Lock, ShieldCheck, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { copyText } from '../Agents/ManualInstallCommand';
import type { SshKey, SshKnownHost, SshStatus } from '../../types';

function formatDate(value: string | null): string {
  return value ? new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`).toLocaleString() : '–';
}

// --- Keys -------------------------------------------------------------------------

interface KeysPanelProps {
  keys: SshKey[];
  status: SshStatus | null;
  onChanged: () => void;
}

export function KeysPanel({ keys, status, onChanged }: KeysPanelProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const ids = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'import' | 'generate'>('import');
  const [name, setName] = useState('');
  const [autoName, setAutoName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<SshKey | null>(null);

  const copyPublicKey = async (key: SshKey) => {
    const ok = await copyText(key.public_key);
    showToast(ok ? 'success' : 'error', t('ssh.keys.public_key'), ok ? t('ssh.keys.copied') : t('ssh.keys.copy_failed'));
  };

  const readFile = async (file: File | undefined) => {
    // Reset so picking the same file again still fires onChange
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.size > 16384) { setError(t('ssh.keys.file_too_large')); return; }
    setPrivateKey(await file.text());
    // Follow the chosen file unless the user typed a name of their own
    const fileName = file.name.replace(/\.(pem|key|ppk)$/i, '');
    if (!name || name === autoName) {
      setName(fileName);
      setAutoName(fileName);
    }
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'import') {
        await api.createSshKey({ name: name.trim(), private_key: privateKey, passphrase: passphrase || undefined });
        showToast('success', t('ssh.keys.title'), t('ssh.keys.imported', { name: name.trim() }));
        setGenerated(null);
      } else {
        setGenerated(await api.generateSshKey(name.trim()));
      }
      setName('');
      setAutoName('');
      setPrivateKey('');
      setPassphrase('');
      if (fileRef.current) fileRef.current.value = '';
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: SshKey) => {
    if (!confirm(t('ssh.keys.delete_confirm', { name: key.name }))) return;
    try {
      await api.deleteSshKey(key.id);
      if (generated?.id === key.id) setGenerated(null);
      onChanged();
    } catch (err) {
      showToast('error', t('ssh.keys.title'), err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ssh-panel">
      <div className="callout">
        <Lock size={16} className="callout__icon" aria-hidden="true" />
        <div className="callout__body">
          <p>{t('ssh.keys.storage_info')}</p>
          <p className="field-hint">
            {status?.vault_key_source === 'env' ? t('ssh.keys.vault_env') : t('ssh.keys.vault_file')}
          </p>
        </div>
      </div>

      <section className="ssh-card" aria-labelledby={`${ids}-add`}>
        <div className="ssh-card__head">
          <h2 id={`${ids}-add`} className="ssh-card__title">{t('ssh.keys.add')}</h2>
          <div className="segmented" role="group" aria-label={t('ssh.keys.add')}>
            <button type="button" className="segmented__option segmented__option--icon" aria-pressed={mode === 'import'} onClick={() => setMode('import')}>
              <Upload size={14} aria-hidden="true" /> {t('ssh.keys.import')}
            </button>
            <button type="button" className="segmented__option segmented__option--icon" aria-pressed={mode === 'generate'} onClick={() => setMode('generate')}>
              <Sparkles size={14} aria-hidden="true" /> {t('ssh.keys.generate')}
            </button>
          </div>
        </div>

        <form onSubmit={submit} className="ssh-form">
          <div className="form-group">
            <label htmlFor={`${ids}-name`}>{t('ssh.keys.name')}</label>
            <input id={`${ids}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ssh.keys.name_hint')} maxLength={100} required />
          </div>

          {mode === 'import' ? (
            <>
              <div className="form-group">
                <div className="ssh-form__label-row">
                  <label htmlFor={`${ids}-pem`} className="form-label">{t('ssh.keys.private_key')}</label>
                  <label className="btn btn-secondary btn-sm btn-file">
                    <Upload size={14} aria-hidden="true" /> {t('ssh.keys.choose_file')}
                    <input ref={fileRef} type="file" className="visually-hidden" onChange={(e) => readFile(e.target.files?.[0])} />
                  </label>
                </div>
                <textarea
                  id={`${ids}-pem`} className="input input--mono ssh-form__pem" value={privateKey} onChange={(e) => { setPrivateKey(e.target.value); setError(null); }}
                  placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
                  rows={6} spellCheck={false} autoComplete="off" required
                />
                <p className="field-hint">{t('ssh.keys.format_hint')}</p>
              </div>
              <div className="form-group">
                <label htmlFor={`${ids}-pass`}>{t('ssh.keys.passphrase')}</label>
                <input id={`${ids}-pass`} className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" />
                <p className="field-hint">{t('ssh.keys.passphrase_hint')}</p>
              </div>
            </>
          ) : (
            <p className="field-hint">{t('ssh.keys.generate_hint')}</p>
          )}

          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="ssh-form__actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : (mode === 'import' ? <Upload size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />)}
              {mode === 'import' ? t('ssh.keys.save') : t('ssh.keys.generate_button')}
            </button>
          </div>
        </form>

        {generated && (
          <div className="callout callout--success ssh-generated">
            <ShieldCheck size={16} className="callout__icon" aria-hidden="true" />
            <div className="callout__body">
              <p><strong>{t('ssh.keys.generated_title', { name: generated.name })}</strong></p>
              <p>{t('ssh.keys.generated_hint')}</p>
              <code className="ssh-code">{generated.public_key}</code>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => copyPublicKey(generated)}>
                <Copy size={14} aria-hidden="true" /> {t('ssh.keys.copy_public')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="ssh-card" aria-labelledby={`${ids}-list`}>
        <h2 id={`${ids}-list`} className="ssh-card__title">{t('ssh.keys.stored', { count: keys.length })}</h2>
        {keys.length === 0 ? (
          <p className="ssh-empty-text">{t('ssh.keys.empty')}</p>
        ) : (
          <ul className="ssh-rows">
            {keys.map((key) => (
              <li key={key.id} className="ssh-row">
                <span className="ssh-row__icon" aria-hidden="true"><KeyRound size={16} /></span>
                <span className="ssh-row__main">
                  <span className="ssh-row__title">
                    {key.name}
                    <span className="device-tag">{key.key_type}</span>
                    {key.has_passphrase && <span className="device-tag">{t('ssh.keys.with_passphrase')}</span>}
                  </span>
                  <span className="ssh-row__meta ssh-mono">{key.fingerprint}</span>
                  <span className="ssh-row__meta">{t('ssh.keys.last_used', { date: formatDate(key.last_used_at) })}</span>
                </span>
                <span className="ssh-row__actions">
                  <button type="button" className="btn-icon" onClick={() => copyPublicKey(key)} title={t('ssh.keys.copy_public')} aria-label={t('ssh.keys.copy_public')}>
                    <Copy size={16} aria-hidden="true" />
                  </button>
                  <button type="button" className="btn-icon btn-icon--danger" onClick={() => remove(key)} title={t('common.delete')} aria-label={t('common.delete')}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// --- Known hosts ----------------------------------------------------------------

export function KnownHostsPanel({ hosts, onChanged }: { hosts: SshKnownHost[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const remove = async (entry: SshKnownHost) => {
    if (!confirm(t('ssh.known_hosts.delete_confirm', { host: `${entry.host}:${entry.port}` }))) return;
    try {
      await api.deleteSshKnownHost(entry.id);
      onChanged();
    } catch (err) {
      showToast('error', t('ssh.known_hosts.title'), err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ssh-panel">
      <div className="callout">
        <ShieldCheck size={16} className="callout__icon" aria-hidden="true" />
        <p className="callout__body">{t('ssh.known_hosts.info')}</p>
      </div>
      <section className="ssh-card">
        {hosts.length === 0 ? (
          <p className="ssh-empty-text">{t('ssh.known_hosts.empty')}</p>
        ) : (
          <ul className="ssh-rows">
            {hosts.map((entry) => (
              <li key={entry.id} className="ssh-row">
                <span className="ssh-row__icon" aria-hidden="true"><ShieldCheck size={16} /></span>
                <span className="ssh-row__main">
                  <span className="ssh-row__title">{entry.host}:{entry.port} <span className="device-tag">{entry.key_type}</span></span>
                  <span className="ssh-row__meta ssh-mono">{entry.fingerprint}</span>
                  <span className="ssh-row__meta">{t('ssh.known_hosts.seen', { first: formatDate(entry.first_seen), last: formatDate(entry.last_seen) })}</span>
                </span>
                <span className="ssh-row__actions">
                  <button type="button" className="btn-icon btn-icon--danger" onClick={() => remove(entry)} title={t('ssh.known_hosts.remove')} aria-label={t('ssh.known_hosts.remove')}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
