import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { api } from './api/client';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { SetupWizard } from './components/Setup/SetupWizard';
import { Dashboard } from './components/Dashboard/Dashboard';
import { SubnetView } from './components/Network/SubnetView';
import { SettingsView } from './components/Settings/SettingsView';
import { LogsPage } from './components/Settings/LogsPage';
import { AgentsView } from './components/Agents/AgentsView';
import { HealthView } from './components/Health/HealthView';

// The terminal pulls in xterm.js; load it only when the SSH page is opened
const SshView = lazy(() => import('./components/Ssh/SshView').then((m) => ({ default: m.SshView })));
import NetworkPlanner from './components/Topology/NetworkPlanner';
import { ThemeManager } from './components/ThemeManager';
import { ToastProvider } from './context/ToastContext';
import { NetworkProvider } from './context/NetworkContext';
import ErrorBoundary from './components/Common/ErrorBoundary';
import { AuthGuard } from './components/Auth/AuthGuard';

/**
 * The SSH page is mounted on the first visit and then kept (hidden) while the user
 * is on other pages, so open terminals and their scrollback stay alive.
 */
function PersistentSshView() {
  const { pathname } = useLocation();
  const onSsh = pathname === '/ssh';
  const [visited, setVisited] = useState(onSsh);
  useEffect(() => { if (onSsh) setVisited(true); }, [onSsh]);
  if (!visited) return null;
  return (
    <div style={{ display: onSsh ? 'contents' : 'none' }}>
      <Suspense fallback={<div className="app-boot" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" /></div>}>
        <SshView visible={onSsh} />
      </Suspense>
    </div>
  );
}

/**
 * Checks if the user configured a custom start page (e.g. /health).
 * Only redirects on the first arrival in a browser session so clicking "Overview" in
 * the sidebar keeps the user on Dashboard without bounce.
 */
function RootRedirect() {
  const [redirectPath, setRedirectPath] = useState<string | null>(() => {
    const hasRedirected = sessionStorage.getItem('gravitylan_initial_redirect');
    if (!hasRedirected) {
      const cached = localStorage.getItem('gravitylan_start_page');
      if (cached === '/health') {
        sessionStorage.setItem('gravitylan_initial_redirect', 'true');
        return '/health';
      }
    }
    return null;
  });

  useEffect(() => {
    const hasRedirected = sessionStorage.getItem('gravitylan_initial_redirect');
    if (!hasRedirected) {
      api.getSettings().then((s) => {
        const page = s['ui.start_page'] || '/';
        localStorage.setItem('gravitylan_start_page', page);
        if (page === '/health') {
          sessionStorage.setItem('gravitylan_initial_redirect', 'true');
          setRedirectPath('/health');
        }
      }).catch(() => {});
    }
  }, []);

  if (redirectPath) {
    return <Navigate to={redirectPath} replace />;
  }

  return <Dashboard />;
}

function App() {
  const { t } = useTranslation();
  const [isSetupComplete, setIsSetupComplete] = useState<boolean | null>(null);
  const renderCount = useRef(0);
  renderCount.current++;

  useEffect(() => {
    const checkSetup = async () => {
      try {
        if (import.meta.env.DEV) console.log(`[App] Checking setup status... (Render #${renderCount.current})`);
        const status = await api.getSetupStatus();
        if (import.meta.env.DEV) console.log('[App] Setup status response:', status);
        
        setIsSetupComplete(prev => {
          if (prev === status.is_setup_complete) return prev;
          return status.is_setup_complete;
        });

        if (status.version) {
          (window as any).APP_VERSION = status.version;
        }
      } catch (err) {
        console.error('[App] Failed to check setup status:', err);
        setIsSetupComplete(false);
      }
    };
    checkSetup();
  }, []);

  if (isSetupComplete === null) {
    return (
      <div className="app-boot" role="status">
        <span className="sidebar-brand__name">{t('app.title')}</span>
        <div className="app-boot__status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('app_status.initializing')}
        </div>
        <div className="app-boot__hint">
          {t('app_status.checking_setup', { origin: window.location.origin })}
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <NetworkProvider>
        <BrowserRouter>
          <ThemeManager />
          <ErrorBoundary>
            <Routes>
              {/* Setup Route (Public) */}
              {!isSetupComplete && (
                <Route path="*" element={<SetupWizard onComplete={() => setIsSetupComplete(true)} />} />
              )}

              {/* Dashboard Routes (Protected) */}
              {isSetupComplete && (
                <Route path="*" element={
                  <AuthGuard>
                    <Routes>
                      <Route path="/" element={<RootRedirect />} />
                      <Route path="/health" element={<HealthView />} />
                      <Route path="/network" element={<SubnetView />} />
                      <Route path="/topology" element={<NetworkPlanner />} />
                      <Route path="/agents" element={<AgentsView />} />
                      {/* Rendered by PersistentSshView below, so terminals survive navigation */}
                      <Route path="/ssh" element={null} />
                      <Route path="/settings" element={<SettingsView />} />
                      <Route path="/logs" element={<LogsPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                    <PersistentSshView />
                  </AuthGuard>
                } />
              )}
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </NetworkProvider>
    </ToastProvider>
  );
}

export default App;
