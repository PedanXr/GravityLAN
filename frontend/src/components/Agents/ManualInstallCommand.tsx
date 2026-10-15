import { useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';

/** Server address as the browser sees it; the Vite dev server (5173) talks to the API on 8000. */
function serverOrigin(): string {
  const { protocol, hostname, port } = window.location;
  const apiPort = port === '5173' ? ':8000' : (port ? `:${port}` : '');
  return `${protocol}//${hostname}${apiPort}`;
}

export function buildInstallCommand(deviceId: number, code: string): string {
  return `curl -sSL "${serverOrigin()}/api/agent/download/install-sh/${deviceId}?code=${code}" | sudo bash`;
}

export interface InstallCode { code: string; expiresAt: Date }

/** A fresh single-use enrollment code for the install command of one device. */
export async function requestInstallCode(deviceId: number): Promise<InstallCode> {
  const { code, expires_in } = await api.createAgentEnrollment(deviceId);
  // The code ends up in a root shell command: accept only the backend's token_urlsafe alphabet.
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('Unexpected install code format');
  return { code, expiresAt: new Date(Date.now() + expires_in * 1000) };
}

export function buildUninstallCommand(deviceId: number): string {
  return `curl -sSL "${serverOrigin()}/api/agent/download/uninstall-sh/${deviceId}" | sudo bash`;
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Clipboard write failed:', err);
    }
  }
  // Plain-HTTP installs have no Clipboard API
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (err) {
    console.error('Copy fallback failed:', err);
  }
  document.body.removeChild(textArea);
  return copied;
}

/** The one-line uninstaller for a device (needs no code: it only removes the agent). */
export function ManualUninstallCommand({ deviceId }: { deviceId: number }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const command = buildUninstallCommand(deviceId);

  const handleCopy = async () => {
    if (await copyText(command)) {
      showToast('success', t('notifications.copied'), t('notifications.copied_text'));
    } else {
      showToast('error', t('common.error'), t('settings.copy_failed'));
    }
  };

  return (
    <div className="manual-command">
      <p className="field-hint">{t('agent.manual_uninstall_desc')}</p>
      <div className="manual-command__box">
        <code className="manual-command__code is-danger">{command}</code>
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopy}>
          <Copy size={14} aria-hidden="true" /> {t('common.copy')}
        </button>
      </div>
    </div>
  );
}

/**
 * The one-line installer for a device, with a fresh single-use enrollment code.
 * Running it on the device installs or updates the agent (no SSH access from GravityLAN needed).
 */
export function ManualInstallCommand({ deviceId }: { deviceId: number }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [installCode, setInstallCode] = useState<InstallCode | null>(null);
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setInstallCode(null);
    setFailed(false);
    requestInstallCode(deviceId)
      .then((result) => {
        if (!cancelled) setInstallCode(result);
      })
      .catch((err) => {
        console.error('Failed to create install code:', err);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [deviceId, request]);

  const command = installCode ? buildInstallCommand(deviceId, installCode.code) : '';

  const handleCopy = async () => {
    if (!command) return;
    if (await copyText(command)) {
      showToast('success', t('notifications.copied'), t('notifications.copied_text'));
    } else {
      showToast('error', t('common.error'), t('settings.copy_failed'));
    }
  };

  return (
    <div className="manual-command">
      <p className="field-hint">{t('agent.manual_update_desc')}</p>
      <div className="manual-command__box">
        <code className="manual-command__code">
          {installCode ? command : t(failed ? 'agent.install_code_failed' : 'common.loading')}
        </code>
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopy} disabled={!installCode}>
          <Copy size={14} aria-hidden="true" /> {t('common.copy')}
        </button>
      </div>
      <div className="manual-command__meta">
        <span>
          {installCode && t('agent.install_code_hint', {
            time: installCode.expiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          })}
        </span>
        <button type="button" className="manual-command__renew" onClick={() => setRequest((n) => n + 1)}>
          <RefreshCw size={12} aria-hidden="true" /> {t('agent.install_code_retry')}
        </button>
      </div>
    </div>
  );
}
