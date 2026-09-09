'use client';

import { Loader2 } from 'lucide-react';
import { STEP_ORDER, type WizardStep } from './onboarding-store';

const STEP_LABELS: Record<WizardStep, string> = {
  welcome: 'WELCOME',
  extract: 'EXTRACT',
  hub: 'HUB',
  livedocs: 'LIVE DOCS',
};

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`wizard-spin ${className}`} aria-hidden />;
}

/** Tiny vertical step list that sits just left of the centred content.
 *  No markers — only the current step is emphasised (bold + accent). */
export function MiniSteps({ current }: { current: WizardStep }) {
  const currentIdx = STEP_ORDER.indexOf(current);
  return (
    <ol className="flex shrink-0 flex-col gap-4" aria-label="Progress steps">
      {STEP_ORDER.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            className={
              active
                ? 'text-sm font-bold tracking-tight text-accent'
                : `text-sm font-medium tracking-tight transition-colors ${done ? 'text-ink-secondary' : 'text-ink-faint'}`
            }
          >
            {STEP_LABELS[step]}
          </li>
        );
      })}
    </ol>
  );
}
