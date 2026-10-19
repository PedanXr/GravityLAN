import { Link } from 'react-router-dom';
import { AlertTriangle, Check, FileText, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionRow, Field, SettingsSection, UnitField } from './SettingsParts';
import type { FieldSetter, SaveStatus, SettingsForm } from './useSettingsForm';

interface FormSectionProps {
  form: SettingsForm;
  setField: FieldSetter;
}

export function ScanSection({ form, setField }: FormSectionProps) {
  const { t } = useTranslation();
  return (
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
    </SettingsSection>
  );
}

export function SystemSection({ form, setField }: FormSectionProps) {
  const { t } = useTranslation();
  return (
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
        <Field id="set-start-page" label={t('settings.start_page_label')} hint={t('settings.start_page_hint')}>
          <select
            id="set-start-page"
            className="input"
            value={form['ui.start_page']}
            onChange={setField('ui.start_page')}
          >
            <option value="/">{t('settings.start_page_dashboard')}</option>
            <option value="/health">{t('settings.start_page_health')}</option>
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
  );
}

function SaveStatusText({ status }: { status: SaveStatus }) {
  const { t } = useTranslation();
  if (status === 'saved') {
    return <><Check size={16} className="save-bar__icon save-bar__icon--ok" aria-hidden="true" /> {t('settings.save_success')}</>;
  }
  if (status === 'error') {
    return <><AlertTriangle size={16} className="save-bar__icon save-bar__icon--error" aria-hidden="true" /> {t('settings.save_error')}</>;
  }
  return <>{t('settings.unsaved_changes')}</>;
}

/** Sticky bar while there are unsaved changes or a save result to show. */
export function SaveBar({ isDirty, status, onSave, onDiscard }: {
  isDirty: boolean;
  status: SaveStatus;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  if (!isDirty && status === 'idle') return null;
  const saving = status === 'saving';

  return (
    <div className="save-bar" role="region" aria-label={t('settings.unsaved_changes')}>
      <span className="save-bar__status" role="status">
        <SaveStatusText status={status} />
      </span>
      {isDirty && (
        <div className="save-bar__actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDiscard} disabled={saving}>
            {t('settings.discard')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={saving}>
            {saving
              ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              : <Check size={14} aria-hidden="true" />}
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}
