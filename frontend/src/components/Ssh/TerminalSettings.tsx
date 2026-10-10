import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, X } from 'lucide-react';
import {
  FONT_OPTIONS, FONT_SIZE_MAX, FONT_SIZE_MIN, THEMES,
  resetTerminalPrefs, resolveTheme, setTerminalPrefs, useTerminalPrefs,
} from './terminalPrefs';

/** <input type="color"> only takes #rrggbb */
function toHex(color: string | undefined, fallback: string): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

/**
 * Font, size and colours of the terminal; changes apply live to every open terminal.
 * Positioned against the window (below `anchor`), so a narrow terminal pane cannot clip it.
 */
export function TerminalSettings({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const { t } = useTranslation();
  const ids = useId();
  const prefs = useTerminalPrefs();
  const theme = resolveTheme(prefs);
  const panelRef = useRef<HTMLDivElement>(null);
  const rect = anchor?.getBoundingClientRect();
  const position = rect
    ? { top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) }
    : { top: 80, right: 16 };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return (
    <div ref={panelRef} className="ssh-term-settings" role="dialog" aria-labelledby={`${ids}-title`} style={position}>
      <div className="ssh-term-settings__head">
        <h3 id={`${ids}-title`}>{t('ssh.terminal.settings.title')}</h3>
        <button type="button" className="btn-icon" onClick={onClose} aria-label={t('common.close')}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="form-group">
        <label htmlFor={`${ids}-font`}>{t('ssh.terminal.settings.font')}</label>
        <select id={`${ids}-font`} className="input" value={prefs.fontFamily}
          onChange={(e) => setTerminalPrefs({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <p className="field-hint">{t('ssh.terminal.settings.font_hint')}</p>
      </div>

      <div className="form-group">
        <label htmlFor={`${ids}-size`}>{t('ssh.terminal.settings.size')}: {prefs.fontSize} px</label>
        <input id={`${ids}-size`} type="range" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} step={1} value={prefs.fontSize}
          onChange={(e) => setTerminalPrefs({ fontSize: Number(e.target.value) })} />
      </div>

      <div className="form-group">
        <label htmlFor={`${ids}-theme`}>{t('ssh.terminal.settings.theme')}</label>
        <select id={`${ids}-theme`} className="input" value={prefs.theme}
          onChange={(e) => setTerminalPrefs({ theme: e.target.value, foreground: null, background: null })}>
          {THEMES.map((th) => <option key={th.id} value={th.id}>{th.label}</option>)}
        </select>
      </div>

      <div className="ssh-term-settings__colors">
        <div className="form-group">
          <label htmlFor={`${ids}-fg`}>{t('ssh.terminal.settings.text_color')}</label>
          <input id={`${ids}-fg`} type="color" value={toHex(theme.foreground, '#e6eaf0')}
            onChange={(e) => setTerminalPrefs({ foreground: e.target.value })} />
        </div>
        <div className="form-group">
          <label htmlFor={`${ids}-bg`}>{t('ssh.terminal.settings.background')}</label>
          <input id={`${ids}-bg`} type="color" value={toHex(theme.background, '#0b0e13')}
            onChange={(e) => setTerminalPrefs({ background: e.target.value })} />
        </div>
      </div>

      <div className="ssh-term-settings__preview" style={{
        background: theme.background, color: theme.foreground,
        fontFamily: FONT_OPTIONS.find((f) => f.id === prefs.fontFamily)?.css, fontSize: prefs.fontSize,
      }}>
        root@server:~# ls -la
      </div>

      <div className="ssh-term-settings__foot">
        <p className="field-hint">{t('ssh.terminal.settings.saved_hint')}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={resetTerminalPrefs}>
          <RotateCcw size={14} aria-hidden="true" /> {t('ssh.terminal.settings.reset')}
        </button>
      </div>
    </div>
  );
}
