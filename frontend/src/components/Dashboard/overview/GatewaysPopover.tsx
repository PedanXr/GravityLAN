import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Copy, GitMerge, Network, Router, Search, X } from 'lucide-react';
import { api } from '../../../api/client';
import type { GatewayEntry, MergeSuggestion } from '../../../types';
import { networkColor } from '../../../utils/networks';

export type OpenDevice = (deviceId: number, tab?: 'interfaces') => void;

/** Gateways of all subnets, listed in a keyboard-navigable popover in the dashboard toolbar. */
export function GatewaysPopover({ onOpenDevice }: { onOpenDevice: OpenDevice }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const { entries, suggestions, error, reload } = useGateways();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus = true) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [isOpen, close]);

  const toggle = () => {
    if (!isOpen) reload();
    setIsOpen(!isOpen);
  };

  const offline = (entries ?? []).filter((e) => e.gateway_ip && e.is_online === false).length;
  const label = t('gateways.title');

  return (
    <div className="gw-popover" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-secondary btn-sm gw-trigger ${isOpen ? 'is-open' : ''}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={offline ? `${label}: ${t('gateways.offline_count', { count: offline })}` : label}
        title={label}
      >
        <Router size={16} aria-hidden="true" />
        <span className="gw-trigger__label">{label}</span>
        {entries && entries.length > 0 && <span className="gw-trigger__count">{entries.length}</span>}
        {offline > 0 && <span className="gw-trigger__alert" aria-hidden="true" />}
      </button>

      {isOpen && (
        <GatewaysPanel
          entries={entries}
          suggestions={suggestions}
          error={error}
          onClose={close}
          onOpenDevice={(id, tab) => { close(false); onOpenDevice(id, tab); }}
        />
      )}
    </div>
  );
}

function useGateways() {
  const [entries, setEntries] = useState<GatewayEntry[] | null>(null);
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [gateways, merge] = await Promise.all([
        api.getGateways(),
        api.getMergeSuggestions().catch(() => [] as MergeSuggestion[]),
      ]);
      setEntries(gateways);
      setSuggestions(merge);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return { entries, suggestions, error, reload };
}

function matches(entry: GatewayEntry, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [entry.subnet_name, entry.cidr, entry.gateway_ip, entry.device_name, entry.vlan_id != null && `vlan ${entry.vlan_id}`]
    .filter(Boolean).join(' ').toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every((word) => haystack.includes(word));
}

/** Index of the row holding the focused element (row button or its copy button), or -1. */
function focusedRow(): number {
  const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-gw-row]');
  return row ? Number(row.dataset.gwRow) : -1;
}

interface PanelProps {
  entries: GatewayEntry[] | null;
  suggestions: MergeSuggestion[];
  error: string | null;
  onClose: (returnFocus?: boolean) => void;
  onOpenDevice: OpenDevice;
}

