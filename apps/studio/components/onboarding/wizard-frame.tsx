'use client';

import type { ReactNode } from 'react';
import { MiniSteps } from './progress';
import { useOnboarding } from './onboarding-store';

// The whole onboarding lives in a compact block centred in the viewport
// (not full-bleed). Inside: a tiny step marker on the far left, then the
// step's own [narrative | peek] columns. `wide` gives the Live Docs step
// a little more room for its recommendation cards.
export function WizardFrame({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  const { step } = useOnboarding();
  return (
    <div className="grid min-h-screen place-items-center px-8 py-12">
      <div
        className={`flex w-full items-center gap-9 ${wide ? 'max-w-4xl' : 'max-w-3xl'}`}
      >
        <MiniSteps current={step} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

// Two-column step body: narrative + CTA on the left, the live "peek" of
// what's being produced on the right.
export function SplitBody({
  narrative,
  peek,
}: {
  narrative: ReactNode;
  peek?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-10">
      <div className="flex w-[22rem] shrink-0 flex-col gap-5">{narrative}</div>
      {peek !== undefined && <div className="min-w-0 flex-1">{peek}</div>}
    </div>
  );
}
