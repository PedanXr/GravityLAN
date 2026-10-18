import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Router, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../../../api/client';
import type { Subnet, SubnetInfo } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { normalizeCidr } from '../../Network/subnet/model';
import { GatewayFields, type GatewayPatch } from '../../Network/subnet/GatewayFields';
import { ActionRow, SettingsSection, errorText } from './SettingsParts';

/** How the container reaches a subnet, as shown next to it. */
function reachLabel(sub: Subnet, t: TFunction): string {
  if (sub.is_agent_probe) return `${t('network.l2_probe', 'L2 Probe')} (${sub.probe_device_name || sub.probe_device_ip || 'Agent'})`;
  if (sub.is_direct_l2 === false) return t('network.l3_routed', 'L3 Routed');
  return sub.interface_name ? `${t('network.l2_direct', 'L2 Direct')} (${sub.interface_name})` : t('network.l2_direct', 'L2 Direct');
}

/**
 * The scan subnets, kept in the same table as the tabs of the network overview:
 * add, pause or remove one here and the scanner and the overview follow at once.
 */
export function useScanSubnets() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [subnets, setSubnets] = useState<Subnet[]>([]);
  const [detected, setDetected] = useState<SubnetInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.getSubnetsList();
      setSubnets(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Failed to load subnets:', err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    api.getSubnets()
      .then((list) => setDetected(Array.isArray(list) ? list.filter((s) => !s.is_virtual) : []))
      .catch(() => setDetected([]));
  }, [load]);

  const reportFailure = (err: unknown) =>
    showToast('error', t('common.error'), `${t('settings.subnet_failed')} ${errorText(err)}`);

  const add = async (cidr: string, name = ''): Promise<boolean> => {
    try {
      const created = await api.createSubnet({ cidr: cidr.trim(), name: name.trim() });
      showToast('success', t('notifications.saved'), t('settings.subnet_added', { cidr: created.cidr }));
      await load();
      return true;
    } catch (err) {
      reportFailure(err);
      return false;
    }
  };

  const setEnabled = async (sub: Subnet, isEnabled: boolean) => {
    setSubnets((prev) => prev.map((s) => (s.id === sub.id ? { ...s, is_enabled: isEnabled } : s)));
    try {
      await api.updateSubnet(sub.id, { is_enabled: isEnabled });
    } catch (err) {
      reportFailure(err);
      await load();
    }
  };

  const updateGateway = async (sub: Subnet, patch: GatewayPatch) => {
    try {
      const updated = await api.updateSubnet(sub.id, patch);
      setSubnets((prev) => prev.map((s) => (s.id === sub.id ? updated : s)));
      showToast('success', t('notifications.saved'), t('subnet_gateway.saved', { cidr: sub.cidr }));
    } catch (err) {
      reportFailure(err);
    }
  };

  const remove = async (sub: Subnet) => {
    if (!confirm(t('settings.subnet_delete_confirm', { cidr: sub.cidr }))) return;
    try {
      await api.deleteSubnet(sub.id);
      await load();
    } catch (err) {
      reportFailure(err);
    }
  };

  // Networks of the container's own interfaces that are not configured yet
  const configured = new Set(subnets.map((s) => normalizeCidr(s.cidr)));
  const suggestions = detected.filter((s) => !configured.has(normalizeCidr(s.subnet)));

  return { subnets, detected, suggestions, loaded, add, setEnabled, updateGateway, remove };
}

/** "Gateway 192.168.110.1 · VLAN 110", or the automatic gateway when none is entered. */
function gatewayLabel(sub: Subnet, t: TFunction): string {
  const ip = sub.gateway_ip || sub.gateway_suggestion;
  const parts = ip ? [`${t('subnet_gateway.gateway')} ${ip}${sub.gateway_ip ? '' : ` (${t('subnet_gateway.auto')})`}`] : [];
  if (sub.vlan_id != null) parts.push(`VLAN ${sub.vlan_id}`);
  return parts.join(' · ');
}

