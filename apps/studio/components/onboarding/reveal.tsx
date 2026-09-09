'use client';

import type { ElementType, ReactNode } from 'react';

// Fade-in + rise-from-below, the wizard's signature entrance. Stack a few
// with increasing `delay` to cascade a step's content (eyebrow → heading →
// lead → CTA). Because the shell keys each step's container, the whole
// cascade replays on every step transition.
export function Reveal({
  delay = 0,
  as: Tag = 'div',
  className = '',
  children,
}: {
  delay?: number;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={`wizard-rise ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}

/** Stagger step in ms between successive revealed elements. */
export const STAGGER = 90;
