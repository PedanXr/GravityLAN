import { useTranslation } from 'react-i18next';
import { Edit3, Grid, List, RefreshCw, Save, Trash2, Zap } from 'lucide-react';
import { NotificationCenter } from '../NotificationCenter';
import { GatewaysPopover, type OpenDevice } from './GatewaysPopover';

interface DashboardToolbarProps {
  onOpenDevice: OpenDevice;
  isMobile: boolean;
  viewMode: 'grid' | 'list';
  onViewMode: (mode: 'grid' | 'list') => void;
  isEditMode: boolean;
  onToggleEdit: () => void;
  selectedCount: number;
  onBulkDelete: () => void;
  onCompact: () => void;
  onResetLayout: () => void;
  isRefreshingAll: boolean;
  isScanning: boolean;
  onRefreshAll: () => void;
  onScan: () => void;
  outdatedAgents: number;
  onShowUpdates: () => void;
}

export function DashboardToolbar(props: DashboardToolbarProps) {
  const { t } = useTranslation();
  const { isMobile, isEditMode, onToggleEdit } = props;
  return (
    <div style={{
      display: 'flex',
      gap: 'var(--space-sm)',
      alignItems: 'center',
      flexWrap: 'wrap'
    }}>
      {!isMobile && <ViewToggle viewMode={props.viewMode} onViewMode={props.onViewMode} />}

      {!isEditMode && <GatewaysPopover onOpenDevice={props.onOpenDevice} />}

      <NotificationCenter />

      {isEditMode && <EditActions {...props} />}

      <button
        className={`btn btn-sm ${isEditMode ? 'btn-primary' : 'btn-secondary'}`}
        onClick={onToggleEdit}
        aria-label={isMobile ? t(isEditMode ? 'dashboard.edit_finish' : 'dashboard.edit_layout') : undefined}
      >
        {isEditMode
          ? <><Save size={16} /> {t('dashboard.edit_finish')}</>
          : <><Edit3 size={16} /> {!isMobile && t('dashboard.edit_layout')}</>}
      </button>

      {!isEditMode && <ViewActions {...props} />}
    </div>
  );
}

function ViewToggle({ viewMode, onViewMode }: Pick<DashboardToolbarProps, 'viewMode' | 'onViewMode'>) {
  const { t } = useTranslation();
  const modes = [
    { id: 'grid' as const, icon: Grid, label: t('dashboard.view_grid', 'Kacheln') },
    { id: 'list' as const, icon: List, label: t('dashboard.view_list', 'Liste') },
  ];
  return (
    <div className="view-toggle" role="group" aria-label={t('dashboard.view_mode', 'Ansicht')}>
      {modes.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          className={`view-toggle__btn ${viewMode === id ? 'active' : ''}`}
          onClick={() => onViewMode(id)}
          aria-pressed={viewMode === id}
          aria-label={label}
          title={label}
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  );
}

function EditActions({ selectedCount, viewMode, onBulkDelete, onCompact, onResetLayout }: DashboardToolbarProps) {
  const { t } = useTranslation();
  return (
    <>
      {selectedCount > 0 && (
        <button className="btn btn-danger btn-sm" onClick={onBulkDelete}>
          <Trash2 size={16} /> {t('dashboard.delete_selected', { count: selectedCount })}
        </button>
      )}
      {viewMode === 'grid' && (
        <button className="btn btn-secondary btn-sm" onClick={onCompact} title={t('dashboard.compact_hint')}>
          <Grid size={16} /> {t('dashboard.compact')}
        </button>
      )}
      <button className="btn btn-secondary btn-sm" onClick={onResetLayout}>
        <Trash2 size={16} /> {t('dashboard.reset_layout')}
      </button>
    </>
  );
}

function ViewActions({ isMobile, isRefreshingAll, isScanning, onRefreshAll, onScan, outdatedAgents, onShowUpdates }: DashboardToolbarProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        className="btn btn-secondary btn-sm"
        onClick={onRefreshAll}
        disabled={isRefreshingAll || isScanning}
        aria-label={isMobile ? t('dashboard.refresh_all') : undefined}
      >
        <RefreshCw size={16} className={isRefreshingAll ? 'spinning' : ''} />
        {!isMobile && (isRefreshingAll ? t('dashboard.refreshing') : t('dashboard.refresh_all'))}
      </button>

      <button
        id="dashboard-scan-btn"
        onClick={onScan}
        disabled={isScanning}
        className={`btn btn-sm flex items-center gap-2 ${isScanning ? 'btn-secondary' : 'btn-primary shadow-lg shadow-primary/20'}`}
      >
        {isScanning ? (
          <>
            <div className="loading loading-spinner loading-xs"></div>
            <span>{t('dashboard.scanning', 'Scanning...')}</span>
          </>
        ) : (
          <>
            <Zap size={14} className="text-yellow-400" />
            <span>{t('dashboard.scan', 'Scan')}</span>
          </>
        )}
      </button>

      {outdatedAgents > 0 && (
        <button
          className="btn btn-warning btn-sm"
          onClick={onShowUpdates}
          aria-label={isMobile ? `${outdatedAgents} ${t('dashboard.agent_updates')}` : undefined}
        >
          <RefreshCw size={16} className="pulse" />
          {outdatedAgents} {!isMobile && t('dashboard.agent_updates')}
        </button>
      )}
    </>
  );
}