export function SubnetsSection() {
  const { t } = useTranslation();
  const { subnets, detected, suggestions, loaded, add, setEnabled, updateGateway, remove } = useScanSubnets();
  const [editing, setEditing] = useState<number | null>(null);
  const [cidr, setCidr] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cidr.trim()) return;
    setAdding(true);
    if (await add(cidr, name)) {
      setCidr('');
      setName('');
    }
    setAdding(false);
  };

  return (
    <SettingsSection id="subnets" title={t('settings.subnets')} description={t('settings.subnets_desc')}>
      <form className="inline-form inline-form--wrap" onSubmit={submit}>
        <label htmlFor="set-subnet-cidr" className="visually-hidden">{t('settings.subnet_cidr')}</label>
        <input
          id="set-subnet-cidr"
          className="input input--mono"
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          placeholder="192.168.110.0/24"
          aria-describedby="set-subnets-hint"
        />
        <label htmlFor="set-subnet-name" className="visually-hidden">{t('settings.subnet_name')}</label>
        <input
          id="set-subnet-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.subnet_name_placeholder')}
        />
        <button type="submit" className="btn btn-secondary" disabled={!cidr.trim() || adding}>
          <Plus size={16} aria-hidden="true" /> {t('settings.subnet_add')}
        </button>
      </form>
      <p className="field-hint" id="set-subnets-hint">{t('settings.subnets_hint')}</p>

      {loaded && subnets.length === 0 && (
        <p className="settings-empty">
          {detected.length > 0
            ? t('settings.subnets_empty_auto', { subnets: detected.map((s) => s.subnet).join(', ') })
            : t('settings.subnets_empty')}
        </p>
      )}

      {subnets.length > 0 && (
        <ul className="settings-list" aria-label={t('settings.subnets')}>
          {subnets.map((sub) => (
            <li key={sub.id} className={`settings-list__row${sub.is_enabled ? '' : ' is-paused'}${editing === sub.id ? ' is-editing' : ''}`}>
              <div className="settings-list__main">
                <span className="settings-list__name">{sub.name}</span>
                <span className="settings-list__meta">
                  <code>{sub.cidr}</code> · {reachLabel(sub, t)}
                  {!sub.is_enabled && <> · {t('settings.subnet_paused')}</>}
                </span>
                {gatewayLabel(sub, t) && <span className="settings-list__meta">{gatewayLabel(sub, t)}</span>}
              </div>
              <div className="settings-list__actions">
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setEditing(editing === sub.id ? null : sub.id)}
                  aria-expanded={editing === sub.id}
                  aria-label={t('subnet_gateway.edit', { cidr: sub.cidr })}
                  title={t('subnet_gateway.edit', { cidr: sub.cidr })}
                >
                  <Router size={15} aria-hidden="true" />
                </button>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={sub.is_enabled}
                    onChange={(e) => setEnabled(sub, e.target.checked)}
                    aria-label={t('settings.subnet_scan_label', { cidr: sub.cidr })}
                  />
                  <span aria-hidden="true">{t('settings.subnet_scan')}</span>
                </label>
                <button
                  type="button"
                  className="btn-icon btn-icon--danger"
                  onClick={() => remove(sub)}
                  aria-label={t('settings.subnet_delete', { cidr: sub.cidr })}
                  title={t('settings.subnet_delete', { cidr: sub.cidr })}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
              {editing === sub.id && <GatewayFields subnet={sub} onSave={(patch) => updateGateway(sub, patch)} />}
            </li>
          ))}
        </ul>
      )}

      {subnets.length > 0 && suggestions.length > 0 && (
        <div className="settings-field">
          <p className="form-label">{t('settings.subnets_detected')}</p>
          <ul className="settings-list" aria-label={t('settings.subnets_detected')}>
            {suggestions.map((s) => (
              <li key={s.subnet} className="settings-list__row">
                <div className="settings-list__main">
                  <span className="settings-list__name"><code>{s.subnet}</code></span>
                  <span className="settings-list__meta">{s.interface_name} · {s.ip_address}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => add(s.subnet, s.interface_name)}
                  aria-label={t('settings.subnet_add_detected', { cidr: s.subnet })}
                >
                  <Plus size={14} aria-hidden="true" /> {t('settings.subnet_add')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ActionRow title={t('settings.subnets_overview')} description={t('settings.subnets_overview_desc')}>
        <Link to="/network" className="btn btn-secondary btn-sm">{t('settings.subnets_overview_open')}</Link>
      </ActionRow>
    </SettingsSection>
  );
}
