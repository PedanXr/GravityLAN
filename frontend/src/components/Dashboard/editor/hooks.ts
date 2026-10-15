import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSshLogin, Device, DeviceGroup, DeviceHistoryResponse, Rack } from '../../../types';
import { api } from '../../../api/client';
import { useToast } from '../../../context/ToastContext';
import { agentKeyProfiles, useSavedSshProfiles } from '../../Agents/savedLogins';
import { errorMessage } from './deviceForm';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog behaviour: focus moves into the panel, Tab stays inside it,
 * Escape closes, and focus returns to the element that opened it.
 */
export function useModalFocusTrap<T extends HTMLElement>(onClose: () => void) {
  const panelRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, []);
  return panelRef;
}

/** Groups and racks for the "General" tab selects. */
export function useEditorOptions() {
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [racks, setRacks] = useState<Rack[]>([]);
  useEffect(() => {
    api.getGroups()
      .then(setGroups)
      .catch((err) => console.error('Failed to load groups:', err));
    api.getRacks()
      .then((data) => setRacks(Array.isArray(data) ? data : []))
      .catch((err) => {
        console.error('Failed to load racks:', err);
        setRacks([]);
      });
  }, []);
  return { groups, racks };
}

/** Status history, (re)loaded each time the tab is opened. */
export function useDeviceHistory(deviceId: number, active: boolean) {
  const [history, setHistory] = useState<DeviceHistoryResponse[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    setIsLoading(true);
    api.getDeviceHistory(deviceId)
      .then(setHistory)
      .catch((err) => console.error('Failed to load history:', err))
      .finally(() => setIsLoading(false));
  }, [active]);
  return { history, isLoading };
}

export interface AgentStatus {
  is_installed: boolean;
  is_active: boolean;
  agent_version?: string;
  latest_version?: string;
  last_seen?: string;
}

export interface AgentConfigForm {
  interval: number;
  disk_paths: string[];
  enable_temp: boolean;
}

export interface SshForm {
  ssh_user: string;
  ssh_password: string;
  ssh_key: string;
  ssh_port: number;
  /** Saved key connection of the device to log in with instead (null: user and password above) */
  profile_id: number | null;
  /** Only for sudo with a saved connection; never stored */
  sudo_password: string;
}

/** The request body: the saved connection, or the typed-in credentials. */
export function sshLogin(form: SshForm): AgentSshLogin {
  if (form.profile_id !== null) {
    return form.sudo_password ? { profile_id: form.profile_id, sudo_password: form.sudo_password } : { profile_id: form.profile_id };
  }
  const { ssh_user, ssh_password, ssh_key, ssh_port } = form;
  return { ssh_user, ssh_password, ssh_key, ssh_port };
}

const SSH_ACTIONS = {
  deploy: {
    run: (id: number, form: SshForm) => api.deployAgent(id, sshLogin(form)),
    start: 'agent.deploying', detail: 'agent.connecting', ok: 'agent.deployed_title', failed: 'agent.deploy_failed_title',
  },
  uninstall: {
    run: (id: number, form: SshForm) => api.uninstallAgent(id, sshLogin(form)),
    start: 'agent.uninstalling', detail: 'agent.removing', ok: 'agent.uninstalled_title', failed: 'agent.uninstall_failed_title',
  },
} as const;

/**
 * Agent tab state. It lives in the editor rather than the tab so the SSH form,
 * the deploy log and the config draft survive switching tabs.
 */
export function useAgentPanel(device: Device, active: boolean) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [sshForm, setSshForm] = useState<SshForm>({ ssh_user: 'root', ssh_password: '', ssh_key: '', ssh_port: 22, profile_id: null, sudo_password: '' });
  const savedProfiles = useSavedSshProfiles(active);
  const keyProfiles = useMemo(() => agentKeyProfiles(savedProfiles, device), [savedProfiles, device]);
  // A saved key connection is offered first once it is known; the user can still switch to a password
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || keyProfiles.length === 0) return;
    preselected.current = true;
    setSshForm(prev => (prev.ssh_password ? prev : { ...prev, profile_id: keyProfiles[0].id }));
  }, [keyProfiles]);
  const [agentConfig, setAgentConfig] = useState<AgentConfigForm | null>(null);
  const [newDiskPath, setNewDiskPath] = useState('');
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [showManual, setShowManual] = useState(false);

  const appendLog = (line: string) => setDeployLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const loadAgentStatus = async () => {
    try {
      const status = await api.getAgentStatus(device.id);
      setAgentStatus(status);
      if (status.is_installed) {
        try {
          setAgentConfig(await api.getAgentConfig(device.id));
        } catch { /* no config yet */ }
      }
    } catch { /* agent not available */ }
  };

  useEffect(() => {
    if (active) loadAgentStatus();
  }, [active]);

  const runSshAction = async (kind: keyof typeof SSH_ACTIONS) => {
    if (kind === 'uninstall' && !window.confirm(t('agent.uninstall_confirm_long'))) return;
    const action = SSH_ACTIONS[kind];
    setIsDeploying(true);
    showToast('info', t(action.start), t(action.detail, { ip: device.ip }));
    try {
      const result = await action.run(device.id, sshForm);
      appendLog(result.message);
      if (result.status === 'success') {
        showToast('success', t(action.ok), result.message);
        setSshForm(prev => ({ ...prev, ssh_password: '', ssh_key: '', sudo_password: '' }));
        await loadAgentStatus();
      } else {
        showToast('error', t(action.failed), result.message);
      }
    } catch (err) {
      const msg = errorMessage(err) || t('agent.connection_failed');
      appendLog(`${t('common.error').toUpperCase()}: ${msg}`);
      showToast('error', t('common.error'), msg);
    } finally {
      setIsDeploying(false);
    }
  };

  const saveConfig = async () => {
    if (!agentConfig) return;
    try {
      await api.updateAgentConfig(device.id, agentConfig);
      showToast('success', t('notifications.saved'), t('notifications.changes_applied'));
    } catch (err) {
      showToast('error', t('common.error'), errorMessage(err) ?? '');
    }
  };

  return {
    agentStatus, setAgentStatus,
    isDeploying,
    sshForm, setSshForm,
    keyProfiles,
    agentConfig, setAgentConfig,
    newDiskPath, setNewDiskPath,
    deployLog,
    showManual, setShowManual,
    deploy: () => runSshAction('deploy'),
    uninstall: () => runSshAction('uninstall'),
    saveConfig,
  };
}

export type AgentPanel = ReturnType<typeof useAgentPanel>;
