import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ClipboardList, ClipboardPaste, Copy, Loader2, Minus, Plus, RefreshCw, RotateCcw, Settings2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { TerminalSettings } from '../TerminalSettings';
import { setTerminalPrefs } from '../terminalPrefs';
import type { AgentUpdate } from './useAgentUpdateCommand';
import type { CopyState } from './useTerminalClipboard';
import type { HostKeyPrompt, TerminalStatus } from './useSshSession';

interface ToolbarProps {
  fontSize: number;
  copyState: CopyState;
  lastCopyState: CopyState;
  onCopy: () => void;
  onCopyLast: () => void;
  onPaste: () => void;
  /** Extra tools after the clipboard group */
  children?: ReactNode;
}

export function TerminalToolbar({ fontSize, copyState, lastCopyState, onCopy, onCopyLast, onPaste, children }: ToolbarProps) {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => setShowSettings(false), []);

  const copyLabel = (state: CopyState, idle: string, empty: string) =>
    state === 'copied' ? t('ssh.terminal.copied') : state === 'empty' ? t(empty) : t(idle);

  return (
    <div className="ssh-pane__toolbar" role="toolbar" aria-label={t('ssh.terminal.toolbar')}>
      <button type="button" className="btn-icon" onClick={onCopy}
        title={t('ssh.terminal.copy_hint')} aria-label={t('ssh.terminal.copy')}>
        {copyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        <span className="ssh-pane__tool-label">{copyLabel(copyState, 'ssh.terminal.copy', 'ssh.terminal.nothing_selected')}</span>
      </button>
      <button type="button" className="btn-icon" onClick={onCopyLast}
        title={t('ssh.terminal.copy_last_hint')} aria-label={t('ssh.terminal.copy_last')}>
        {lastCopyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <ClipboardList size={15} aria-hidden="true" />}
        <span className="ssh-pane__tool-label">{copyLabel(lastCopyState, 'ssh.terminal.copy_last', 'ssh.terminal.no_command_yet')}</span>
      </button>
      <button type="button" className="btn-icon" onClick={onPaste}
        title={t('ssh.terminal.paste_hint')} aria-label={t('ssh.terminal.paste')}>
        <ClipboardPaste size={15} aria-hidden="true" />
        <span className="ssh-pane__tool-label">{t('ssh.terminal.paste')}</span>
      </button>
      {children}
      <span className="ssh-pane__tool-sep" aria-hidden="true" />
      <button type="button" className="btn-icon" onClick={() => setTerminalPrefs({ fontSize: fontSize - 1 })}
        title={t('ssh.terminal.smaller')} aria-label={t('ssh.terminal.smaller')}>
        <Minus size={15} aria-hidden="true" />
      </button>
      <span className="ssh-pane__font-size" aria-live="polite">{fontSize}px</span>
      <button type="button" className="btn-icon" onClick={() => setTerminalPrefs({ fontSize: fontSize + 1 })}
        title={t('ssh.terminal.larger')} aria-label={t('ssh.terminal.larger')}>
        <Plus size={15} aria-hidden="true" />
      </button>
      <button ref={settingsButtonRef} type="button" className="btn-icon" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}
        title={t('ssh.terminal.settings.title')} aria-label={t('ssh.terminal.settings.title')}>
        <Settings2 size={15} aria-hidden="true" />
      </button>
      {showSettings && <TerminalSettings anchor={settingsButtonRef.current} onClose={closeSettings} />}
    </div>
  );
}

interface AgentUpdateButtonProps {
  update: AgentUpdate;
  busy: boolean;
  disabled: boolean;
  onInsert: () => void;
}

/** Types the agent update command into the shell; only shown while an update is available. */
export function AgentUpdateButton({ update, busy, disabled, onInsert }: AgentUpdateButtonProps) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn-icon ssh-pane__tool--update" onClick={onInsert} disabled={disabled || busy}
      title={t('ssh.terminal.agent_update_hint', { from: update.installed, to: update.latest })} aria-label={t('ssh.terminal.agent_update')}>
      {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
      <span className="ssh-pane__tool-label">{t('ssh.terminal.agent_update')}</span>
    </button>
  );
}

