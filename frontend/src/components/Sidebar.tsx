import { LayoutDashboard, Activity, Settings, Network, X, Grid3x3, Server, ScrollText, SquareTerminal, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveSshSessions } from './Ssh/sessionCount';

interface NavItem {
  id: string;
  to: string;
  icon: LucideIcon;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', to: '/', icon: LayoutDashboard, label: 'sidebar.dashboard' },
  { id: 'health', to: '/health', icon: Activity, label: 'sidebar.health' },
  { id: 'network', to: '/network', icon: Grid3x3, label: 'sidebar.network_planner' },
  { id: 'topology', to: '/topology', icon: Network, label: 'sidebar.topology' },
  { id: 'agents', to: '/agents', icon: Server, label: 'sidebar.agents' },
  { id: 'ssh', to: '/ssh', icon: SquareTerminal, label: 'sidebar.ssh' },
  { id: 'logs', to: '/logs', icon: ScrollText, label: 'sidebar.logs' },
  { id: 'settings', to: '/settings', icon: Settings, label: 'sidebar.settings' },
];

// Bottom bar on phones: five destinations; SSH and logs stay reachable via the menu drawer.
const TAB_ITEMS = NAV_ITEMS.filter((item) => item.id !== 'logs' && item.id !== 'ssh');

export function Sidebar({ active, isOpen, onClose }: { active: string, isOpen?: boolean, onClose?: () => void }) {
  const { t } = useTranslation();
  const version = (window as any).APP_VERSION as string | undefined;
  const liveSsh = useLiveSshSessions();

  return (
    <>
      <aside className={`app-sidebar ${isOpen ? 'mobile-open' : ''}`}>
        {/* Text logo with the version beside it (kept from the original design) */}
        <div className="sidebar-brand">
          <span className="sidebar-brand__name">{t('app.title')}</span>
          {version && <span className="sidebar-brand__version">v{version}</span>}
          {isOpen && (
            <button type="button" className="btn-close mobile-only" onClick={onClose} aria-label={t('common.close')} style={{ marginLeft: 'auto' }}>
              <X size={20} />
            </button>
          )}
        </div>

        <nav className="sidebar-nav" aria-label={t('sidebar.navigation')}>
          {NAV_ITEMS.map(({ id, to, icon: Icon, label }) => (
            <Link
              key={id}
              to={to}
              className={`nav-item ${active === id ? 'active' : ''}`}
              aria-current={active === id ? 'page' : undefined}
              onClick={onClose}
            >
              <Icon size={18} aria-hidden="true" /> {t(label)}
              {id === 'ssh' && liveSsh > 0 && (
                <span className="nav-item__badge" title={t('ssh.sessions.open_in_background', { count: liveSsh })}>
                  {liveSsh}<span className="visually-hidden"> {t('ssh.sessions.open_in_background', { count: liveSsh })}</span>
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      <nav className="mobile-tabbar" aria-label={t('sidebar.navigation')}>
        {TAB_ITEMS.map(({ id, to, icon: Icon, label }) => (
          <Link
            key={id}
            to={to}
            className={`mobile-tabbar__item ${active === id ? 'active' : ''}`}
            aria-current={active === id ? 'page' : undefined}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{t(label)}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
