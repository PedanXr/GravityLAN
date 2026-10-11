import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { DeviceGroup } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { SettingsSection, errorText } from './SettingsParts';

export function GroupsSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [newGroupName, setNewGroupName] = useState('');

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await api.getGroups());
    } catch (err) {
      console.error('Failed to load groups:', err);
    }
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const reportFailure = (err: unknown) =>
    showToast('error', t('common.error'), `${t('settings.group_failed')} ${errorText(err)}`);

  const handleCreateGroup = async (e: FormEvent) => {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await api.createGroup({ name, icon: 'folder' });
      setNewGroupName('');
      loadGroups();
    } catch (err) {
      reportFailure(err);
    }
  };

  const handleDeleteGroup = async (id: number) => {
    if (!confirm(t('settings.delete_group_confirm'))) return;
    try {
      await api.deleteGroup(id);
      loadGroups();
    } catch (err) {
      reportFailure(err);
    }
  };

  return (
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
  );
}