interface PasteBoxProps {
  text: string;
  onText: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function PasteBox({ text, onText, onSubmit, onCancel }: PasteBoxProps) {
  const { t } = useTranslation();
  return (
    <div className="ssh-pane__overlay" role="dialog" aria-modal="false" aria-labelledby="ssh-paste-title">
      <form className="ssh-hostkey" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <h3 id="ssh-paste-title"><ClipboardPaste size={18} aria-hidden="true" /> {t('ssh.terminal.paste')}</h3>
        <p className="field-hint">{t('ssh.terminal.paste_fallback')}</p>
        <textarea className="input input--mono" rows={5} value={text} onChange={(e) => onText(e.target.value)}
          autoFocus spellCheck={false} aria-label={t('ssh.terminal.paste')} />
        <div className="ssh-hostkey__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!text}>
            <ClipboardPaste size={14} aria-hidden="true" /> {t('ssh.terminal.paste_send')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The sshd public key file matching a host key type, for the "verify on the server" hint. */
export function hostKeyFile(keyType: string): string {
  const kind = keyType.includes('ed25519') ? 'ed25519' : keyType.startsWith('ecdsa') ? 'ecdsa' : keyType.includes('rsa') ? 'rsa' : '*';
  return `/etc/ssh/ssh_host_${kind}_key.pub`;
}

interface HostKeyProps {
  hostKey: HostKeyPrompt;
  onAnswer: (accept: boolean) => void;
  onDismiss: () => void;
}

/** Trust prompt for an unknown key, or the warning for a key that differs from the stored one. */
export function HostKeyOverlay({ hostKey, onAnswer, onDismiss }: HostKeyProps) {
  const { t } = useTranslation();
  const host = `${hostKey.host}:${hostKey.port}`;

  if (hostKey.status === 'changed') {
    return (
      <div className="ssh-pane__overlay" role="alert">
        <div className="ssh-hostkey ssh-hostkey--danger">
          <h3><AlertTriangle size={18} aria-hidden="true" /> {t('ssh.hostkey.changed_title')}</h3>
          <p>{t('ssh.hostkey.changed_text', { host })}</p>
          <dl className="ssh-hostkey__facts">
            <dt>{t('ssh.hostkey.known')}</dt><dd className="ssh-mono">{hostKey.known_fingerprint}</dd>
            <dt>{t('ssh.hostkey.presented')}</dt><dd className="ssh-mono">{hostKey.fingerprint}</dd>
          </dl>
          <p className="field-hint">{t('ssh.hostkey.changed_hint')}</p>
          <div className="ssh-hostkey__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ssh-pane__overlay" role="dialog" aria-modal="false" aria-labelledby="ssh-hostkey-title">
      <div className="ssh-hostkey">
        <h3 id="ssh-hostkey-title"><ShieldAlert size={18} aria-hidden="true" /> {t('ssh.hostkey.unknown_title')}</h3>
        <p>{t('ssh.hostkey.unknown_text', { host })}</p>
        <dl className="ssh-hostkey__facts">
          <dt>{t('ssh.hostkey.type')}</dt><dd>{hostKey.key_type}</dd>
          <dt>{t('ssh.hostkey.fingerprint')}</dt><dd className="ssh-mono">{hostKey.fingerprint}</dd>
        </dl>
        <p className="field-hint">{t('ssh.hostkey.verify_hint', { file: hostKeyFile(hostKey.key_type) })}</p>
        <div className="ssh-hostkey__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAnswer(false)}>{t('ssh.hostkey.reject')}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onAnswer(true)} autoFocus>
            <ShieldCheck size={14} aria-hidden="true" /> {t('ssh.hostkey.accept')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Connecting…/Logging in…" while busy; the end of the session with a reconnect button. */
export function StatusBanner({ status, message, onReconnect }: { status: TerminalStatus; message: string | null; onReconnect: () => void }) {
  const { t } = useTranslation();
  if (status === 'connecting' || status === 'authenticating') {
    return (
      <div className="ssh-pane__banner" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {status === 'connecting' ? t('ssh.terminal.connecting') : t('ssh.terminal.authenticating')}
      </div>
    );
  }
  if (status !== 'closed' && status !== 'error') return null;
  const isError = status === 'error';
  return (
    <div className={`ssh-pane__banner ${isError ? 'is-error' : ''}`} role="status">
      <span className="ssh-pane__banner-text">
        {message || t(isError ? 'ssh.terminal.error' : 'ssh.terminal.closed')}
      </span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onReconnect}>
        <RotateCcw size={14} aria-hidden="true" /> {t('ssh.terminal.reconnect')}
      </button>
    </div>
  );
}
