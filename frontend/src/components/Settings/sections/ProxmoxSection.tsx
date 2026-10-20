import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ProxmoxConnectionInput, ProxmoxSettings } from '../../../types';
import { errorText, Field, SettingsSection } from './SettingsParts';

const EMPTY: ProxmoxSettings = {
  enabled: false, url: '', token_id: '', verify_tls: true,
  has_token_secret: false, last_sync: null, last_error: null,
};

export function ProxmoxSection() {
  const { t, i18n } = useTranslation();
  const [saved, setSaved] = useState<ProxmoxSettings>(EMPTY);
  const [form, setForm] = useState<ProxmoxConnectionInput>(EMPTY);
  const [secret, setSecret] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const accept = (settings: ProxmoxSettings) => {
    setSaved(settings);
    setForm({ enabled: settings.enabled, url: settings.url, token_id: settings.token_id, verify_tls: settings.verify_tls });
    setSecret('');
  };

  useEffect(() => {
    let active = true;
    api.getProxmoxSettings().then((settings) => {
      if (active) { accept(settings); setLoaded(true); }
    }).catch((err) => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, []);

  const dirty = !!secret || form.enabled !== saved.enabled || form.url !== saved.url
    || form.token_id !== saved.token_id || form.verify_tls !== saved.verify_tls;

  const change = (patch: Partial<ProxmoxConnectionInput>) => {
    setForm((value) => ({ ...value, ...patch }));
    setMessage('');
  };

  const act = async (action: 'save' | 'sync' | 'disconnect') => {
    if (action === 'disconnect' && !window.confirm(t('proxmox.disconnect_confirm'))) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'save') {
        accept(await api.saveProxmoxSettings({ ...form, ...(secret ? { token_secret: secret } : {}) }));
        setMessage(t('proxmox.saved'));
      } else if (action === 'sync') {
        const result = await api.syncProxmox();
        accept(await api.getProxmoxSettings());
        setMessage(t('proxmox.synced', { ...result, count: result.addresses }));
      } else {
        await api.disconnectProxmox();
        accept(EMPTY);
        setMessage(t('proxmox.disconnected'));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="proxmox" title="Proxmox VE" description={t('proxmox.description')}>
      <fieldset disabled={!loaded || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="settings-grid">
          <label className="form-label">
            <input type="checkbox" checked={form.enabled} onChange={(e) => change({ enabled: e.target.checked })} />{' '}
            {t('proxmox.enabled')}
          </label>
          <Field id="proxmox-url" label={t('proxmox.url')}>
            <input id="proxmox-url" className="input" type="url" placeholder="https://pve.example:8006"
              value={form.url} onChange={(e) => change({ url: e.target.value })} />
          </Field>
          <Field id="proxmox-token-id" label={t('proxmox.token_id')}>
            <input id="proxmox-token-id" className="input input--mono" placeholder="gravitylan@pve!inventory"
              autoComplete="off" value={form.token_id} onChange={(e) => change({ token_id: e.target.value })} />
          </Field>
          <Field id="proxmox-secret" label={t('proxmox.secret')} hint={t('proxmox.secret_hint')}>
            <input id="proxmox-secret" className="input input--mono" type="password" autoComplete="new-password"
              aria-describedby="proxmox-secret-hint" placeholder={saved.has_token_secret ? t('proxmox.secret_saved') : ''}
              value={secret} onChange={(e) => { setSecret(e.target.value); setMessage(''); }} />
          </Field>
          <div>
            <label className="form-label">
              <input type="checkbox" checked={!form.verify_tls} aria-describedby="proxmox-tls-hint"
                onChange={(e) => change({ verify_tls: !e.target.checked })} />{' '}
              {t('proxmox.ignore_tls')}
            </label>
            <p className="field-hint" id="proxmox-tls-hint">{t('proxmox.tls_hint')}</p>
          </div>
        </div>
        <p className="field-hint">{t('proxmox.permissions_hint')}</p>
        <div className="settings-action-row">
          <button className="btn btn--primary" type="button" disabled={!dirty} onClick={() => act('save')}>
            {t('proxmox.save')}
          </button>
          <button className="btn btn--secondary" type="button" disabled={dirty || !saved.enabled}
            onClick={() => act('sync')}>{t('proxmox.sync')}</button>
          <button className="btn btn--secondary" type="button" disabled={!saved.has_token_secret}
            onClick={() => act('disconnect')}>{t('proxmox.disconnect')}</button>
        </div>
      </fieldset>
      {busy && <p role="status">{t('proxmox.busy')}</p>}
      {saved.last_sync && <p className="field-hint">{t('proxmox.last_sync', {
        time: new Date(saved.last_sync).toLocaleString(i18n.language),
      })}</p>}
      {(error || saved.last_error) && <p role="alert">{error || saved.last_error}</p>}
      {message && <p role="status">{message}</p>}
    </SettingsSection>
  );
}
