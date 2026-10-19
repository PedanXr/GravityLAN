import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { api } from '../../../api/client';

/** Settings saved together through the save bar, keyed as the backend stores them. */
export type SettingsForm = {
  scan_interval: string;
  quick_scan_interval: string;
  scan_timeout: string;
  'scanner.offline_threshold': string;
  'dns.server': string;
  history_retention_days: string;
  server_url_override: string;
  'system.log_level': string;
  'ui.start_page': string;
};

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export type FieldSetter = (key: keyof SettingsForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;

const DEFAULT_FORM: SettingsForm = {
  scan_interval: '0',
  quick_scan_interval: '300',
  scan_timeout: '1.5',
  'scanner.offline_threshold': '3',
  'dns.server': '',
  history_retention_days: '7',
  server_url_override: '',
  'system.log_level': 'info',
  'ui.start_page': '/',
};

const FORM_KEYS = Object.keys(DEFAULT_FORM) as (keyof SettingsForm)[];

function toForm(settings: Record<string, string>): SettingsForm {
  const form = { ...DEFAULT_FORM };
  for (const key of FORM_KEYS) {
    if (settings[key]) form[key] = settings[key];
  }
  return form;
}

/** The editable settings, the last saved copy to compare against, and saving/discarding. */
export function useSettingsForm() {
  const [form, setForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [savedForm, setSavedForm] = useState<SettingsForm>(DEFAULT_FORM);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  const loadSettings = useCallback(async () => {
    try {
      const loaded = toForm(await api.getSettings());
      setForm(loaded);
      setSavedForm(loaded);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const isDirty = FORM_KEYS.some((key) => form[key] !== savedForm[key]);

  const setField: FieldSetter = (key) => (e) => {
    const { value } = e.target;
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveStatus((status) => (status === 'saving' ? status : 'idle'));
  };

  const save = async () => {
    setSaveStatus('saving');
    try {
      await api.updateSettings(form);
      localStorage.setItem('gravitylan_start_page', form['ui.start_page']);
      await loadSettings();
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus((status) => (status === 'saved' ? 'idle' : status)), 3000);
    } catch (err) {
      console.error('Save failed:', err);
      setSaveStatus('error');
    }
  };

  const discard = () => {
    setForm(savedForm);
    setSaveStatus('idle');
  };

  return { form, setField, isDirty, saveStatus, save, discard };
}
