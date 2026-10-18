import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { GitMerge, Plus, Unlink } from 'lucide-react';
import { api } from '../../../api/client';
import type { Device, DeviceInterface, MergeSuggestion } from '../../../types';
import { useToast } from '../../../context/ToastContext';
import { chipName, deviceNetworks, networkColor, type NetworkChip } from '../../../utils/networks';
import { errorMessage } from './deviceForm';

interface InterfacesTabProps {
  device: Device;
  /** The device's interfaces changed: reload the dashboard */
  onChanged: () => void;
  /** This device was merged into another one and no longer exists */
  onMergedAway: () => void;
  /** Fresh interface list, e.g. for the tab's address count */
  onInterfaces?: (interfaces: DeviceInterface[]) => void;
}

/** Addresses of a multi-homed device (router with VLAN gateways) and merge suggestions. */
export function InterfacesTab({ device, onChanged, onMergedAway, onInterfaces }: InterfacesTabProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [interfaces, setInterfaces] = useState<DeviceInterface[]>(device.interfaces ?? []);
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [ifaces, merge] = await Promise.all([
      api.getDeviceInterfaces(device.id),
      api.getMergeSuggestions().catch(() => [] as MergeSuggestion[]),
    ]);
    setInterfaces(ifaces);
    setSuggestions(merge);
    onInterfaces?.(ifaces);
  }, [device.id, onInterfaces]);

  useEffect(() => {
    reload().catch((err) => console.error('Failed to load interfaces:', err));
  }, [reload]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      showToast('success', t('common.success'), success);
      await reload();
      onChanged();
    } catch (err) {
      showToast('error', t('common.error'), errorMessage(err) || t('common.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const mergeAway = async (s: MergeSuggestion, deviceName: string) => {
    if (!window.confirm(t('interfaces.merge_confirm', { name: deviceName, ip: device.ip, target: s.target_name }))) return;
    setBusy(true);
    try {
      await api.mergeIntoDevice(s.target_id, { source_device_id: device.id });
      showToast('success', t('common.success'), t('interfaces.merged', { ip: device.ip, target: s.target_name }));
      onChanged();
      onMergedAway();
    } catch (err) {
      showToast('error', t('common.error'), errorMessage(err) || t('common.unknown'));
      setBusy(false);
    }
  };

  const forThis = suggestions.filter((s) => s.target_id === device.id);
  const mergeMe = suggestions.filter((s) => s.candidate.kind === 'device' && s.candidate.id === device.id);
  const deviceName = device.display_name || device.hostname || device.ip;
  const chips = deviceNetworks({ ...device, interfaces });

  return (
    <div className="iface-tab">
      {mergeMe.map((s) => (
        <MergeAwayCallout
          key={s.target_id}
          suggestion={s}
          deviceName={deviceName}
          busy={busy}
          onMerge={() => mergeAway(s, deviceName)}
          onDismiss={() => run(
            () => api.dismissMergeSuggestion({ target_id: s.target_id, kind: 'device', candidate_ip: device.ip }),
            t('interfaces.dismissed'),
          )}
        />
      ))}

      <section className="iface-section" aria-labelledby="iface-list-title">
        <h3 id="iface-list-title" className="iface-section__title">{t('interfaces.addresses')}</h3>
        <p className="iface-section__hint">{t('interfaces.addresses_hint')}</p>
        <ul className="iface-list">
          {chips.map((chip) => (
            <AddressRow
              key={chip.ip}
              chip={chip}
              iface={interfaces.find((i) => i.id === chip.interfaceId) ?? null}
              mac={chip.isPrimary ? device.mac : null}
              busy={busy}
              onLabel={(iface, label) => run(
                () => api.updateDeviceInterface(device.id, iface.id, { label: label || null }),
                t('interfaces.saved'),
              )}
              onRemove={(iface) => {
                if (!window.confirm(t('interfaces.remove_confirm', { ip: iface.ip }))) return;
                run(() => api.removeDeviceInterface(device.id, iface.id), t('interfaces.removed', { ip: iface.ip }));
              }}
            />
          ))}
        </ul>
        <AddInterfaceForm
          busy={busy}
          onAdd={(ip, label) => run(() => api.addDeviceInterface(device.id, { ip, label: label || null }), t('interfaces.added', { ip }))}
        />
      </section>

      {forThis.length > 0 && (
        <section className="iface-section" aria-labelledby="iface-suggestions-title">
          <h3 id="iface-suggestions-title" className="iface-section__title">{t('interfaces.suggestions')}</h3>
          <p className="iface-section__hint">{t('interfaces.suggestions_hint', { name: deviceName })}</p>
          <ul className="iface-list">
            {forThis.map((s) => (
              <SuggestionRow
                key={`${s.candidate.kind}:${s.candidate.id}`}
                suggestion={s}
                busy={busy}
                onMerge={() => {
                  const c = s.candidate;
                  if (c.kind === 'device' && !window.confirm(
                    t('interfaces.merge_confirm', { name: c.name || c.ip, ip: c.ip, target: deviceName }),
                  )) return;
                  run(
                    () => api.mergeIntoDevice(device.id, c.kind === 'device' ? { source_device_id: c.id } : { ip: c.ip }),
                    t('interfaces.merged', { ip: c.ip, target: deviceName }),
                  );
                }}
                onDismiss={() => run(
                  () => api.dismissMergeSuggestion({ target_id: device.id, kind: s.candidate.kind, candidate_ip: s.candidate.ip }),
                  t('interfaces.dismissed'),
                )}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function netMeta(chip: NetworkChip, noSubnet: string): string {
  const parts = [chipName(chip) !== chip.ip ? chipName(chip) : noSubnet];
  if (chip.vlanId != null) parts.push(`VLAN ${chip.vlanId}`);
  return parts.join(' · ');
}

interface AddressRowProps {
  chip: NetworkChip;
  iface: DeviceInterface | null;
  mac: string | null;
  busy: boolean;
  onLabel: (iface: DeviceInterface, label: string) => void;
  onRemove: (iface: DeviceInterface) => void;
}

function AddressRow({ chip, iface, mac, busy, onLabel, onRemove }: AddressRowProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(iface?.label ?? '');
  const status = chip.isOnline ? t('network.online') : t('network.offline');
  const shownMac = iface ? iface.mac : mac;
  const lastSeen = iface?.last_seen ? new Date(iface.last_seen).toLocaleString() : null;

  return (
    <li className={`iface-row ${chip.isPrimary ? 'is-primary' : ''}`} style={{ '--net-color': chip.color } as CSSProperties}>
      <span className={`status-dot ${chip.isOnline ? 'status-dot--online' : 'status-dot--offline'}`} role="img" aria-label={status} title={status} />
      <div className="iface-row__main">
        <div className="iface-row__line">
          <span className="iface-row__ip">{chip.ip}</span>
          {chip.isPrimary && <span className="device-tag">{t('interfaces.primary')}</span>}
          {iface && (
            <input
              className="iface-row__label"
              value={label}
              maxLength={100}
              placeholder={t('interfaces.label_placeholder')}
              aria-label={t('interfaces.label_for', { ip: chip.ip })}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => { if (label.trim() !== (iface.label ?? '')) onLabel(iface, label.trim()); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          )}
        </div>
        <div className="iface-row__meta">
          <span className="iface-row__net"><span className="net-chip__dot" aria-hidden="true" />{netMeta(chip, t('interfaces.no_subnet'))}</span>
          {shownMac && <span className="iface-row__mac">{shownMac}</span>}
          {lastSeen && <span>{t('interfaces.last_seen', { when: lastSeen })}</span>}
        </div>
      </div>
      {iface && (
        <button
          type="button"
          className="btn-icon btn-icon--danger"
          onClick={() => onRemove(iface)}
          disabled={busy}
          aria-label={t('interfaces.remove', { ip: iface.ip })}
          title={t('interfaces.remove', { ip: iface.ip })}
        >
          <Unlink size={15} />
        </button>
      )}
    </li>
  );
}

function AddInterfaceForm({ busy, onAdd }: { busy: boolean; onAdd: (ip: string, label: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [ip, setIp] = useState('');
  const [label, setLabel] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ip.trim()) return;
    await onAdd(ip.trim(), label.trim());
    setIp('');
    setLabel('');
  };
  return (
    <form className="iface-add" onSubmit={submit}>
      <input
        className="input iface-add__ip"
        value={ip}
        onChange={(e) => setIp(e.target.value)}
        placeholder="192.168.110.1"
        aria-label={t('interfaces.add_ip')}
        inputMode="decimal"
      />
      <input
        className="input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('interfaces.label_placeholder')}
        aria-label={t('interfaces.add_label')}
        maxLength={100}
      />
      <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !ip.trim()}>
        <Plus size={14} aria-hidden="true" /> {t('interfaces.add')}
      </button>
    </form>
  );
}

function ReasonTags({ reasons }: { reasons: MergeSuggestion['reasons'] }) {
  const { t } = useTranslation();
  return (
    <span className="iface-reasons">
      {reasons.map((r) => <span key={r} className="device-tag">{t(`interfaces.reason_${r}`)}</span>)}
    </span>
  );
}

interface SuggestionRowProps {
  suggestion: MergeSuggestion;
  busy: boolean;
  onMerge: () => void;
  onDismiss: () => void;
}

function SuggestionRow({ suggestion, busy, onMerge, onDismiss }: SuggestionRowProps) {
  const { t } = useTranslation();
  const c = suggestion.candidate;
  return (
    <li className="iface-row iface-row--suggestion" style={{ '--net-color': networkColor(c.subnet_id, c.ip) } as CSSProperties}>
      <span className={`status-dot ${c.is_online ? 'status-dot--online' : 'status-dot--offline'}`} aria-hidden="true" />
      <div className="iface-row__main">
        <div className="iface-row__line">
          <span className="iface-row__ip">{c.ip}</span>
          {c.name && <span className="iface-row__name">{c.name}</span>}
          <span className="device-tag">{t(c.kind === 'device' ? 'interfaces.kind_device' : 'interfaces.kind_discovered')}</span>
        </div>
        <div className="iface-row__meta">
          {c.subnet_name && <span>{c.subnet_name}</span>}
          <ReasonTags reasons={suggestion.reasons} />
        </div>
        <div className="iface-row__actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onMerge} disabled={busy}>
            <GitMerge size={14} aria-hidden="true" /> {t('interfaces.merge_as_interface', { target: suggestion.target_name })}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss} disabled={busy}>
            {t('interfaces.dismiss')}
          </button>
        </div>
      </div>
    </li>
  );
}

interface MergeAwayProps {
  suggestion: MergeSuggestion;
  deviceName: string;
  busy: boolean;
  onMerge: () => void;
  onDismiss: () => void;
}

function MergeAwayCallout({ suggestion, deviceName, busy, onMerge, onDismiss }: MergeAwayProps) {
  const { t } = useTranslation();
  return (
    <div className="iface-callout" role="note">
      <GitMerge size={16} aria-hidden="true" />
      <div className="iface-callout__body">
        <p>{t('interfaces.looks_like_interface', { name: deviceName, target: suggestion.target_name, ip: suggestion.target_ip })}</p>
        <ReasonTags reasons={suggestion.reasons} />
        <div className="iface-row__actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onMerge} disabled={busy}>
            {t('interfaces.merge_as_interface', { target: suggestion.target_name })}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDismiss} disabled={busy}>
            {t('interfaces.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
