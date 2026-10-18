import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

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

  const startEditing = (group: DeviceGroup) => {
    setEditingId(group.id);
    setEditingName(group.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingName('');
  };

  const handleSaveRename = async (e: FormEvent) => {
    e.preventDefault();
    if (editingId === null) return;
    const trimmed = editingName.trim();
    const current = groups.find((g) => g.id === editingId);
    if (!trimmed) return;
    if (current && trimmed === current.name) {
      cancelEditing();
      return;
    }
    try {
      await api.updateGroup(editingId, { name: trimmed });
      showToast('success', t('notifications.saved'), t('settings.group_renamed'));
      cancelEditing();
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
            {editingId === group.id ? (
              <form className="settings-list__edit-form" onSubmit={handleSaveRename}>
                <input
                  type="text"
                  className="input"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') cancelEditing();
                  }}
                  autoFocus
                  maxLength={100}
                  aria-label={t('settings.edit_group', { name: group.name })}
                />
                <div className="settings-list__actions">
                  <button
                    type="submit"
                    className="btn-icon"
                    disabled={!editingName.trim() || editingName.trim() === group.name}
                    aria-label={t('common.save')}
                    title={t('common.save')}
                  >
                    <Check size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={cancelEditing}
                    aria-label={t('common.cancel')}
                    title={t('common.cancel')}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </form>
            ) : (
              <>
                <span className="settings-list__name">{group.name}</span>
                <div className="settings-list__actions">
                  {group.is_default && (
                    <span className="device-tag">{t('settings.standard')}</span>
                  )}
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => startEditing(group)}
                    aria-label={t('settings.edit_group', { name: group.name })}
                    title={t('settings.rename_group')}
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                  {!group.is_default && (
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
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
