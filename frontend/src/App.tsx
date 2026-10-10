import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api/client';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { SetupWizard } from './components/Setup/SetupWizard';
import { Dashboard } from './components/Dashboard/Dashboard';
import { SubnetView } from './components/Network/SubnetView';
import { SettingsView } from './components/Settings/SettingsView';
import { LogsPage } from './components/Settings/LogsPage';
import { AgentsView } from './components/Agents/AgentsView';

// The terminal pulls in xterm.js; load it only when the SSH page is opened
const SshView = lazy(() => import('./components/Ssh/SshView').then((m) => ({ default: m.SshView })));
import NetworkPlanner from './components/Topology/NetworkPlanner';
import { ThemeManager } from './components/ThemeManager';
import { ToastProvider } from './context/ToastContext';
import { NetworkProvider } from './context/NetworkContext';
import ErrorBoundary from './components/Common/ErrorBoundary';
import { AuthGuard } from './components/Auth/AuthGuard';

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
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/network" element={<SubnetView />} />
                      <Route path="/topology" element={<NetworkPlanner />} />
                      <Route path="/agents" element={<AgentsView />} />
                      <Route path="/ssh" element={
                        <Suspense fallback={<div className="app-boot" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" /></div>}>
                          <SshView />
                        </Suspense>
                      } />
                      <Route path="/settings" element={<SettingsView />} />
                      <Route path="/logs" element={<LogsPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
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
