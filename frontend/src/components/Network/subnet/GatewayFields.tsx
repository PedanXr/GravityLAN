import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Subnet } from '../../../types';

export interface GatewayPatch {
  gateway_ip?: string | null;
  vlan_id?: number | null;
}

/**
 * Gateway address and VLAN tag of one subnet. An empty gateway means "automatic":
 * the container's default route in this network, else `.1`, shown as placeholder.
 * Each field saves on blur when its value changed.
 */
export function GatewayFields({ subnet, onSave }: { subnet: Subnet; onSave: (patch: GatewayPatch) => void }) {
  const { t } = useTranslation();
  const [gateway, setGateway] = useState(subnet.gateway_ip ?? '');
  const [vlan, setVlan] = useState(subnet.vlan_id != null ? String(subnet.vlan_id) : '');
  const auto = subnet.gateway_suggestion
    ? t(subnet.gateway_source === 'detected' ? 'subnet_gateway.auto_detected' : 'subnet_gateway.auto_suggested', { ip: subnet.gateway_suggestion })
    : t('subnet_gateway.gateway');

  const saveGateway = () => {
    const value = gateway.trim();
    if (value !== (subnet.gateway_ip ?? '')) onSave({ gateway_ip: value || null });
  };
  const saveVlan = () => {
    const value = vlan.trim();
    const current = subnet.vlan_id != null ? String(subnet.vlan_id) : '';
    if (value !== current) onSave({ vlan_id: value ? Number(value) : null });
  };

  return (
    <div className="subnet-gateway-fields">
      <label className="subnet-gateway-fields__field">
        <span className="subnet-gateway-fields__label">{t('subnet_gateway.gateway')}</span>
        <input
          className="input input--mono"
          value={gateway}
          onChange={(e) => setGateway(e.target.value)}
          onBlur={saveGateway}
          placeholder={auto}
          inputMode="decimal"
          aria-label={t('subnet_gateway.gateway_for', { cidr: subnet.cidr })}
        />
      </label>
      <label className="subnet-gateway-fields__field subnet-gateway-fields__field--vlan">
        <span className="subnet-gateway-fields__label">{t('subnet_gateway.vlan')}</span>
        <input
          className="input input--mono"
          type="number"
          min={1}
          max={4094}
          value={vlan}
          onChange={(e) => setVlan(e.target.value)}
          onBlur={saveVlan}
          placeholder="—"
          aria-label={t('subnet_gateway.vlan_for', { cidr: subnet.cidr })}
        />
      </label>
    </div>
  );
}
