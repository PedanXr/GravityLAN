import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Terminal } from '@xterm/xterm';
import { api, createSshTerminalSocket } from '../../../api/client';
import type { SshSessionRequest } from '../../../types';
import type { XtermHandles } from './useXterm';

export type TerminalStatus = 'connecting' | 'hostkey' | 'authenticating' | 'connected' | 'closed' | 'error';

export interface HostKeyPrompt {
  status: 'unknown' | 'changed';
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  known_fingerprint?: string;
}

/** JSON control messages the server sends next to the binary terminal output. */
type ServerMessage =
  | { type: 'status'; stage: string }
  | ({ type: 'hostkey' } & HostKeyPrompt)
  | { type: 'error'; message: string }
  | { type: 'closed'; reason?: string };

const red = (text: string) => `\x1b[31m${text}\x1b[0m`;

interface SessionContext {
  term: Terminal;
  t: TFunction;
  setHostKey: (prompt: HostKeyPrompt | null) => void;
  setMessage: (message: string | null) => void;
  updateStatus: (status: TerminalStatus) => void;
  fitAndSync: () => void;
}

function fail(ctx: SessionContext, text: string, line: string) {
  ctx.setMessage(text);
  ctx.updateStatus('error');
  ctx.term.writeln(line);
}

function applyServerMessage(msg: ServerMessage, ctx: SessionContext) {
  switch (msg.type) {
    case 'status':
      if (msg.stage === 'connected') {
        ctx.setHostKey(null);
        ctx.updateStatus('connected');
        ctx.fitAndSync();
        ctx.term.focus();
      } else {
        ctx.updateStatus(msg.stage === 'authenticating' ? 'authenticating' : 'connecting');
      }
      break;
    case 'hostkey':
      ctx.setHostKey(msg);
      ctx.updateStatus('hostkey');
      break;
    case 'error':
      fail(ctx, msg.message, `\r\n${red(msg.message)}`);
      break;
    case 'closed':
      ctx.setHostKey(null);
      ctx.setMessage(msg.reason === 'idle' ? ctx.t('ssh.terminal.closed_idle') : null);
      ctx.updateStatus('closed');
      break;
  }
}

/** Terminal output arrives binary; JSON text frames are control messages. */
function onSocketMessage(event: MessageEvent, ctx: SessionContext) {
  if (typeof event.data !== 'string') {
    ctx.term.write(new Uint8Array(event.data as ArrayBuffer));
    return;
  }
  let msg: ServerMessage;
  try { msg = JSON.parse(event.data); } catch { return; }
  applyServerMessage(msg, ctx);
}

/**
 * One SSH session per attempt (the first and every "reconnect"): fetch a ticket,
 * open the terminal socket and follow the server's control messages.
 */
export function useSshSession(request: SshSessionRequest, xterm: XtermHandles, onStatusChange?: (status: TerminalStatus) => void) {
  const { t } = useTranslation();
  const { termRef, wsRef, fitAndSync } = xterm;
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const updateStatus = useCallback((next: TerminalStatus) => {
    setStatus(next);
    onStatusChange?.(next);
  }, [onStatusChange]);

  const onSocketClose = (opened: boolean) => {
    const term = termRef.current;
    // Refused during the handshake: the server did not accept this browser's login
    // (no or expired session cookie), the SSH host was never contacted
    if (!opened) {
      setMessage(t('ssh.terminal.login_required'));
      updateStatus('error');
      term?.writeln(red(t('ssh.terminal.login_required')));
      return;
    }
    setStatus((prev) => {
      const next = prev === 'error' ? 'error' : 'closed';
      if (next !== prev) onStatusChange?.(next);
      return next;
    });
    term?.writeln(`\r\n\x1b[90m${t('ssh.terminal.disconnected')}\x1b[0m`);
  };

  useEffect(() => {
    let disposed = false;
    const term = termRef.current;
    if (!term) return;

    const ctx: SessionContext = { term, t, setHostKey, setMessage, updateStatus, fitAndSync };

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
        fail(ctx, text, red(text));
        return;
      }
      if (disposed) return;

      const ws = createSshTerminalSocket(ticket, term.cols, term.rows);
      wsRef.current = ws;
      ws.onmessage = (event) => onSocketMessage(event, ctx);
      let opened = false;
      ws.onopen = () => { opened = true; };
      ws.onclose = () => {
        if (!disposed) onSocketClose(opened);
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

  const answerHostKey = (accept: boolean) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: accept ? 'hostkey_accept' : 'hostkey_reject' }));
    }
    setHostKey(null);
    updateStatus(accept ? 'authenticating' : 'closed');
  };

  return {
    status,
    hostKey,
    message,
    answerHostKey,
    dismissHostKey: () => setHostKey(null),
    reconnect: () => setAttempt((n) => n + 1),
  };
}
