import { useSyncExternalStore } from 'react';
import type { ITheme } from '@xterm/xterm';

/** Terminal look, chosen per browser and applied live to every open terminal. */
export interface TerminalPrefs {
  fontFamily: string;   // id from FONT_OPTIONS
  fontSize: number;
  theme: string;        // id from THEMES
  foreground: string | null;  // custom text colour, overrides the theme
  background: string | null;  // custom background, overrides the theme
}

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 28;

export const FONT_OPTIONS: { id: string; label: string; css: string }[] = [
  { id: 'plex', label: 'IBM Plex Mono', css: "'IBM Plex Mono', monospace" },
  { id: 'system', label: 'System (Consolas / Menlo)', css: "Consolas, Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace" },
  { id: 'cascadia', label: 'Cascadia Code', css: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
  { id: 'jetbrains', label: 'JetBrains Mono', css: "'JetBrains Mono', Consolas, monospace" },
  { id: 'fira', label: 'Fira Code', css: "'Fira Code', 'Fira Mono', Consolas, monospace" },
  { id: 'courier', label: 'Courier New', css: "'Courier New', Courier, monospace" },
];

// ANSI palettes for the presets; 'gravitylan' follows the app's colours
export const THEMES: { id: string; label: string; theme: () => ITheme }[] = [
  {
    id: 'gravitylan',
    label: 'GravityLAN',
    theme: () => ({
      background: cssVar('--bg-input', '#0B0E13'),
      foreground: cssVar('--text-primary', '#E6EAF0'),
      cursor: cssVar('--accent-primary', '#3DB8F5'),
      cursorAccent: cssVar('--bg-input', '#0B0E13'),
      selectionBackground: 'rgba(61, 184, 245, 0.3)',
    }),
  },
  {
    id: 'classic',
    label: 'Classic (green on black)',
    theme: () => ({
      background: '#000000', foreground: '#33FF66', cursor: '#33FF66', cursorAccent: '#000000',
      selectionBackground: 'rgba(51, 255, 102, 0.3)',
    }),
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    theme: () => ({
      background: '#002B36', foreground: '#839496', cursor: '#93A1A1', cursorAccent: '#002B36',
      selectionBackground: 'rgba(147, 161, 161, 0.3)',
      black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2',
      magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
      brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#93A1A1', brightYellow: '#839496',
      brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
    }),
  },
  {
    id: 'dracula',
    label: 'Dracula',
    theme: () => ({
      background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2', cursorAccent: '#282A36',
      selectionBackground: 'rgba(68, 71, 90, 0.8)',
      black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C', blue: '#BD93F9',
      magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
      brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94', brightYellow: '#FFFFA5',
      brightBlue: '#D6ACFF', brightMagenta: '#FF92DF', brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
    }),
  },
  {
    id: 'light',
    label: 'Light',
    theme: () => ({
      background: '#FAFAFA', foreground: '#383A42', cursor: '#526FFF', cursorAccent: '#FAFAFA',
      selectionBackground: 'rgba(82, 111, 255, 0.25)',
      black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#986801', blue: '#4078F2',
      magenta: '#A626A4', cyan: '#0184BC', white: '#A0A1A7',
      brightBlack: '#696C77', brightRed: '#E45649', brightGreen: '#50A14F', brightYellow: '#C18401',
      brightBlue: '#4078F2', brightMagenta: '#A626A4', brightCyan: '#0184BC', brightWhite: '#383A42',
    }),
  },
];

export const DEFAULT_PREFS: TerminalPrefs = {
  fontFamily: 'plex',
  fontSize: 13,
  theme: 'gravitylan',
  foreground: null,
  background: null,
};

const STORAGE_KEY = 'gravitylan.terminal';

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function load(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = { ...DEFAULT_PREFS, ...JSON.parse(raw) } as TerminalPrefs;
    parsed.fontSize = clampFontSize(Number(parsed.fontSize));
    return parsed;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_PREFS.fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

let prefs: TerminalPrefs = load();
const listeners = new Set<() => void>();

export function setTerminalPrefs(update: Partial<TerminalPrefs>) {
  prefs = { ...prefs, ...update, fontSize: clampFontSize(update.fontSize ?? prefs.fontSize) };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage blocked: keep for this page */ }
  listeners.forEach((listener) => listener());
}

export function resetTerminalPrefs() {
  setTerminalPrefs(DEFAULT_PREFS);
}

export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => prefs,
  );
}

export function fontCss(prefsValue: TerminalPrefs): string {
  return (FONT_OPTIONS.find((f) => f.id === prefsValue.fontFamily) ?? FONT_OPTIONS[0]).css;
}

export function resolveTheme(prefsValue: TerminalPrefs): ITheme {
  const base = (THEMES.find((t) => t.id === prefsValue.theme) ?? THEMES[0]).theme();
  return {
    ...base,
    ...(prefsValue.foreground ? { foreground: prefsValue.foreground } : {}),
    ...(prefsValue.background ? { background: prefsValue.background, cursorAccent: prefsValue.background } : {}),
  };
}
