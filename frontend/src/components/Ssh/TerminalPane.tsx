import { useEffect } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { SshSessionRequest } from '../../types';
import { resolveTheme, useTerminalPrefs } from './terminalPrefs';
import { useXterm } from './terminal/useXterm';
import { useSshSession, type TerminalStatus } from './terminal/useSshSession';
import { useTerminalClipboard } from './terminal/useTerminalClipboard';
import { HostKeyOverlay, PasteBox, StatusBanner, TerminalToolbar } from './terminal/TerminalParts';

export type { TerminalStatus };

interface TerminalPaneProps {
  request: SshSessionRequest;
  active: boolean;
  onStatusChange?: (status: TerminalStatus) => void;
}

/** One xterm.js terminal bound to one SSH session over the /api/ssh/terminal WebSocket. */
export function TerminalPane({ request, active, onStatusChange }: TerminalPaneProps) {
  const prefs = useTerminalPrefs();
  // The shortcuts run on key presses, after `clipboard` below is set for this render
  const xterm = useXterm(prefs, { copy: () => clipboard.copySelection(), paste: () => clipboard.paste() });
  const clipboard = useTerminalClipboard(xterm);
  const session = useSshSession(request, xterm, onStatusChange);
  const { status, hostKey } = session;
  const { fitAndSync, termRef } = xterm;

  // Hidden panes have no size; refit when the tab becomes visible
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitAndSync();
      if (status === 'connected') termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active, fitAndSync, status]);

  return (
    <div className="ssh-pane">
      <TerminalToolbar
        fontSize={prefs.fontSize}
        copyState={clipboard.copyState}
        lastCopyState={clipboard.lastCopyState}
        onCopy={clipboard.copySelection}
        onCopyLast={clipboard.copyLastCommand}
        onPaste={clipboard.paste}
      />

      {/* No padding on the element xterm measures: the fit addon reads its border-box height,
          so padding there produced one row too many and cut off the bottom line */}
      <div className="ssh-pane__terminal" style={{ background: resolveTheme(prefs).background }}>
        <div ref={xterm.containerRef} className="ssh-pane__xterm" />
      </div>

      {clipboard.pasteFallback && (
        <PasteBox
          text={clipboard.pasteText}
          onText={clipboard.setPasteText}
          onSubmit={clipboard.submitPaste}
          onCancel={clipboard.cancelPaste}
        />
      )}

      {hostKey
        ? <HostKeyOverlay hostKey={hostKey} onAnswer={session.answerHostKey} onDismiss={session.dismissHostKey} />
        : <StatusBanner status={status} message={session.message} onReconnect={session.reconnect} />}
    </div>
  );
}
