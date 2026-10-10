import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { DeviceHistoryResponse } from '../../../types';

export function HistoryTab({ history, isLoading }: { history: DeviceHistoryResponse[]; isLoading: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="history-timeline" style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '8px' }}>
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)' }}>
          <RefreshCw size={24} className="spinning" style={{ marginBottom: 10 }} />
          <p>{t('common.loading')}</p>
        </div>
      ) : history.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 'var(--space-xl)', color: 'var(--text-tertiary)' }}>
          <p>{t('notifications.no_events')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          {Array.isArray(history) && history.map((item) => <HistoryItem key={item.id} item={item} />)}
        </div>
      )}
    </div>
  );
}

function HistoryItem({ item }: { item: DeviceHistoryResponse }) {
  const { t } = useTranslation();
  const isUp = item.status === 'online' || item.status === 'up';
  return (
    <div style={{
      padding: 'var(--space-md)',
      background: 'var(--bg-input)',
      borderRadius: 'var(--radius-md)',
      borderLeft: `4px solid ${isUp ? 'var(--accent-success)' : 'var(--accent-danger)'}`,
      animation: 'slideUp 0.3s ease-out'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontWeight: 700,
            textTransform: 'uppercase',
            fontSize: '0.7rem',
            color: isUp ? 'var(--accent-success)' : 'var(--accent-danger)',
            background: isUp ? 'rgba(79, 209, 197, 0.1)' : 'rgba(255, 107, 107, 0.1)',
            padding: '2px 6px',
            borderRadius: 4
          }}>
            {item.status}
          </span>
          {item.service_id && (
            <span style={{ fontSize: '0.7rem', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4, color: 'var(--text-secondary)' }}>
              SERVICE
            </span>
          )}
        </div>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          {item.timestamp ? new Date(item.timestamp).toLocaleString() : t('common.loading')}
        </span>
      </div>
      <p style={{ fontSize: '0.875rem', margin: 0, fontWeight: item.service_id ? 500 : 400, color: 'var(--text-primary)' }}>
        {item.message}
      </p>
    </div>
  );
}
