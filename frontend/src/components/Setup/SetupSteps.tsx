import { useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Info, Loader2, Network, Plus, Search, Zap } from 'lucide-react';
import type { ScanProgress } from '../../types';
import type { useFinishSetup, useNetworkChoice } from './setupHooks';

type HeadingRef = RefObject<HTMLHeadingElement | null>;

/** Step title; it receives focus on step changes so keyboard and screen-reader users follow along. */
function StepHeading({ headingRef, children }: { headingRef: HeadingRef; children: ReactNode }) {
  return <h1 className="setup-step__title" id="setup-step-title" ref={headingRef} tabIndex={-1}>{children}</h1>;
}

function NextButton({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className="btn btn-primary" onClick={onClick} disabled={disabled}>
      {label} <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn btn-secondary" onClick={onClick}>
      <ChevronLeft size={18} aria-hidden="true" /> {t('common.back')}
    </button>
  );
}

export function WelcomeStep({ headingRef, onNext }: { headingRef: HeadingRef; onNext: () => void }) {
  const { t } = useTranslation();
  const features = [
    { icon: Search, title: 'setup.auto_detection', desc: 'setup.auto_detection_desc' },
    { icon: Zap, title: 'setup.direct_access', desc: 'setup.direct_access_desc' },
  ];
  return (
    <div className="setup-step">
      <StepHeading headingRef={headingRef}>{t('setup.welcome_title')}</StepHeading>
      <p className="setup-step__lead">{t('setup.welcome_description')}</p>

      <ul className="setup-features">
        {features.map(({ icon: Icon, title, desc }) => (
          <li key={title}>
            <span className="setup-features__icon" aria-hidden="true"><Icon size={18} /></span>
            <div>
              <strong>{t(title)}</strong>
              <p>{t(desc)}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="setup-actions">
        <NextButton onClick={onNext} label={t('common.next')} />
      </div>
    </div>
  );
}

function NetworkList({ networks }: { networks: ReturnType<typeof useNetworkChoice> }) {
  const { t } = useTranslation();
  if (networks.loading) {
    return (
      <p className="setup-loading" role="status">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('setup.detecting_networks')}
      </p>
    );
  }
  if (networks.subnets.length === 0) {
    return networks.error ? null : <p className="settings-empty">{t('setup.no_networks')}</p>;
  }
  return (
    <div className="setup-choices" role="group" aria-labelledby="setup-step-title">
      {networks.subnets.map((subnet) => {
        const checked = networks.selected.includes(subnet.subnet);
        return (
          <label key={subnet.subnet} className={`setup-choice${checked ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={checked} onChange={() => networks.toggle(subnet.subnet)} />
            <Network size={18} className="setup-choice__icon" aria-hidden="true" />
            <span className="setup-choice__text">
              <span className="setup-choice__title">{subnet.subnet}</span>
              <span className="setup-choice__meta">
                {subnet.interface_name ? `${subnet.interface_name} · ${subnet.ip_address}` : t('setup.custom_network')}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** A network the container can't see directly, e.g. an IoT VLAN; it is scanned through the router. */
function AddNetworkForm({ onAdd }: { onAdd: (input: string) => boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    if (onAdd(value)) {
      setValue('');
      setInvalid(false);
    } else {
      setInvalid(true);
    }
  };

  return (
    <form className="settings-field" onSubmit={submit} noValidate>
      <label className="form-label" htmlFor="setup-extra-network">{t('setup.add_network_label')}</label>
      <div className="inline-form">
        <input
          id="setup-extra-network"
          className={`input input--mono${invalid ? ' input--error' : ''}`}
          placeholder="192.168.110.0/24"
          value={value}
          onChange={(e) => { setValue(e.target.value); setInvalid(false); }}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'setup-extra-network-error' : 'setup-extra-network-hint'}
        />
        <button type="submit" className="btn btn-secondary" disabled={!value.trim()}>
          <Plus size={16} aria-hidden="true" /> {t('setup.add_network')}
        </button>
      </div>
      {invalid
        ? <p className="field-error" id="setup-extra-network-error" role="alert">{t('setup.add_network_invalid')}</p>
        : <p className="field-hint" id="setup-extra-network-hint">{t('setup.add_network_hint')}</p>}
    </form>
  );
}

interface NetworksStepProps {
  headingRef: HeadingRef;
  networks: ReturnType<typeof useNetworkChoice>;
  onBack: () => void;
  onScan: () => void;
  onSkip: () => void;
}

export function NetworksStep({ headingRef, networks, onBack, onScan, onSkip }: NetworksStepProps) {
  const { t } = useTranslation();
  return (
    <div className="setup-step">
      <StepHeading headingRef={headingRef}>{t('setup.select_networks_title')}</StepHeading>
      <p className="setup-step__lead">{t('setup.select_networks_desc')}</p>

      {networks.error && (
        <div className="callout callout--danger" role="alert">
          <AlertTriangle size={16} className="callout__icon" aria-hidden="true" />
          <p className="callout__body">{t('setup.networks_failed', { error: networks.error })}</p>
        </div>
      )}

      <NetworkList networks={networks} />
      {!networks.loading && <AddNetworkForm onAdd={networks.addCustom} />}

      <div className="settings-field">
        <label className="form-label" htmlFor="setup-dns">{t('setup.dns_label')}</label>
        <input
          id="setup-dns"
          className="input input--mono"
          placeholder="192.168.1.1"
          value={networks.dnsServer}
          onChange={(e) => networks.setDnsServer(e.target.value)}
          aria-describedby="setup-dns-hint"
        />
        <p className="field-hint" id="setup-dns-hint">{t('setup.dns_desc')}</p>
      </div>

      <div className="setup-actions">
        <BackButton onClick={onBack} />
        {!networks.loading && networks.selected.length === 0
          ? <NextButton onClick={onSkip} label={t('setup.skip_scan')} />
          : <NextButton onClick={onScan} label={t('dashboard.start_scan')} disabled={networks.loading} />}
      </div>
    </div>
  );
}

const SCAN_TITLES: Partial<Record<ScanProgress['status'], string>> = {
  completed: 'setup.scan_completed',
  failed: 'setup.scan_failed',
  cancelled: 'setup.scan_cancelled',
};

function ScanMeter({ progress, isRunning }: { progress: ScanProgress | null; isRunning: boolean }) {
  const { t } = useTranslation();
  const scanned = progress?.hosts_scanned ?? 0;
  const total = progress?.hosts_total ?? 0;
  const percent = total > 0 ? Math.round((scanned / total) * 100) : null;
  return (
    <div className="setup-scan">
      <div
        className={`progress-bar${percent === null && isRunning ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-label={t('setup.scan_progress_label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className="progress-bar__fill" style={percent !== null ? { width: `${percent}%` } : undefined} />
      </div>
      <dl className="setup-scan__stats">
        <div>
          <dt>{t('setup.hosts_checked')}</dt>
          <dd>{scanned} / {total}</dd>
        </div>
        <div>
          <dt>{t('setup.devices_label')}</dt>
          <dd className="is-accent">{progress?.devices_found ?? 0}</dd>
        </div>
      </dl>
    </div>
  );
}

interface ScanStepProps {
  headingRef: HeadingRef;
  progress: ScanProgress | null;
  onAbort: () => void;
  onBack: () => void;
  onNext: () => void;
}

export function ScanStep({ headingRef, progress, onAbort, onBack, onNext }: ScanStepProps) {
  const { t } = useTranslation();
  const status = progress?.status ?? 'running';
  const isRunning = status === 'running' || status === 'idle';
  const ended = status === 'failed' || status === 'cancelled';
  // A scan that failed before checking any host has no numbers worth showing
  const showProgress = isRunning || status === 'completed' || (progress?.hosts_scanned ?? 0) > 0;

  return (
    <div className="setup-step">
      <StepHeading headingRef={headingRef}>{t(SCAN_TITLES[status] ?? 'setup.scan_in_progress')}</StepHeading>
      <p className="setup-step__lead" role="status">
        {progress?.message || (isRunning ? t('setup.initializing_scan') : '')}
      </p>

      {showProgress && <ScanMeter progress={progress} isRunning={isRunning} />}

      {ended && (
        <div className="callout callout--info">
          <Info size={16} className="callout__icon" aria-hidden="true" />
          <p className="callout__body">{t('setup.scan_later_hint')}</p>
        </div>
      )}

      <div className="setup-actions">
        {isRunning && (
          <button type="button" className="btn btn-secondary" onClick={onAbort}>
            {t('setup.abort_scan')}
          </button>
        )}
        {status === 'completed' && <NextButton onClick={onNext} label={t('common.next')} />}
        {ended && (
          <>
            <BackButton onClick={onBack} />
            <NextButton onClick={onNext} label={t('setup.continue_without_scan')} />
          </>
        )}
      </div>
    </div>
  );
}

export function SecurityStep({ headingRef, finish, onBack }: { headingRef: HeadingRef; finish: ReturnType<typeof useFinishSetup>; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <form className="setup-step" onSubmit={finish.finish} noValidate>
      <StepHeading headingRef={headingRef}>{t('setup.security_title')}</StepHeading>
      <p className="setup-step__lead">{t('setup.security_desc')}</p>

      <div className="settings-field">
        <label className="form-label" htmlFor="setup-password">{t('setup.admin_password')}</label>
        <input
          id="setup-password"
          type="password"
          className="input"
          autoComplete="new-password"
          placeholder={t('setup.password_placeholder')}
          value={finish.password}
          onChange={(e) => finish.setPassword(e.target.value)}
        />
      </div>
      <div className="settings-field">
        <label className="form-label" htmlFor="setup-password-confirm">{t('setup.confirm_password')}</label>
        <input
          id="setup-password-confirm"
          type="password"
          className={`input${finish.mismatch ? ' input--error' : ''}`}
          autoComplete="new-password"
          placeholder={t('setup.password_confirm_placeholder')}
          value={finish.confirm}
          onChange={(e) => finish.setConfirm(e.target.value)}
          aria-invalid={finish.mismatch}
          aria-describedby={finish.mismatch ? 'setup-password-error' : undefined}
        />
        {finish.mismatch && (
          <p className="field-error" id="setup-password-error" role="alert">{t('setup.passwords_dont_match')}</p>
        )}
      </div>

      <div className="callout callout--info">
        <Info size={16} className="callout__icon" aria-hidden="true" />
        <p className="callout__body">{t('setup.password_hint')}</p>
      </div>

      {finish.error && (
        <div className="callout callout--danger" role="alert">
          <AlertTriangle size={16} className="callout__icon" aria-hidden="true" />
          <p className="callout__body">{t('setup.finish_failed', { error: finish.error })}</p>
        </div>
      )}

      <div className="setup-actions">
        <BackButton onClick={onBack} />
        <button type="submit" className="btn btn-primary" disabled={!finish.canFinish}>
          <Check size={18} aria-hidden="true" /> {t('common.finish')}
        </button>
      </div>
    </form>
  );
}

export function FinishingStep({ percent, status }: { percent: number; status: string }) {
  const { t } = useTranslation();
  return (
    <div className="setup-step setup-step--center">
      <span className="setup-finish__icon" aria-hidden="true">
        {percent >= 100 ? <Check size={22} /> : <Loader2 size={22} className="animate-spin" />}
      </span>
      <h1 className="setup-step__title">{t('setup.welcome_title')}</h1>
      <p className="setup-step__lead" role="status">{status}</p>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label={t('setup.finish_progress_label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="setup-finish__percent">{percent}%</p>
    </div>
  );
}
