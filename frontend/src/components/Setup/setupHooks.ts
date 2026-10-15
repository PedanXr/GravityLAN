import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, createScanSocket } from '../../api/client';
import type { ScanProgress, SubnetInfo } from '../../types';

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Detected networks; all of them start selected. */
export function useNetworkChoice() {
  const [subnets, setSubnets] = useState<SubnetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [dnsServer, setDnsServer] = useState('');

  useEffect(() => {
    api.getSubnets()
      .then((data) => {
        setSubnets(data);
        setSelected(data.map((s) => s.subnet));
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback((subnet: string) => {
    setSelected((prev) => (prev.includes(subnet) ? prev.filter((s) => s !== subnet) : [...prev, subnet]));
  }, []);

  return { subnets, loading, error, selected, toggle, dnsServer, setDnsServer };
}

const FINISHED: ScanProgress['status'][] = ['completed', 'failed', 'cancelled'];

/** The first scan, with live progress over the scan socket. */
export function useSetupScan() {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  // Sent with setup completion so hosts of routed subnets (other VLANs) are adopted too
  const [scannedSubnets, setScannedSubnets] = useState<string[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  // Close the progress socket if the wizard unmounts mid-scan
  useEffect(() => () => socketRef.current?.close(), []);

  const start = useCallback(async (subnets: string[], dnsServer: string) => {
    setScannedSubnets(subnets);
    setProgress({
      status: 'running', current_subnet: '', hosts_scanned: 0, hosts_total: 0,
      devices_found: 0, message: '', timestamp: new Date().toISOString(),
    });

    socketRef.current?.close();
    const ws = createScanSocket((next) => {
      setProgress(next);
      if (FINISHED.includes(next.status)) ws.close();
    });
    socketRef.current = ws;

    try {
      await api.startScan({ subnets, mode: 'fast', dns_server: dnsServer || undefined });
    } catch (err) {
      ws.close();
      setProgress((prev) => prev && { ...prev, status: 'failed', message: errorText(err) });
    }
  }, []);

  const abort = async () => {
    try {
      await api.stopScan();
    } catch (err) {
      console.warn('Stopping the scan failed:', err);
    }
    socketRef.current?.close();
    setProgress((prev) => (prev && prev.status === 'running' ? { ...prev, status: 'cancelled' } : prev));
  };

  return { progress, scannedSubnets, start, abort };
}

/**
 * Admin password and the finishing sequence: save, adopt discovered devices,
 * kick off a first refresh, then open the dashboard.
 */
export function useFinishSetup(dnsServer: string, scannedSubnets: string[], onComplete: () => void) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mismatch = password !== '' && confirm !== '' && password !== confirm;
  const canFinish = password !== '' && password === confirm;

  const stage = (value: number, key: string) => {
    setPercent(value);
    setStatus(t(key));
  };

  const finish = async (e: FormEvent) => {
    e.preventDefault();
    if (!canFinish) return;

    setError(null);
    setFinishing(true);
    stage(10, 'setup.saving_configuration');

    try {
      await api.completeSetup({
        dns_server: dnsServer || undefined,
        admin_password: password,
        subnets: scannedSubnets.length > 0 ? scannedSubnets : undefined,
      });
    } catch (err) {
      console.error('Final setup step failed:', err);
      // Stay in the wizard: without the saved password the dashboard can't be used
      setFinishing(false);
      setError(errorText(err));
      return;
    }

    stage(40, 'setup.stabilizing_backend');
    await wait(1000);

    stage(65, 'setup.scanning_network');
    try {
      await api.refreshAllDevices();
    } catch (err) {
      console.warn('Initial refresh trigger failed, but setup is complete:', err);
    }

    stage(90, 'setup.almost_done');
    await wait(500);

    stage(100, 'setup.welcome_done');
    await wait(400);

    onComplete();
    navigate('/', { replace: true });
  };

  return { password, setPassword, confirm, setConfirm, mismatch, canFinish, finishing, percent, status, error, finish };
}
