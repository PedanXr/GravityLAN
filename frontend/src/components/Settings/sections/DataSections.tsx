import { useState, type ChangeEvent } from 'react';
import { AlertTriangle, Database, Download, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { useToast } from '../../../context/ToastContext';
import { ActionRow, SettingsSection, errorText } from './SettingsParts';

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/** Export all data as JSON, or overwrite everything from such a file. */
export function BackupSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const data = await api.exportBackup();
      downloadJson(data, `gravitylan_backup_${new Date().toISOString().split('T')[0]}.json`);
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

  return (
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
  );
}

/** Database reset behind a two-step button. */
export function DangerSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [resetConfirm, setResetConfirm] = useState(false);

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

  return (
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
  );
}