function GatewaysPanel({ entries, suggestions, error, onClose, onOpenDevice }: PanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const visible = useMemo(() => (entries ?? []).filter((e) => matches(e, query)), [entries, query]);
  const showSearch = (entries?.length ?? 0) > 3;

  // Focus the filter, or the first row when the list is short, as soon as there is something to focus
  useEffect(() => {
    if (searchRef.current) searchRef.current.focus();
    else if (rowRefs.current[0]) rowRefs.current[0].focus();
    else panelRef.current?.focus();
  }, [entries === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusRow = (index: number) => {
    if (visible.length === 0) return;
    rowRefs.current[Math.max(0, Math.min(visible.length - 1, index))]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = focusedRow();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(row + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (row <= 0 && searchRef.current) searchRef.current.focus();
      else focusRow(row - 1);
    } else if ((e.key === 'Home' || e.key === 'End') && row >= 0) {
      e.preventDefault();
      focusRow(e.key === 'Home' ? 0 : visible.length - 1);
    } else if (e.key === 'Enter' && e.target === searchRef.current && visible.length > 0) {
      e.preventDefault();
      focusRow(0);
    }
  };

  const openEntry = (entry: GatewayEntry) => {
    if (entry.device_id != null) onOpenDevice(entry.device_id, entry.interface_id != null ? 'interfaces' : undefined);
    else { onClose(false); navigate('/network'); }
  };

  return (
    <div
      ref={panelRef}
      className="gw-panel"
      role="dialog"
      aria-label={t('gateways.title')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="gw-panel__header">
        <div>
          <h3 className="gw-panel__title"><Router size={16} aria-hidden="true" /> {t('gateways.title')}</h3>
          <p className="gw-panel__subtitle">{t('gateways.subtitle', { count: entries?.length ?? 0 })}</p>
        </div>
        <button type="button" className="btn-icon" onClick={() => onClose()} aria-label={t('common.close')}>
          <X size={16} />
        </button>
      </div>

      {showSearch && (
        <label className="gw-panel__search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('gateways.filter')}
            aria-label={t('gateways.filter')}
          />
        </label>
      )}

      <div className="gw-panel__body">
        {error && <p className="gw-panel__empty" role="alert">{t('gateways.load_failed', { error })}</p>}
        {!error && entries === null && <GatewaySkeleton />}
        {!error && entries?.length === 0 && <p className="gw-panel__empty">{t('gateways.no_subnets')}</p>}
        {!error && entries && entries.length > 0 && visible.length === 0 && (
          <p className="gw-panel__empty">{t('gateways.no_match')}</p>
        )}
        {visible.length > 0 && (
          <ul className="gw-list">
            {visible.map((entry, index) => (
              <GatewayRow
                key={entry.subnet_id}
                index={index}
                entry={entry}
                rowRef={(el) => { rowRefs.current[index] = el; }}
                onOpen={() => openEntry(entry)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="gw-panel__footer">
        {suggestions.length > 0 && (
          <button
            type="button"
            className="gw-panel__merge"
            onClick={() => onOpenDevice(suggestions[0].target_id, 'interfaces')}
          >
            <GitMerge size={14} aria-hidden="true" />
            {t('gateways.merge_hint', { count: suggestions.length })}
          </button>
        )}
        <button type="button" className="gw-panel__link" onClick={() => { onClose(false); navigate('/network'); }}>
          <Network size={14} aria-hidden="true" /> {t('gateways.manage_subnets')}
        </button>
      </div>
    </div>
  );
}

function GatewaySkeleton() {
  return (
    <ul className="gw-list" aria-hidden="true">
      {[0, 1, 2].map((i) => <li key={i} className="gw-row gw-row--skeleton" />)}
    </ul>
  );
}

function statusOf(entry: GatewayEntry, t: (key: string) => string) {
  if (entry.is_online === true) return { cls: 'status-dot--online', text: t('network.online') };
  if (entry.is_online === false) return { cls: 'status-dot--offline', text: t('network.offline') };
  return { cls: 'status-dot--unknown', text: t('gateways.not_seen') };
}

interface RowProps {
  index: number;
  entry: GatewayEntry;
  rowRef: (el: HTMLButtonElement | null) => void;
  onOpen: () => void;
}

function GatewayRow({ index, entry, rowRef, onOpen }: RowProps) {
  const { t } = useTranslation();
  const status = statusOf(entry, t);
  const target = entry.device_name || t('gateways.unknown_device');
  const ip = entry.gateway_ip ?? '—';
  const where = entry.vlan_id != null ? `${entry.subnet_name}, VLAN ${entry.vlan_id}` : entry.subnet_name;

  return (
    <li
      data-gw-row={index}
      className={`gw-row ${entry.is_enabled ? '' : 'is-disabled'}`}
      style={{ '--net-color': networkColor(entry.subnet_id, entry.gateway_ip) } as CSSProperties}
    >
      <button
        ref={rowRef}
        type="button"
        className="gw-row__main"
        onClick={onOpen}
        aria-label={t('gateways.row_label', { where, ip, status: status.text, target })}
      >
        <span className="gw-row__net">
          {entry.vlan_id != null && <span className="gw-vlan">VLAN {entry.vlan_id}</span>}
          <span className="gw-row__name">{entry.subnet_name}</span>
          <span className="gw-row__cidr">{entry.cidr}</span>
        </span>
        <span className="gw-row__gateway">
          <span className={`status-dot ${status.cls}`} aria-hidden="true" />
          <span className="gw-row__ip">{ip}</span>
          {entry.source && entry.source !== 'configured' && (
            <span className={`gw-source gw-source--${entry.source}`}>{t(`gateways.source_${entry.source}`)}</span>
          )}
          <span className="gw-row__target">
            <ArrowRight size={12} aria-hidden="true" />
            <span className={entry.device_id != null ? '' : 'is-muted'}>{target}</span>
          </span>
        </span>
      </button>
      {entry.gateway_ip && <CopyButton ip={entry.gateway_ip} />}
    </li>
  );
}

function CopyButton({ ip }: { ip: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ip);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const label = copied ? t('gateways.copied') : t('gateways.copy_ip', { ip });
  return (
    <button type="button" className="gw-row__copy" onClick={copy} aria-label={label} title={label}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}
