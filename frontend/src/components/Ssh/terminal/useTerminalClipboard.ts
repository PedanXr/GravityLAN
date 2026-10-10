import { useState } from 'react';
import type { IBuffer } from '@xterm/xterm';
import { copyText } from '../../Agents/ManualInstallCommand';
import type { XtermHandles } from './useXterm';

export type CopyState = 'idle' | 'copied' | 'empty';

/**
 * The command entered on `markerLine` plus everything it printed, without the
 * new prompt the cursor sits on once it finished. Wrapped rows are joined.
 */
export function lastCommandText(buffer: IBuffer, markerLine: number): string {
  // A long prompt wraps: go back to the first row of a logical line
  const lineStart = (row: number, floor: number) => {
    let start = row;
    while (start > floor && buffer.getLine(start)?.isWrapped) start--;
    return start;
  };
  const first = lineStart(markerLine, 0);
  const cursorLine = buffer.baseY + buffer.cursorY;
  const promptStart = lineStart(cursorLine, first);
  const end = promptStart > first ? promptStart - 1 : cursorLine;
  let text = '';
  for (let i = first; i <= end; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const nextWraps = buffer.getLine(i + 1)?.isWrapped ?? false;
    // Wrapped rows continue the previous line: join them without a line break
    text += (i > first && !line.isWrapped ? '\n' : '') + line.translateToString(!nextWraps);
  }
  return text.replace(/\s+$/, '');
}

/** A button label state that falls back to "idle" after a moment. */
function useFlash() {
  const [state, setState] = useState<CopyState>('idle');
  const flash = (next: 'copied' | 'empty') => {
    setState(next);
    window.setTimeout(() => setState('idle'), 1500);
  };
  return [state, flash] as const;
}

/** Copy selection, copy last command, and paste (with a text box where the clipboard cannot be read). */
export function useTerminalClipboard({ termRef, lastCommandRef }: XtermHandles) {
  const [copyState, flashCopy] = useFlash();
  const [lastCopyState, flashLast] = useFlash();
  // Fallback when the browser does not allow reading the clipboard (plain HTTP, denied permission)
  const [pasteFallback, setPasteFallback] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const copySelection = async () => {
    const text = termRef.current?.getSelection() ?? '';
    if (!text) { flashCopy('empty'); return; }
    flashCopy((await copyText(text)) ? 'copied' : 'empty');
    termRef.current?.focus();
  };

  const copyLastCommand = async () => {
    const term = termRef.current;
    const marker = lastCommandRef.current;
    if (!term || !marker || marker.isDisposed || marker.line < 0) { flashLast('empty'); return; }
    const text = lastCommandText(term.buffer.active, marker.line);
    if (!text) { flashLast('empty'); return; }
    flashLast((await copyText(text)) ? 'copied' : 'empty');
    term.focus();
  };

  const paste = async () => {
    try {
      // Only allowed over HTTPS (or localhost) and with permission
      if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text);
      termRef.current?.focus();
    } catch {
      setPasteText('');
      setPasteFallback(true);
    }
  };

  const submitPaste = () => {
    if (pasteText) termRef.current?.paste(pasteText);
    setPasteFallback(false);
    termRef.current?.focus();
  };

  return {
    copyState, lastCopyState,
    copySelection, copyLastCommand, paste,
    pasteFallback, pasteText, setPasteText, submitPaste,
    cancelPaste: () => setPasteFallback(false),
  };
}
