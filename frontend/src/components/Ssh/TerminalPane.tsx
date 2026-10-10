import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { AlertTriangle, Loader2, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, createSshTerminalSocket } from '../../api/client';
import type { SshSessionRequest } from '../../types';

const SCROLLBAR_COLS = 2;

export type TerminalStatus ='connecting' | 'hostkey' | 'authenticating' | 'connected' | 'closed' | 'error';

interface HostKeyPrompt {
  status: 'unknown' | 'changed';
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  known_fingerprint?: string;
}

interface TerminalPaneProps {
  request: SshSessionRequest;
  active: boolean;
  onStatusChange?: (status: TerminalStatus) => void;
}

/** The sshd public key file matching a host key type, for the "verify on the server" hint. */
function hostKeyFile(keyType: string): string {
  const kind = keyType.includes('ed25519') ? 'ed25519' : keyType.startsWith('ecdsa') ? 'ecdsa' : keyType.includes('rsa') ? 'rsa' : '*';
  return `/etc/ssh/ssh_host_${kind}_key.pub`;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** One xterm.js terminal bound to one SSH session over the /api/ssh/terminal WebSocket. */
export function TerminalPane({ request, active, onStatusChange }: TerminalPaneProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const updateStatus = useCallback((next: TerminalStatus) => {
    setStatus(next);
    onStatusChange?.(next);
  }, [onStatusChange]);

  const sendControl = (payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const fitAndSync = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const el = containerRef.current;
    if (!term || !fit || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    // xterm 6 draws its scrollbar over the text area; keep the last columns clear of it
    const cols = Math.max(2, dims.cols - SCROLLBAR_COLS);
    if (cols !== term.cols || dims.rows !== term.rows) term.resize(cols, dims.rows);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }, []);

  // Terminal instance lives as long as the pane
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: cssVar('--font-mono', "'IBM Plex Mono', monospace"),
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: {
        background: cssVar('--bg-input', '#0B0E13'),
        foreground: cssVar('--text-primary', '#E6EAF0'),
        cursor: cssVar('--accent-primary', '#3DB8F5'),
        cursorAccent: cssVar('--bg-input', '#0B0E13'),
        selectionBackground: 'rgba(61, 184, 245, 0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    const encoder = new TextEncoder();
    const dataSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    const binarySub = term.onBinary((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff));
      }
    });

    const observer = new ResizeObserver(() => fitAndSync());
    observer.observe(containerRef.current!);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fitAndSync]);

  // One connection per attempt (initial + every "reconnect")
  useEffect(() => {
    let disposed = false;
    const term = termRef.current;
    if (!term) return;

    setHostKey(null);
    setMessage(null);
    updateStatus('connecting');
    if (attempt > 0) term.write('\r\n');
    fitAndSync();

    (async () => {
      let ticket: string;
      try {
        ({ ticket } = await api.prepareSshSession(request));
      } catch (err) {
        if (disposed) return;
        const text = err instanceof Error ? err.message : String(err);
        setMessage(text);
        updateStatus('error');
        term.writeln(`\x1b[31m${text}\x1b[0m`);
        return;
      }
      if (disposed) return;

      const ws = createSshTerminalSocket(ticket, term.cols, term.rows);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          term.write(new Uint8Array(event.data as ArrayBuffer));
          return;
        }
        let msg: any;
        try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
          case 'status':
            if (msg.stage === 'connected') {
              setHostKey(null);
              updateStatus('connected');
              fitAndSync();
              term.focus();
            } else {
              updateStatus(msg.stage === 'authenticating' ? 'authenticating' : 'connecting');
            }
            break;
          case 'hostkey':
            setHostKey(msg as HostKeyPrompt);
            updateStatus('hostkey');
            break;
          case 'error':
            setMessage(msg.message);
            updateStatus('error');
            term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
            break;
          case 'closed':
            setHostKey(null);
            setMessage(msg.reason === 'idle' ? t('ssh.terminal.closed_idle') : null);
            updateStatus('closed');
            break;
        }
      };
      let opened = false;
      ws.onopen = () => { opened = true; };
      ws.onclose = () => {
        if (disposed) return;
        // Refused during the handshake: the server did not accept this browser's login
        // (no or expired session cookie), the SSH host was never contacted
        if (!opened) {
          setMessage(t('ssh.terminal.login_required'));
          updateStatus('error');
          term.writeln(`\x1b[31m${t('ssh.terminal.login_required')}\x1b[0m`);
          return;
        }
        setStatus((prev) => {
          const next = prev === 'error' ? 'error' : 'closed';
          if (next !== prev) onStatusChange?.(next);
          return next;
        });
        term.writeln(`\r\n\x1b[90m${t('ssh.terminal.disconnected')}\x1b[0m`);
      };
    })();

    return () => {
      disposed = true;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
      }
    };
    // request is stable per tab; reconnect is driven by `attempt`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Hidden panes have no size; refit when the tab becomes visible
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitAndSync();
      if (status === 'connected') termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, fitAndSync, status]);

  const answerHostKey = (accept: boolean) => {
    sendControl({ type: accept ? 'hostkey_accept' : 'hostkey_reject' });
    setHostKey(null);
    updateStatus(accept ? 'authenticating' : 'closed');
  };

  const busy = status === 'connecting' || status === 'authenticating';

  return (
    <div className="ssh-pane">
      <div ref={containerRef} className="ssh-pane__terminal" />

      {busy && (
        <div className="ssh-pane__banner" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {status === 'connecting' ? t('ssh.terminal.connecting') : t('ssh.terminal.authenticating')}
        </div>
      )}

      {hostKey && hostKey.status === 'unknown' && (
        <div className="ssh-pane__overlay" role="dialog" aria-modal="false" aria-labelledby="ssh-hostkey-title">
          <div className="ssh-hostkey">
            <h3 id="ssh-hostkey-title"><ShieldAlert size={18} aria-hidden="true" /> {t('ssh.hostkey.unknown_title')}</h3>
            <p>{t('ssh.hostkey.unknown_text', { host: `${hostKey.host}:${hostKey.port}` })}</p>
            <dl className="ssh-hostkey__facts">
              <dt>{t('ssh.hostkey.type')}</dt><dd>{hostKey.key_type}</dd>
              <dt>{t('ssh.hostkey.fingerprint')}</dt><dd className="ssh-mono">{hostKey.fingerprint}</dd>
            </dl>
            <p className="field-hint">{t('ssh.hostkey.verify_hint', { file: hostKeyFile(hostKey.key_type) })}</p>
            <div className="ssh-hostkey__actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => answerHostKey(false)}>{t('ssh.hostkey.reject')}</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => answerHostKey(true)} autoFocus>
                <ShieldCheck size={14} aria-hidden="true" /> {t('ssh.hostkey.accept')}
              </button>
            </div>
          </div>
        </div>
      )}

      {hostKey && hostKey.status === 'changed' && (
        <div className="ssh-pane__overlay" role="alert">
          <div className="ssh-hostkey ssh-hostkey--danger">
            <h3><AlertTriangle size={18} aria-hidden="true" /> {t('ssh.hostkey.changed_title')}</h3>
            <p>{t('ssh.hostkey.changed_text', { host: `${hostKey.host}:${hostKey.port}` })}</p>
            <dl className="ssh-hostkey__facts">
              <dt>{t('ssh.hostkey.known')}</dt><dd className="ssh-mono">{hostKey.known_fingerprint}</dd>
              <dt>{t('ssh.hostkey.presented')}</dt><dd className="ssh-mono">{hostKey.fingerprint}</dd>
            </dl>
            <p className="field-hint">{t('ssh.hostkey.changed_hint')}</p>
            <div className="ssh-hostkey__actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setHostKey(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {(status === 'closed' || status === 'error') && !hostKey && (
        <div className={`ssh-pane__banner ${status === 'error' ? 'is-error' : ''}`} role="status">
          <span className="ssh-pane__banner-text">
            {status === 'error' ? (message || t('ssh.terminal.error')) : (message || t('ssh.terminal.closed'))}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCcw size={14} aria-hidden="true" /> {t('ssh.terminal.reconnect')}
          </button>
        </div>
      )}
    </div>
  );
}
