'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * SmartSidebar — generic 360px right pane shell shared by every view.
 *
 *   <SmartSidebar>
 *     <DokPreview />
 *   </SmartSidebar>
 *
 * The preview owns its data subscription (e.g. useSelectedDok()) so
 * the shell stays oblivious to which layer it's serving.
 *
 * Phase 9 adds a `transitionKey` prop. When the key changes, the
 * panel content fades + slides 5px on the Y axis (180ms ease-out-quart)
 * so the dynamic-sidebar editor flow (focus-driven content swap)
 * doesn't feel abrupt. Static usages (hub-views) leave the prop
 * undefined and get the original no-transition behavior.
 *
 * When `children` is null (preview returned null because nothing is
 * selected), `empty` shows instead — or a default hint.
 */
export function SmartSidebar({
  children,
  empty,
  transitionKey,
}: {
  children: ReactNode;
  empty?: ReactNode;
  /** Stable string key. When it changes, children fade + 5px Y slide. */
  transitionKey?: string;
}) {
  const hasContent =
    children !== null &&
    children !== undefined &&
    children !== false;

  return (
    <aside
      aria-label="Context panel"
      // `relative` keeps absolutely-positioned descendants (e.g. .sr-only
      // spans in previews) inside this scroll context — without it their
      // containing block is the ICB and they stretch the document height.
      className="relative h-full w-90 shrink-0 overflow-x-hidden overflow-y-auto border-l border-border bg-surface p-6"
    >
      {hasContent ? (
        transitionKey !== undefined ? (
          <TransitionFrame transitionKey={transitionKey}>{children}</TransitionFrame>
        ) : (
          children
        )
      ) : (
        empty ?? <DefaultEmpty />
      )}
    </aside>
  );
}

/** Cross-fade + 5px Y slide on transitionKey change. Honors
 *  prefers-reduced-motion by skipping animation entirely. */
function TransitionFrame({
  transitionKey,
  children,
}: {
  transitionKey: string;
  children: ReactNode;
}) {
  // Track which key we last rendered fully; if it differs from the
  // incoming prop, we hold the previous frame, fade it out, swap, then
  // fade the new one in. Implementation here is the lighter version:
  // change the key on a wrapping div with a key={} so React unmounts +
  // re-mounts the subtree, while a CSS animation handles the entry.
  const [appliedKey, setAppliedKey] = useState(transitionKey);
  const firstRenderRef = useRef(true);

  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    setAppliedKey(transitionKey);
  }, [transitionKey]);

  return (
    <div
      key={appliedKey}
      className="animate-sidebar-in motion-reduce:animate-none"
      style={{
        // Inline keyframe values so we don't depend on a tailwind plugin.
        // 180ms ease-out-quart, opacity 0→1 + translateY 5px→0.
        animationName: 'sidebar-slide-in',
        animationDuration: '180ms',
        animationTimingFunction: 'cubic-bezier(0.25, 1, 0.5, 1)',
        animationFillMode: 'both',
      }}
    >
      {children}
    </div>
  );
}

function DefaultEmpty() {
  return (
    <div className="text-sm leading-relaxed text-ink-muted">
      Select an item on the left.
    </div>
  );
}

/**
 * Group within SmartSidebar. First section sits flush with the top of
 * the pane; subsequent sections get mt-6 to breathe.
 *
 * `count` (e.g. "8 steps") goes to the right of the title in the same
 * row — kept small and ink-faint so it never competes with the label.
 */
export function SmartSidebarSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <header className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
          {title}
        </span>
        {count && (
          <span className="font-mono text-[11px] text-ink-faint">{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}
