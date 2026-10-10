import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LanguageToggle } from '../LanguageToggle';
import { useFinishSetup, useNetworkChoice, useSetupScan } from './setupHooks';
import { FinishingStep, NetworksStep, ScanStep, SecurityStep, WelcomeStep } from './SetupSteps';

interface SetupWizardProps {
  onComplete: () => void;
}

const STEP_KEYS = ['step_welcome', 'step_networks', 'step_scan', 'step_security'] as const;
const NETWORKS_STEP = 1;
const SCAN_STEP = 2;
const SECURITY_STEP = 3;

/** Page frame: text logo and language switch above a centered panel. */
function SetupShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="setup-shell">
      <header className="setup-shell__header">
        <div className="sidebar-brand setup-shell__brand">
          <span className="sidebar-brand__name">{t('app.title')}</span>
          <span className="setup-shell__tag">{t('setup.first_run')}</span>
        </div>
        <LanguageToggle />
      </header>
      <main className="setup-panel">{children}</main>
    </div>
  );
}

function stepState(index: number, current: number, skipped?: number): 'skipped' | 'done' | 'current' | 'todo' {
  if (index === skipped && index < current) return 'skipped';
  if (index < current) return 'done';
  return index === current ? 'current' : 'todo';
}

/** `skipped`: a passed step that did not complete (scan skipped or failed), shown without a check. */
function Stepper({ current, skipped }: { current: number; skipped?: number }) {
  const { t } = useTranslation();
  return (
    <ol className="setup-stepper" aria-label={t('setup.steps_label')}>
      {STEP_KEYS.map((key, index) => {
        const state = stepState(index, current, skipped);
        return (
          <li key={key} className={`setup-stepper__item is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="setup-stepper__dot" aria-hidden="true">
              {state === 'done' ? <Check size={12} strokeWidth={3} /> : state === 'skipped' ? '–' : index + 1}
            </span>
            <span className="setup-stepper__label">{t(`setup.${key}`)}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const networks = useNetworkChoice();
  const scan = useSetupScan();
  const finish = useFinishSetup(networks.dnsServer, onComplete);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isFirstStep = useRef(true);

  // Move focus to the new step's heading so keyboard and screen-reader users follow along
  useEffect(() => {
    if (isFirstStep.current) {
      isFirstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const startScan = () => {
    if (networks.selected.length === 0) return;
    setStep(SCAN_STEP);
    scan.start(networks.selected, networks.dnsServer);
  };

  if (finish.finishing) {
    return (
      <SetupShell>
        <FinishingStep percent={finish.percent} status={finish.status} />
      </SetupShell>
    );
  }

  const steps = [
    <WelcomeStep headingRef={headingRef} onNext={() => setStep(NETWORKS_STEP)} />,
    <NetworksStep headingRef={headingRef} networks={networks} onBack={() => setStep(0)} onScan={startScan} onSkip={() => setStep(SECURITY_STEP)} />,
    <ScanStep headingRef={headingRef} progress={scan.progress} onAbort={scan.abort} onBack={() => setStep(NETWORKS_STEP)} onNext={() => setStep(SECURITY_STEP)} />,
    <SecurityStep headingRef={headingRef} finish={finish} onBack={() => setStep(scan.progress ? SCAN_STEP : NETWORKS_STEP)} />,
  ];

  return (
    <SetupShell>
      <Stepper current={step} skipped={scan.progress?.status === 'completed' ? undefined : SCAN_STEP} />
      {steps[step]}
    </SetupShell>
  );
}
