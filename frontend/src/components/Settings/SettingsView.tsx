import { useState, useEffect, useCallback, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { ApiTokenResponse, DeviceGroup } from '../../types';
import {
  AlertTriangle, Check, Copy, Database, Download, FileText, Loader2, Plus, Trash2, Upload
} from 'lucide-react';

import { Sidebar } from '../Sidebar';
import { useTranslation } from 'react-i18next';
import { MobileHeader } from '../MobileHeader';
import { LanguageToggle } from '../LanguageToggle';
import { useToast } from '../../context/ToastContext';
import { PasswordForm } from './PasswordForm';

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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Settings saved together through the save bar, keyed as the backend stores them. */
type SettingsForm = {
  scan_interval: string;
  quick_scan_interval: string;
  scan_subnets: string;
  scan_timeout: string;
  'scanner.offline_threshold': string;
  'dns.server': string;
  history_retention_days: string;
  server_url_override: string;
  'system.log_level': string;
};

const DEFAULT_FORM: SettingsForm = {
  scan_interval: '0',
  quick_scan_interval: '300',
  scan_subnets: '',
  scan_timeout: '1.5',
  'scanner.offline_threshold': '3',
  'dns.server': '',
  history_retention_days: '7',
  server_url_override: '',
  'system.log_level': 'info',
};

const FORM_KEYS = Object.keys(DEFAULT_FORM) as (keyof SettingsForm)[];

function toForm(settings: Record<string, string>): SettingsForm {
  const form = { ...DEFAULT_FORM };
  for (const key of FORM_KEYS) {
    if (settings[key]) form[key] = settings[key];
  }
  return form;
}

/** One settings block: title and explanation on the left, controls on the right (stacked on phones). */
function SettingsSection({ id, title, description, tone, children }: {
  id: string;
  title: string;
  description?: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <section
      className={`settings-section${tone === 'danger' ? ' settings-section--danger' : ''}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="settings-section__intro">
        <h2 id={`${id}-title`}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-field">
      <label className="form-label" htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

function UnitField({ id, label, hint, unit, value, onChange, step }: {
  id: string;
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  step?: number;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="input-affix">
        <input
          id={id}
          type="number"
          inputMode={step && step < 1 ? 'decimal' : 'numeric'}
          className="input"
          value={value}
          onChange={onChange}
          min={0}
          step={step}
          aria-describedby={`${id}-unit ${id}-hint`}
        />
        <span className="input-affix__suffix" id={`${id}-unit`}>{unit}</span>
      </div>
    </Field>
  );
}

function ActionRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="settings-action-row">
      <div className="settings-action-row__text">
        <div className="settings-action-row__title">{title}</div>
        <p className="field-hint">{description}</p>
      </div>
      {children}
    </div>
  );
}

export function SettingsView() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [form, setForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [savedForm, setSavedForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [newGroupName, setNewGroupName] = useState('');

  const [tokens, setTokens] = useState<ApiTokenResponse[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [createdToken, setCreatedToken] = useState('');
  const [isCreatingToken, setIsCreatingToken] = useState(false);

  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const loaded = toForm(await api.getSettings());
      setForm(loaded);
      setSavedForm(loaded);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await api.getGroups());
    } catch (err) {
      console.error('Failed to load groups:', err);
    }
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      setTokens(await api.getApiTokens());
    } catch (err) {
      console.error('Failed to load API tokens:', err);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    loadGroups();
    loadTokens();
  }, [loadSettings, loadGroups, loadTokens]);

  const isDirty = FORM_KEYS.some((key) => form[key] !== savedForm[key]);

  const setField = (key: keyof SettingsForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { value } = e.target;
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveStatus((status) => (status === 'saving' ? status : 'idle'));
  };

  const handleSaveSettings = async () => {
    setSaveStatus('saving');
    try {
      await api.updateSettings(form);
      await loadSettings();
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus((status) => (status === 'saved' ? 'idle' : status)), 3000);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveStatus('error');
    }
  };

  const handleDiscard = () => {
    setForm(savedForm);
    setSaveStatus('idle');
  };

  const handleCreateGroup = async (e: FormEvent) => {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await api.createGroup({ name, icon: 'folder' });
      setNewGroupName('');
      loadGroups();
    } catch (err) {
      showToast('error', t('common.error'), `${t('settings.group_failed')} ${errorText(err)}`);
    }
  };

  const handleDeleteGroup = async (id: number) => {
    if (!confirm(t('settings.delete_group_confirm'))) return;
    try {
      await api.deleteGroup(id);
      loadGroups();
    } catch (err) {
      showToast('error', t('common.error'), `${t('settings.group_failed')} ${errorText(err)}`);
    }
  };

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

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const data = await api.exportBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `gravitylan_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
      showToast('error', t('common.error'), t('settings.export_failed') + errorText(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirm(t('settings.import_confirm_warning'))) {
      e.target.value = '';
      return;
    }

    setIsImporting(true);
    try {
      await api.importBackup(file);
      // The page reloads right away, so a toast would not be seen
      alert(t('settings.import_success'));
      window.location.reload();
    } catch (err) {
      console.error('Import failed:', err);
      showToast('error', t('common.error'), t('settings.import_failed') + errorText(err));
    } finally {
      setIsImporting(false);
      e.target.value = '';
    }
  };

  const handleResetDB = async () => {
    // Two-step: the first click arms the button for 5 s
    if (!resetConfirm) {
      setResetConfirm(true);
      setTimeout(() => setResetConfirm(false), 5000);
      return;
    }

    try {
      await api.resetDatabase();
      alert(t('settings.reset_success'));
      window.location.reload();
    } catch (err) {
      console.error('Reset failed:', err);
      showToast('error', t('common.error'), `${t('settings.reset_failed')}: ${errorText(err)}`);
    }
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(i18n.resolvedLanguage);
  const formatDateTime = (iso: string) => new Date(iso).toLocaleString(i18n.resolvedLanguage);

  return (
    <div className="app-layout">
      <Sidebar active="settings" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      <main className="app-main">
        <MobileHeader title={t('sidebar.settings')} onMenuClick={() => setIsSidebarOpen(true)} />
        <div className="settings-page">
          <header className="page-header visually-hidden-mobile">
            <h1 className="page-header__title">{t('sidebar.settings')}</h1>
            <p className="page-header__subtitle">{t('settings.page_subtitle')}</p>
          </header>

          <SettingsSection id="scan" title={t('settings.section_scan')} description={t('settings.section_scan_desc')}>
            <div className="settings-grid">
              <UnitField
                id="set-scan-interval"
                label={t('settings.scan_interval_label')}
                hint={t('settings.scan_interval_hint')}
                unit={t('settings.unit_minutes')}
                value={form.scan_interval}
                onChange={setField('scan_interval')}
              />
              <UnitField
                id="set-quick-scan"
                label={t('settings.quick_scan_label')}
                hint={t('settings.quick_scan_hint')}
                unit={t('settings.unit_seconds')}
                value={form.quick_scan_interval}
                onChange={setField('quick_scan_interval')}
              />
              <UnitField
                id="set-scan-timeout"
                label={t('settings.scan_timeout_label')}
                hint={t('settings.scan_timeout_desc')}
                unit={t('settings.unit_seconds')}
                value={form.scan_timeout}
                onChange={setField('scan_timeout')}
                step={0.1}
              />
              <UnitField
                id="set-offline-threshold"
                label={t('settings.offline_threshold_label')}
                hint={t('settings.offline_threshold_hint')}
                unit={t('settings.unit_checks')}
                value={form['scanner.offline_threshold']}
                onChange={setField('scanner.offline_threshold')}
              />
              <Field id="set-dns" label={t('settings.dns_custom_title')} hint={t('settings.dns_custom_desc')}>
                <input
                  id="set-dns"
                  className="input input--mono"
                  value={form['dns.server']}
                  onChange={setField('dns.server')}
                  placeholder="192.168.1.1"
                  aria-describedby="set-dns-hint"
                />
              </Field>
            </div>
            <Field id="set-subnets" label={t('settings.subnets')} hint={t('settings.subnets_hint')}>
              <input
                id="set-subnets"
                className="input input--mono"
                value={form.scan_subnets}
                onChange={setField('scan_subnets')}
                placeholder="192.168.1.0/24, 10.0.0.0/24"
                aria-describedby="set-subnets-hint"
              />
            </Field>
          </SettingsSection>

          <SettingsSection id="system" title={t('settings.section_system')} description={t('settings.section_system_desc')}>
            <div className="settings-grid">
              <UnitField
                id="set-retention"
                label={t('settings.retention_label')}
                hint={t('settings.retention_hint')}
                unit={t('settings.unit_days')}
                value={form.history_retention_days}
                onChange={setField('history_retention_days')}
              />
              <Field id="set-log-level" label={t('settings.log_level')} hint={t('settings.log_level_desc')}>
                <select
                  id="set-log-level"
                  className="input"
                  value={form['system.log_level']}
                  onChange={setField('system.log_level')}
                  aria-describedby="set-log-level-hint"
                >
                  <option value="info">{t('settings.log_level_info')}</option>
                  <option value="warning">{t('settings.log_level_warning')}</option>
                  <option value="debug">{t('settings.log_level_debug')}</option>
                  <option value="debug_sql">{t('settings.log_level_sql')}</option>
                </select>
              </Field>
            </div>
            <Field id="set-server-url" label={t('settings.server_url_override')} hint={t('settings.server_url_override_hint')}>
              <input
                id="set-server-url"
                type="url"
                className="input input--mono"
                value={form.server_url_override}
                onChange={setField('server_url_override')}
                placeholder="http://192.168.1.10:8000"
                aria-describedby="set-server-url-hint"
              />
            </Field>
            <ActionRow title={t('settings.system_livelogs')} description={t('settings.system_livelogs_desc')}>
              <Link to="/logs" className="btn btn-secondary btn-sm">
                <FileText size={14} aria-hidden="true" /> {t('settings.system_livelogs_open')}
              </Link>
            </ActionRow>
          </SettingsSection>

          <SettingsSection id="groups" title={t('settings.manage_groups')} description={t('settings.section_groups_desc')}>
            <form className="inline-form" onSubmit={handleCreateGroup}>
              <label htmlFor="set-new-group" className="visually-hidden">{t('settings.new_group_name')}</label>
              <input
                id="set-new-group"
                className="input"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder={t('settings.new_group_name')}
              />
              <button type="submit" className="btn btn-secondary" disabled={!newGroupName.trim()}>
                <Plus size={16} aria-hidden="true" /> {t('settings.create')}
              </button>
            </form>
            <ul className="settings-list">
              {groups.map((group) => (
                <li key={group.id} className="settings-list__row">
                  <span className="settings-list__name">{group.name}</span>
                  {group.is_default ? (
                    <span className="device-tag">{t('settings.standard')}</span>
                  ) : (
                    <button
                      type="button"
                      className="btn-icon btn-icon--danger"
                      onClick={() => handleDeleteGroup(group.id)}
                      aria-label={t('settings.delete_group', { name: group.name })}
                      title={t('settings.delete_group', { name: group.name })}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </SettingsSection>

          <SettingsSection id="language" title={t('settings.language')} description={t('settings.section_language_desc')}>
            <LanguageToggle />
          </SettingsSection>

          <SettingsSection id="access" title={t('settings.password.section')} description={t('settings.password.section_desc')}>
            <PasswordForm />
          </SettingsSection>

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

            {createdToken && (
              <div className="callout callout--success" role="status">
                <Check size={16} className="callout__icon" aria-hidden="true" />
                <div className="callout__body">
                  <p>{t('settings.token_created_title')}</p>
                  <div className="inline-form">
                    <input
                      type="text"
                      readOnly
                      className="input input--mono"
                      value={createdToken}
                      aria-label={t('settings.api_tokens')}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button type="button" className="btn btn-secondary" onClick={handleCopyToken}>
                      <Copy size={16} aria-hidden="true" /> {t('settings.token_copy')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {tokens.length === 0 ? (
              <p className="settings-empty">{t('settings.no_tokens')}</p>
            ) : (
              <ul className="settings-list">
                {tokens.map((token) => (
                  <li key={token.id} className="settings-list__row">
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
                      onClick={() => handleDeleteToken(token)}
                      aria-label={t('settings.revoke_token', { name: token.name })}
                      title={t('settings.revoke_token', { name: token.name })}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>

          <SettingsSection id="backup" title={t('settings.backup_restore')} description={t('settings.section_backup_desc')}>
            <div className="callout callout--warning">
              <AlertTriangle size={16} className="callout__icon" aria-hidden="true" />
              <p className="callout__body">
                <strong>{t('settings.security_notice_title')}:</strong> {t('settings.security_notice_desc')}
              </p>
            </div>
            <ActionRow title={t('settings.backup_export')} description={t('settings.backup_export_desc')}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleExport} disabled={isExporting}>
                <Download size={14} aria-hidden="true" /> {isExporting ? t('settings.backup_exporting') : t('settings.backup_download')}
              </button>
            </ActionRow>
            <ActionRow title={t('settings.backup_import')} description={t('settings.backup_import_desc')}>
              <label className={`btn btn-secondary btn-sm btn-file${isImporting ? ' is-disabled' : ''}`}>
                <Upload size={14} aria-hidden="true" />
                {isImporting ? t('settings.backup_importing') : t('settings.backup_select_file')}
                <input
                  type="file"
                  accept=".json,application/json"
                  className="visually-hidden"
                  onChange={handleImport}
                  disabled={isImporting}
                />
              </label>
            </ActionRow>
          </SettingsSection>

          <SettingsSection id="danger" tone="danger" title={t('settings.danger_zone')} description={t('settings.section_danger_desc')}>
            <ActionRow title={t('settings.reset_db')} description={t('settings.reset_warning')}>
              <button
                type="button"
                className={`btn btn-danger btn-sm${resetConfirm ? ' is-armed' : ''}`}
                onClick={handleResetDB}
              >
                <Database size={14} aria-hidden="true" />
                {resetConfirm ? t('settings.reset_really') : t('settings.confirm_reset')}
              </button>
            </ActionRow>
          </SettingsSection>

          {(isDirty || saveStatus !== 'idle') && (
            <div className="save-bar" role="region" aria-label={t('settings.unsaved_changes')}>
              <span className="save-bar__status" role="status">
                {saveStatus === 'saved' ? (
                  <><Check size={16} className="save-bar__icon save-bar__icon--ok" aria-hidden="true" /> {t('settings.save_success')}</>
                ) : saveStatus === 'error' ? (
                  <><AlertTriangle size={16} className="save-bar__icon save-bar__icon--error" aria-hidden="true" /> {t('settings.save_error')}</>
                ) : (
                  t('settings.unsaved_changes')
                )}
              </span>
              {isDirty && (
                <div className="save-bar__actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscard} disabled={saveStatus === 'saving'}>
                    {t('settings.discard')}
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveSettings} disabled={saveStatus === 'saving'}>
                    {saveStatus === 'saving'
                      ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                      : <Check size={14} aria-hidden="true" />}
                    {saveStatus === 'saving' ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
