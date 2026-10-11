import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ApiTokenResponse } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { SettingsSection, errorText } from './SettingsParts';

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  }
  return fallbackCopyToClipboard(text);
}

// Plain-HTTP installs have no Clipboard API, so fall back to execCommand
function fallbackCopyToClipboard(text: string): boolean {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (err) {
    console.error('Fallback: unable to copy', err);
  }
  document.body.removeChild(textArea);
  return copied;
}

/** Read-only API tokens: generate one (shown once), list and revoke. */
export function TokensSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [tokens, setTokens] = useState<ApiTokenResponse[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [createdToken, setCreatedToken] = useState('');
  const [isCreatingToken, setIsCreatingToken] = useState(false);

  const loadTokens = useCallback(async () => {
    try {
      setTokens(await api.getApiTokens());
    } catch (err) {
      console.error('Failed to load API tokens:', err);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const handleCreateToken = async (e: FormEvent) => {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) return;
    setIsCreatingToken(true);
    setCreatedToken('');
    try {
      const res = await api.createApiToken(name);
      setCreatedToken(res.token);
      setNewTokenName('');
      loadTokens();
    } catch (err) {
      console.error('Failed to create token:', err);
      showToast('error', t('common.error'), `${t('settings.token_create_failed')} ${errorText(err)}`);
    } finally {
      setIsCreatingToken(false);
    }
  };

  const handleCopyToken = async () => {
    if (await copyToClipboard(createdToken)) {
      showToast('success', t('common.success'), t('notifications.copied'));
    } else {
      showToast('error', t('common.error'), t('settings.copy_failed'));
    }
  };

  const handleDeleteToken = async (token: ApiTokenResponse) => {
    if (!confirm(t('settings.delete_token_confirm'))) return;
    try {
      await api.deleteApiToken(token.id);
      showToast('success', t('common.success'), t('settings.token_revoked'));
      loadTokens();
    } catch (err) {
      console.error('Failed to delete token:', err);
      showToast('error', t('common.error'), `${t('settings.token_revoke_failed')} ${errorText(err)}`);
    }
  };

  return (
    <SettingsSection id="tokens" title={t('settings.api_tokens')} description={t('settings.api_tokens_desc')}>
      <form className="inline-form" onSubmit={handleCreateToken}>
        <label htmlFor="set-token-name" className="visually-hidden">{t('settings.new_token_placeholder')}</label>
        <input
          id="set-token-name"
          className="input"
          value={newTokenName}
          onChange={(e) => setNewTokenName(e.target.value)}
          placeholder={t('settings.new_token_placeholder')}
          disabled={isCreatingToken}
        />
        <button type="submit" className="btn btn-secondary" disabled={isCreatingToken || !newTokenName.trim()}>
          {isCreatingToken
            ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            : <Plus size={16} aria-hidden="true" />}
          {t('settings.token_create')}
        </button>
      </form>

      {createdToken && <CreatedToken token={createdToken} onCopy={handleCopyToken} />}

      {tokens.length === 0 ? (
        <p className="settings-empty">{t('settings.no_tokens')}</p>
      ) : (
        <ul className="settings-list">
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} onRevoke={() => handleDeleteToken(token)} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/** The new token in full, shown only right after it was generated. */
function CreatedToken({ token, onCopy }: { token: string; onCopy: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="callout callout--success" role="status">
      <Check size={16} className="callout__icon" aria-hidden="true" />
      <div className="callout__body">
        <p>{t('settings.token_created_title')}</p>
        <div className="inline-form">
          <input
            type="text"
            readOnly
            className="input input--mono"
            value={token}
            aria-label={t('settings.api_tokens')}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="btn btn-secondary" onClick={onCopy}>
            <Copy size={16} aria-hidden="true" /> {t('settings.token_copy')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiTokenResponse; onRevoke: () => void }) {
  const { t, i18n } = useTranslation();
  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(i18n.resolvedLanguage);
  const formatDateTime = (iso: string) => new Date(iso).toLocaleString(i18n.resolvedLanguage);

  return (
    <li className="settings-list__row">
      <div className="settings-list__main">
        <span className="settings-list__name">{token.name}</span>
        <span className="settings-list__meta">
          <code>{token.prefix}</code>
          {' · '}{t('settings.token_created')}: {formatDate(token.created_at)}
          {token.last_used_at && <>{' · '}{t('settings.token_used')}: {formatDateTime(token.last_used_at)}</>}
        </span>
      </div>
      <button
        type="button"
        className="btn-icon btn-icon--danger"
        onClick={onRevoke}
        aria-label={t('settings.revoke_token', { name: token.name })}
        title={t('settings.revoke_token', { name: token.name })}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </li>
  );
}
