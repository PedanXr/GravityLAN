import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { Terminal, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { FONT_OPTIONS, fontCss, loadTerminalFont, resolveTheme, type TerminalPrefs } from '../terminalPrefs';

const SCROLLBAR_COLS = 2;

export interface XtermHandles {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  termRef: MutableRefObject<Terminal | null>;
  /** The session socket; the terminal sends input and size changes through it. */
  wsRef: MutableRefObject<WebSocket | null>;
  /** Buffer line where the user last pressed Enter: start of "last command + its output" */
  lastCommandRef: MutableRefObject<IMarker | null>;
  fitAndSync: () => void;
}

interface ShortcutHandlers {
  copy: () => void;
  paste: () => void;
}

/**
 * One xterm.js instance for the lifetime of the pane: fits itself to its box,
 * forwards input to the socket, applies the appearance prefs live and maps
 * Ctrl+Shift+C / Ctrl+Shift+V to copy and paste (plain Ctrl+C stays "interrupt").
 */
export function useXterm(prefs: TerminalPrefs, shortcuts: ShortcutHandlers): XtermHandles {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastCommandRef = useRef<IMarker | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  // The xterm key handler is attached once; it calls the latest functions through a ref
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

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

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      // Start with the always-loaded default; the chosen font is set once it has loaded (below)
      fontFamily: FONT_OPTIONS[0].css,
      fontSize: prefsRef.current.fontSize,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: resolveTheme(prefsRef.current),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c') { shortcutsRef.current.copy(); return false; }
      if (key === 'v') { shortcutsRef.current.paste(); return false; }
      return true;
    });

    const send = (data: Parameters<WebSocket['send']>[0]) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    };
    const encoder = new TextEncoder();
    const dataSub = term.onData((data) => {
      if (/[\r\n]/.test(data)) {
        // Enter: remember the line of this command (the cursor is still on it)
        lastCommandRef.current?.dispose();
        lastCommandRef.current = term.registerMarker(0) ?? null;
      }
      send(encoder.encode(data));
    });
    const binarySub = term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));

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

  // Font, size and colours apply live to the running terminal. The font family is set only
  // after it has loaded: xterm measures glyphs when it is set, a pending font measures as fallback.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    term.options.fontSize = prefs.fontSize;
    term.options.theme = resolveTheme(prefs);
    fitAndSync();
    loadTerminalFont(prefs).then(() => {
      if (cancelled || termRef.current !== term) return;
      term.options.fontFamily = fontCss(prefs);
      fitAndSync();
    });
    return () => { cancelled = true; };
  }, [prefs, fitAndSync]);

  return { containerRef, termRef, wsRef, lastCommandRef, fitAndSync };
}
