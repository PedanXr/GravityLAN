import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { Device } from '../../types';
import { chipName, deviceNetworks, type NetworkChip } from '../../utils/networks';

/** One chip per network a multi-homed device (e.g. a VLAN router) answers in. */
export function NetworkChips({ device }: { device: Device }) {
  const { t } = useTranslation();
  const chips = deviceNetworks(device);
  if (chips.length < 2) return null;
  const name = device.display_name || device.hostname || device.ip;
  return (
    <ul className="net-chips" aria-label={t('interfaces.networks_of', { name })}>
      {chips.map((chip) => <Chip key={chip.ip} chip={chip} />)}
    </ul>
  );
}

function Chip({ chip }: { chip: NetworkChip }) {
  const { t } = useTranslation();
  const status = chip.isOnline ? t('network.online') : t('network.offline');
  const vlan = chip.vlanId != null ? ` · VLAN ${chip.vlanId}` : '';
  const role = chip.isPrimary ? ` · ${t('interfaces.primary')}` : '';
  return (
    <li
      className={`net-chip ${chip.isOnline ? '' : 'is-offline'}`}
      style={{ '--net-color': chip.color } as CSSProperties}
      title={`${chip.ip}${vlan}${role} · ${status}`}
    >
      <span className="net-chip__dot" aria-hidden="true" />
      <span className="net-chip__name">{chipName(chip)}</span>
      {chip.vlanId != null && <span className="net-chip__vlan">{chip.vlanId}</span>}
      <span className="visually-hidden">{`${chip.ip}, ${status}`}</span>
    </li>
  );
}
