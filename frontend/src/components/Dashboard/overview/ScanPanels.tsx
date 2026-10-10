import { useTranslation } from 'react-i18next';
import type { ScanProgress, SubnetInfo } from '../../../types';

export function ScanProgressBar({ progress }: { progress: ScanProgress }) {
  const { t } = useTranslation();
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      padding: 'var(--space-md)',
      borderRadius: 'var(--radius-lg)',
      marginBottom: 'var(--space-xl)',
      border: '1px solid var(--border-color)',
      animation: 'fadeIn 0.3s ease-out'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-xs)', fontSize: '0.875rem' }}>
        <span style={{ fontWeight: 600, color: 'var(--primary)' }}>{progress.message}</span>
        <span style={{ color: 'var(--text-tertiary)' }}>
          {progress.hosts_scanned} / {progress.hosts_total} IPs
        </span>
      </div>
      <div style={{
        height: 8,
        background: 'var(--bg-tertiary)',
        borderRadius: 4,
        overflow: 'hidden',
        marginBottom: 'var(--space-xs)'
      }}>
        <div style={{
          height: '100%',
          background: 'var(--primary)',
          width: `${(progress.hosts_scanned / progress.hosts_total) * 100 || 0}%`,
          transition: 'width 0.3s ease-out'
        }} />
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
        {t('dashboard.devices_found', { count: progress.devices_found })}
      </div>
    </div>
  );
}

interface SubnetModalProps {
  subnets: SubnetInfo[];
  selected: string;
  onSelect: (subnet: string) => void;
  onClose: () => void;
  onStart: () => void;
}

export function SubnetModal({ subnets, selected, onSelect, onClose, onStart }: SubnetModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 450 }}>
        <div className="modal-header">
          <h3>{t('dashboard.select_network')}</h3>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: 'var(--space-md)', color: 'var(--text-secondary)' }}>
            {t('dashboard.select_subnet_prompt')}
          </p>
          <div className="form-group">
            {subnets.map((s) => {
              const isSelected = selected === s.subnet;
              return (
                <label key={`${s.subnet}-${s.ip_address}`} className="radio-item" style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                  padding: 'var(--space-md)',
                  background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: 'var(--space-xs)',
                  cursor: 'pointer',
                  border: isSelected ? '1px solid var(--primary)' : '1px solid transparent',
                  transition: 'all 0.2s ease'
                }}>
                  <input
                    type="radio"
                    name="subnet"
                    value={s.subnet}
                    checked={isSelected}
                    onChange={() => onSelect(s.subnet)}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{s.subnet}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                      Interface: {s.interface_name} ({s.ip_address})
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={onStart}>{t('dashboard.start_scan')}</button>
        </div>
      </div>
    </div>
  );
}
