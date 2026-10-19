import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  Check,
} from 'lucide-react';
import { Sidebar } from '../Sidebar';
import { MobileHeader } from '../MobileHeader';
import { api } from '../../api/client';
import { HealthDeviceRow, HealthMobileCard } from './HealthDeviceRow';
import { HealthDetailDrawer } from './HealthDetailDrawer';
import { IncidentTimeline } from './IncidentTimeline';
import type { HealthOverviewResponse, DeviceHealthItem } from '../../types';

export const HealthView: React.FC = () => {
  const { t } = useTranslation();
  const [data, setData] = useState<HealthOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('24h');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'healthy' | 'degraded' | 'flapping' | 'critical'>('all');
  const [sortBy, setSortBy] = useState<'score' | 'latency' | 'name' | 'uptime'>('score');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [selectedDevice, setSelectedDevice] = useState<DeviceHealthItem | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    const handleOutsideClick = (e: globalThis.MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setIsSortMenuOpen(false);
      }
    };
    if (isSortMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isSortMenuOpen]);

  const fetchHealthOverview = async (showLoadingSpinner = true) => {
    if (showLoadingSpinner) setLoading(true);
    setRefreshing(true);
    try {
      const res = await api.getHealthOverview(period);
      setData(res);
      // If a device was selected, update its reference in selectedDevice without stale closure
      setSelectedDevice((prev) =>
        prev ? (res.devices.find((d) => d.id === prev.id) ?? prev) : null
      );
    } catch (err) {
      console.error('Failed to load health overview:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchHealthOverview(true);
    const timer = setInterval(() => {
      fetchHealthOverview(false);
    }, 30000); // 30s background poll
    return () => clearInterval(timer);
  }, [period]);

  // Filter and sort devices
  const filteredDevices = useMemo(() => {
    if (!data) return [];
    let list = [...data.devices];

    // Status filter
    if (statusFilter !== 'all') {
      if (statusFilter === 'critical') {
        list = list.filter((d) => d.health_status === 'critical' || d.health_status === 'offline');
      } else {
        list = list.filter((d) => d.health_status === statusFilter);
      }
    }

    // Search query
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.display_name.toLowerCase().includes(q) ||
          d.ip.includes(q) ||
          (d.hostname && d.hostname.toLowerCase().includes(q)) ||
          (d.group_name && d.group_name.toLowerCase().includes(q))
      );
    }

    // Sorting
    const dir = sortOrder === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sortBy) {
        case 'score':
          return (a.health_score - b.health_score) * dir;
        case 'latency': {
          const latA = a.latency.avg_ms ?? 999999;
          const latB = b.latency.avg_ms ?? 999999;
          return (latA - latB) * dir;
        }
        case 'uptime':
          return (a.uptime.uptime_pct - b.uptime.uptime_pct) * dir;
        case 'name':
        default:
          return a.display_name.localeCompare(b.display_name) * dir;
      }
    });

    return list;
  }, [data, statusFilter, search, sortBy, sortOrder]);

  const kpis = data?.kpis;

  const getScoreColor = (score: number) => {
    if (score >= 90) return 'text-emerald-400';
    if (score >= 70) return 'text-amber-300';
    return 'text-rose-400';
  };

  return (
    <div className="app-layout">
      <Sidebar active="health" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <main className="app-main">
        <MobileHeader onMenuClick={() => setIsSidebarOpen(true)} title={t('health_page.title')} />

        <div className="w-full flex flex-col gap-6 sm:gap-7 pb-10">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-3 tracking-tight">
                <Activity size={24} className="text-sky-400 shrink-0" />
                {t('health_page.title')}
              </h1>
              <p className="text-xs sm:text-sm text-slate-400">
                {t('health_page.subtitle')}
              </p>
            </div>

            <div className="flex items-center gap-2.5 w-full sm:w-auto justify-between sm:justify-end">
              {/* Period Selector */}
              <div className="h-9 bg-[#151A21] border border-[#1F2732] p-1 rounded-lg flex items-center gap-1 text-xs font-mono shadow-sm">
                {(['24h', '7d', '30d'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPeriod(p)}
                    className={`h-7 px-3 rounded font-medium transition-colors ${
                      period === p
                        ? 'bg-[#1F2732] text-sky-400 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t(`health_page.period_${p}`)}
                  </button>
                ))}
              </div>

              {/* Refresh button */}
              <button
                type="button"
                onClick={() => fetchHealthOverview(false)}
                disabled={refreshing}
                className="h-9 w-9 flex items-center justify-center rounded-lg bg-[#151A21] border border-[#1F2732] text-slate-400 hover:text-slate-100 hover:bg-[#1F2732] transition-colors disabled:opacity-50 shadow-sm"
                title={t('common.retry')}
                aria-label={t('common.retry')}
              >
                <RefreshCw size={16} className={refreshing ? 'animate-spin text-sky-400' : ''} />
              </button>
            </div>
          </div>

          {/* Top KPI Cards with generous gaps and padding */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-5 lg:gap-6">
            {/* 1. Health Score */}
            <div className="p-5 sm:p-6 rounded-xl bg-[#151A21] border border-[#1F2732] shadow-sm flex flex-col justify-between min-h-[128px]">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {t('health_page.network_health_score')}
              </div>
              <div className="my-2.5 flex items-baseline gap-1.5">
                <span className={`text-3xl font-extrabold font-mono tracking-tight ${getScoreColor(kpis?.network_health_score ?? 100)}`}>
                  {kpis?.network_health_score ?? 100}
                </span>
                <span className="text-xs font-mono text-slate-400">/ 100</span>
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {kpis ? t('health_page.devices_measured', { count: kpis.total_devices }) : t('common.loading', 'Loading...')}
              </div>
            </div>

            {/* 2. Online / Offline */}
            <div className="p-5 sm:p-6 rounded-xl bg-[#151A21] border border-[#1F2732] shadow-sm flex flex-col justify-between min-h-[128px]">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>{t('health_page.devices_online')}</span>
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(46,160,67,0.6)]" />
              </div>
              <div className="my-2.5 text-3xl font-extrabold font-mono tracking-tight text-emerald-400">
                {kpis?.online_devices ?? 0}
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {kpis?.offline_devices ?? 0} {t('health_page.devices_offline').toLowerCase()}
              </div>
            </div>

            {/* 3. Flapping / Stability */}
            <div className="p-5 sm:p-6 rounded-xl bg-[#151A21] border border-[#1F2732] shadow-sm flex flex-col justify-between min-h-[128px]">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                <span>{t('health_page.devices_flapping')}</span>
                {(kpis?.flapping_devices ?? 0) > 0 && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_8px_rgba(227,179,65,0.6)]" />
                )}
              </div>
              <div className={`my-2.5 text-3xl font-extrabold font-mono tracking-tight ${
                (kpis?.flapping_devices ?? 0) > 0 ? 'text-amber-400' : 'text-slate-300'
              }`}>
                {kpis?.flapping_devices ?? 0}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {(kpis?.flapping_devices ?? 0) > 0 ? t('health_page.frequent_disconnects') : t('health_page.all_stable')}
              </div>
            </div>

            {/* 4. Average Latency & Jitter */}
            <div className="p-5 sm:p-6 rounded-xl bg-[#151A21] border border-[#1F2732] shadow-sm flex flex-col justify-between min-h-[128px]">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {t('health_page.avg_latency')}
              </div>
              <div className="my-2.5 text-3xl font-extrabold font-mono tracking-tight text-sky-400">
                {kpis?.avg_latency_ms !== null && kpis?.avg_latency_ms !== undefined
                  ? `${kpis.avg_latency_ms.toFixed(1)} ms`
                  : '-'}
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                Jitter: ±{kpis?.avg_jitter_ms !== null && kpis?.avg_jitter_ms !== undefined ? kpis.avg_jitter_ms.toFixed(1) : '-'} ms
              </div>
            </div>

            {/* 5. Active Warnings (SSL & Patches) */}
            <div className="p-5 sm:p-6 rounded-xl bg-[#151A21] border border-[#1F2732] shadow-sm col-span-2 md:col-span-1 flex flex-col justify-between min-h-[128px]">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                {t('health_page.active_issues')}
              </div>
              <div className={`my-2.5 text-3xl font-extrabold font-mono tracking-tight ${
                (kpis?.active_issues_count ?? 0) > 0 ? 'text-rose-400' : 'text-emerald-400'
              }`}>
                {kpis?.active_issues_count ?? 0}
              </div>
              <div className="text-[11px] text-slate-400 flex items-center gap-1.5 flex-wrap">
                {kpis && kpis.ssl_warning_count > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-amber-500/10 border border-amber-500/30 text-amber-400">
                    {kpis.ssl_warning_count} SSL
                  </span>
                )}
                {kpis && kpis.patch_warning_count > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono bg-rose-500/10 border border-rose-500/30 text-rose-400">
                    {kpis.patch_warning_count} {kpis.patch_warning_count === 1 ? 'Patch' : 'Patches'}
                  </span>
                )}
                {kpis && kpis.ssl_warning_count === 0 && kpis.patch_warning_count === 0 && (
                  <span>{t('health_page.no_security_warnings')}</span>
                )}
              </div>
            </div>
          </div>

          {/* Controls Bar: Filter, Search, Sort */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#151A21] p-4.5 sm:p-5 rounded-xl border border-[#1F2732] shadow-sm">
            {/* Search Input */}
            <div className="relative w-full md:w-72 shrink-0">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('health_page.search_placeholder')}
                className="w-full h-9 pl-9 pr-3.5 text-xs rounded-lg bg-[#0E1116] border border-[#1F2732] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition-colors shadow-inner"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between md:justify-end gap-3 sm:gap-4 flex-1">
              {/* Status Filter Badges */}
              <div className="h-9 flex items-center gap-1.5 bg-[#0E1116] p-1 rounded-lg border border-[#1F2732] overflow-x-auto max-w-full text-xs shadow-inner shrink-0 sm:shrink">
                {(['all', 'healthy', 'degraded', 'flapping', 'critical'] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setStatusFilter(filter)}
                    className={`h-7 px-3.5 rounded text-xs transition-colors whitespace-nowrap ${
                      statusFilter === filter
                        ? 'bg-[#1F2732] text-sky-400 font-medium shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t(`health_page.filter_${filter}`)}
                  </button>
                ))}
              </div>

              {/* Visual Divider between Filters and Sort */}
              <div className="h-6 w-px bg-[#1F2732] hidden lg:block" />

              {/* Sort Controls: Asc/Desc Toggle + Styled Dark Dropdown */}
              <div className="flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                  className="h-9 w-9 flex items-center justify-center rounded-lg bg-[#0E1116] border border-[#1F2732] text-slate-300 hover:text-sky-400 hover:bg-[#151A21] hover:border-slate-600 transition-colors shadow-inner"
                  title={sortOrder === 'asc' ? t('health_page.sort_asc') : t('health_page.sort_desc')}
                  aria-label={sortOrder === 'asc' ? 'Sort ascending' : 'Sort descending'}
                >
                  {sortOrder === 'asc' ? <ArrowUp size={15} /> : <ArrowDown size={15} />}
                </button>

                <div className="relative" ref={sortMenuRef}>
                  <button
                    type="button"
                    onClick={() => setIsSortMenuOpen((prev) => !prev)}
                    className="h-9 flex items-center gap-2 bg-[#0E1116] px-3.5 rounded-lg border border-[#1F2732] text-xs text-slate-200 hover:border-slate-600 transition-colors shadow-inner cursor-pointer"
                    aria-expanded={isSortMenuOpen}
                    aria-haspopup="listbox"
                  >
                    <ArrowUpDown size={14} className="text-slate-500 shrink-0" />
                    <span className="font-medium text-slate-100">
                      {sortBy === 'score' && t('health_page.sort_score')}
                      {sortBy === 'latency' && t('health_page.sort_latency')}
                      {sortBy === 'uptime' && t('health_page.sort_uptime')}
                      {sortBy === 'name' && t('health_page.sort_name')}
                    </span>
                    <ChevronDown size={13} className={`text-slate-400 transition-transform ${isSortMenuOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {isSortMenuOpen && (
                    <div
                      role="listbox"
                      className="absolute right-0 top-full mt-2 w-48 bg-[#151A21] border border-[#1F2732] rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden ring-1 ring-black/50"
                    >
                      {[
                        { key: 'score', label: t('health_page.sort_score') },
                        { key: 'latency', label: t('health_page.sort_latency') },
                        { key: 'uptime', label: t('health_page.sort_uptime') },
                        { key: 'name', label: t('health_page.sort_name') },
                      ].map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          role="option"
                          aria-selected={sortBy === item.key}
                          onClick={() => {
                            setSortBy(item.key as any);
                            setIsSortMenuOpen(false);
                          }}
                          className={`w-full px-3.5 py-2 text-left text-xs flex items-center justify-between transition-colors ${
                            sortBy === item.key
                              ? 'bg-[#1F2732] text-sky-400 font-medium'
                              : 'text-slate-300 hover:bg-[#1A222C] hover:text-slate-100'
                          }`}
                        >
                          <span>{item.label}</span>
                          {sortBy === item.key && <Check size={14} className="text-sky-400" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Desktop Matrix: Full-Width Table (hidden on mobile, visible on md+) */}
          <div className="hidden md:block bg-[#151A21] rounded-xl border border-[#1F2732] overflow-hidden shadow-sm w-full">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse table-fixed">
                <thead>
                  <tr className="border-b border-[#1F2732] bg-[#11141A] text-[11px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                    <th className="py-4.5 px-6 w-[34%] min-w-[280px]">{t('health_page.table_device')}</th>
                    <th className="py-4.5 px-6 w-48 min-w-[180px]">{t('health_page.table_status')}</th>
                    <th className="py-4.5 px-6 w-56 min-w-[220px]">{t('health_page.table_uptime')}</th>
                    <th className="py-4.5 px-6 w-60 min-w-[230px]">{t('health_page.table_latency')}</th>
                    <th className="py-4.5 px-6 w-44 min-w-[170px]">{t('health_page.table_services')}</th>
                    <th className="py-4.5 px-6 text-right w-14"></th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (!data || data.devices.length === 0) ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-500">
                        <Activity size={24} className="animate-spin text-sky-400 mx-auto mb-2" />
                        <p className="text-xs font-mono">{t('common.loading')}</p>
                      </td>
                    </tr>
                  ) : filteredDevices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-400">
                        <CheckCircle2 size={24} className="text-slate-600 mx-auto mb-2" />
                        <p className="text-xs">{t('health_page.no_devices_found')}</p>
                      </td>
                    </tr>
                  ) : (
                    filteredDevices.map((device) => (
                      <HealthDeviceRow
                        key={device.id}
                        device={device}
                        isSelected={selectedDevice?.id === device.id}
                        onSelect={(d) => setSelectedDevice(d)}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile View: Vertical Touch Cards (< md, perfect for S23 Ultra / phones) */}
          <div className="md:hidden flex flex-col gap-3">
            {loading && (!data || data.devices.length === 0) ? (
              <div className="py-12 text-center text-slate-500 bg-[#151A21] rounded-xl border border-[#1F2732] p-6">
                <Activity size={24} className="animate-spin text-sky-400 mx-auto mb-2" />
                <p className="text-xs font-mono">{t('common.loading')}</p>
              </div>
            ) : filteredDevices.length === 0 ? (
              <div className="py-12 text-center text-slate-400 bg-[#151A21] rounded-xl border border-[#1F2732] p-6">
                <CheckCircle2 size={24} className="text-slate-600 mx-auto mb-2" />
                <p className="text-xs">{t('health_page.no_devices_found')}</p>
              </div>
            ) : (
              filteredDevices.map((device) => (
                <HealthMobileCard
                  key={device.id}
                  device={device}
                  isSelected={selectedDevice?.id === device.id}
                  onSelect={(d) => setSelectedDevice(d)}
                />
              ))
            )}
          </div>

          {/* Incidents & Activity Feed (Spacious full-width card below table) */}
          <div className="bg-[#151A21] rounded-xl border border-[#1F2732] p-5 sm:p-6 flex flex-col gap-4 shadow-sm">
            <div className="flex items-center justify-between border-b border-[#1F2732] pb-3.5">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-[#0E1116] border border-[#1F2732] flex items-center justify-center">
                  <Clock size={15} className="text-sky-400" />
                </div>
                <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
                  {t('health_page.incidents_title')}
                </h2>
              </div>
              <span className="text-xs font-mono px-2.5 py-1 rounded bg-[#0E1116] border border-[#1F2732] text-slate-300">
                {data?.recent_incidents?.length ?? 0}
              </span>
            </div>

            <IncidentTimeline
              incidents={data?.recent_incidents || []}
              onSelectDevice={(id) => {
                const target = data?.devices.find((d) => d.id === id);
                if (target) setSelectedDevice(target);
              }}
            />
          </div>
        </div>
      </main>

      {/* Slide-out Telemetry Drawer */}
      <HealthDetailDrawer
        device={selectedDevice}
        period={period}
        onClose={() => setSelectedDevice(null)}
        onUpdated={() => fetchHealthOverview(false)}
      />
    </div>
  );
};
