'use client';

import { useEffect, useRef } from 'react';
import type { DocLocale } from '../../lib/livedoc-templates';
import type { WizardWorkspaceState } from '../../lib/wizard-actions';
import { OnboardingProvider, useOnboarding } from './onboarding-store';
import { WizardFrame } from './wizard-frame';

const LOCALES: DocLocale[] = ['ko', 'en'];

function LocaleToggle() {
  const { locale, setLocale } = useOnboarding();
  return (
    <div role="group" aria-label={locale === 'en' ? 'Language' : '언어'} className="fixed right-5 top-5 z-20 inline-flex rounded-md border border-border bg-surface/80 p-0.5 backdrop-blur">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
          className={
            locale === l
              ? 'rounded bg-accent px-2.5 py-1 text-xs font-semibold text-canvas'
              : 'rounded px-2.5 py-1 text-xs font-medium text-ink-secondary transition-colors hover:text-ink'
          }
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
import { StepWelcome } from './step-welcome';
import { StepExtract } from './step-extract';
import { StepHub } from './step-hub';
import { StepLivedocs } from './step-livedocs';

interface ShellProps {
  workspaceName: string;
  initialState: WizardWorkspaceState;
}

function ActiveStep({ workspaceName }: ShellProps) {
  const { step } = useOnboarding();
  switch (step) {
    case 'welcome':
      return (
        <WizardFrame>
          <StepWelcome workspaceName={workspaceName} />
        </WizardFrame>
      );
    case 'extract':
      return (
        <WizardFrame>
          <StepExtract />
        </WizardFrame>
      );
    case 'hub':
      return (
        <WizardFrame wide>
          <StepHub />
        </WizardFrame>
      );
    case 'livedocs':
      return (
        <WizardFrame wide>
          <StepLivedocs />
        </WizardFrame>
      );
  }
}

function ShellInner(props: ShellProps) {
  const { step } = useOnboarding();
  const topRef = useRef<HTMLDivElement>(null);
  const initialStepRef = useRef(true);

  // Reset scroll on each step change so a taller step never lands the next
  // one below the fold.
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: 'start' });
    if (initialStepRef.current) {
      initialStepRef.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>('main h1, main h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }, [step]);

  return (
    <>
      <LocaleToggle />
      <div ref={topRef} />
      {/* `key` swaps the container per step so the entrance animation
       *  replays on each transition. */}
      <main key={step} className="wizard-step">
        <ActiveStep {...props} />
      </main>
    </>
  );
}

export function OnboardingShell(props: ShellProps) {
  return (
    <OnboardingProvider initialState={props.initialState}>
      <ShellInner {...props} />
    </OnboardingProvider>
  );
}
