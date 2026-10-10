import { useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound, Loader2, Lock, ShieldCheck, Sparkles, Trash2, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { copyText } from '../Agents/ManualInstallCommand';
import type { SshKey, SshKnownHost, SshStatus } from '../../types';

function formatDate(value: string | null): string {
  return value ? new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`).toLocaleString() : '–';
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- Keys -------------------------------------------------------------------------

interface KeysPanelProps {
  keys: SshKey[];
  status: SshStatus | null;
  onChanged: () => void;
}

type KeyMode = 'import' | 'generate';

/** The "add key" form: import (pasted or from a file) or generate on the server. */
function useKeyForm(onChanged: () => void) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<KeyMode>('import');
  const [name, setName] = useState('');
  const [autoName, setAutoName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<SshKey | null>(null);

  const resetFileInput = () => { if (fileRef.current) fileRef.current.value = ''; };

  const readFile = async (file: File | undefined) => {
    // Reset so picking the same file again still fires onChange
    resetFileInput();
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

  const store = async () => {
    if (mode === 'generate') {
      setGenerated(await api.generateSshKey(name.trim()));
      return;
    }
    await api.createSshKey({ name: name.trim(), private_key: privateKey, passphrase: passphrase || undefined });
    showToast('success', t('ssh.keys.title'), t('ssh.keys.imported', { name: name.trim() }));
    setGenerated(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await store();
      setName('');
      setAutoName('');
      setPrivateKey('');
      setPassphrase('');
      resetFileInput();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return {
    fileRef, mode, setMode, name, setName, privateKey, setPrivateKey, passphrase, setPassphrase,
    busy, error, setError, generated, setGenerated, readFile, submit,
  };
}

export function KeysPanel({ keys, status, onChanged }: KeysPanelProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const ids = useId();
  const form = useKeyForm(onChanged);

  const copyPublicKey = async (key: SshKey) => {
    const ok = await copyText(key.public_key);
    showToast(ok ? 'success' : 'error', t('ssh.keys.public_key'), ok ? t('ssh.keys.copied') : t('ssh.keys.copy_failed'));
  };

  const remove = async (key: SshKey) => {
    if (!confirm(t('ssh.keys.delete_confirm', { name: key.name }))) return;
    try {
      await api.deleteSshKey(key.id);
      if (form.generated?.id === key.id) form.setGenerated(null);
      onChanged();
    } catch (err) {
      showToast('error', t('ssh.keys.title'), errorText(err));
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
            <button type="button" className="segmented__option segmented__option--icon" aria-pressed={form.mode === 'import'} onClick={() => form.setMode('import')}>
              <Upload size={14} aria-hidden="true" /> {t('ssh.keys.import')}
            </button>
            <button type="button" className="segmented__option segmented__option--icon" aria-pressed={form.mode === 'generate'} onClick={() => form.setMode('generate')}>
              <Sparkles size={14} aria-hidden="true" /> {t('ssh.keys.generate')}
            </button>
          </div>
        </div>

        <AddKeyForm ids={ids} form={form} />

        {form.generated && <GeneratedKey keyInfo={form.generated} onCopy={copyPublicKey} />}
      </section>

      <section className="ssh-card" aria-labelledby={`${ids}-list`}>
        <h2 id={`${ids}-list`} className="ssh-card__title">{t('ssh.keys.stored', { count: keys.length })}</h2>
        {keys.length === 0 ? (
          <p className="ssh-empty-text">{t('ssh.keys.empty')}</p>
        ) : (
          <ul className="ssh-rows">
            {keys.map((key) => <KeyRow key={key.id} keyInfo={key} onCopy={copyPublicKey} onRemove={remove} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function AddKeyForm({ ids, form }: { ids: string; form: ReturnType<typeof useKeyForm> }) {
  const { t } = useTranslation();
  const isImport = form.mode === 'import';
  const SubmitIcon = isImport ? Upload : Sparkles;
  return (
    <form onSubmit={form.submit} className="ssh-form">
      <div className="form-group">
        <label htmlFor={`${ids}-name`}>{t('ssh.keys.name')}</label>
        <input id={`${ids}-name`} className="input" value={form.name} onChange={(e) => form.setName(e.target.value)} placeholder={t('ssh.keys.name_hint')} maxLength={100} required />
      </div>

      {isImport
        ? <ImportFields ids={ids} form={form} fileRef={form.fileRef} />
        : <p className="field-hint">{t('ssh.keys.generate_hint')}</p>}

      {form.error && <p className="field-error" role="alert">{form.error}</p>}
      <div className="ssh-form__actions">
        <button type="submit" className="btn btn-primary" disabled={form.busy}>
          {form.busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <SubmitIcon size={16} aria-hidden="true" />}
          {isImport ? t('ssh.keys.save') : t('ssh.keys.generate_button')}
        </button>
      </div>
    </form>
  );
}

function ImportFields({ ids, form, fileRef }: { ids: string; form: ReturnType<typeof useKeyForm>; fileRef: RefObject<HTMLInputElement | null> }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="form-group">
        <div className="ssh-form__label-row">
          <label htmlFor={`${ids}-pem`} className="form-label">{t('ssh.keys.private_key')}</label>
          <label className="btn btn-secondary btn-sm btn-file">
            <Upload size={14} aria-hidden="true" /> {t('ssh.keys.choose_file')}
            <input ref={fileRef} type="file" className="visually-hidden" onChange={(e) => form.readFile(e.target.files?.[0])} />
          </label>
        </div>
        <textarea
          id={`${ids}-pem`} className="input input--mono ssh-form__pem" value={form.privateKey} onChange={(e) => { form.setPrivateKey(e.target.value); form.setError(null); }}
          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
          rows={6} spellCheck={false} autoComplete="off" required
        />
        <p className="field-hint">{t('ssh.keys.format_hint')}</p>
      </div>
      <div className="form-group">
        <label htmlFor={`${ids}-pass`}>{t('ssh.keys.passphrase')}</label>
        <input id={`${ids}-pass`} className="input" type="password" value={form.passphrase} onChange={(e) => form.setPassphrase(e.target.value)} autoComplete="off" />
        <p className="field-hint">{t('ssh.keys.passphrase_hint')}</p>
      </div>
    </>
  );
}

function GeneratedKey({ keyInfo, onCopy }: { keyInfo: SshKey; onCopy: (key: SshKey) => void }) {
  const { t } = useTranslation();
  return (
    <div className="callout callout--success ssh-generated">
      <ShieldCheck size={16} className="callout__icon" aria-hidden="true" />
      <div className="callout__body">
        <p><strong>{t('ssh.keys.generated_title', { name: keyInfo.name })}</strong></p>
        <p>{t('ssh.keys.generated_hint')}</p>
        <code className="ssh-code">{keyInfo.public_key}</code>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCopy(keyInfo)}>
          <Copy size={14} aria-hidden="true" /> {t('ssh.keys.copy_public')}
        </button>
      </div>
    </div>
  );
}

function KeyRow({ keyInfo: key, onCopy, onRemove }: { keyInfo: SshKey; onCopy: (key: SshKey) => void; onRemove: (key: SshKey) => void }) {
  const { t } = useTranslation();
  return (
    <li className="ssh-row">
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
        <button type="button" className="btn-icon" onClick={() => onCopy(key)} title={t('ssh.keys.copy_public')} aria-label={t('ssh.keys.copy_public')}>
          <Copy size={16} aria-hidden="true" />
        </button>
        <button type="button" className="btn-icon btn-icon--danger" onClick={() => onRemove(key)} title={t('common.delete')} aria-label={t('common.delete')}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </span>
    </li>
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
      showToast('error', t('ssh.known_hosts.title'), errorText(err));
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
