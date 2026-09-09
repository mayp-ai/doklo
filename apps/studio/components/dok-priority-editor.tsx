'use client';

import { useState } from 'react';
import { AlertTriangle, Lock, LockOpen } from 'lucide-react';
// The `/schemas` subpath, not the package barrel: the barrel re-exports the
// drift layer, which imports node:crypto and cannot be bundled into a client
// component. Sibling components get away with the barrel because they import
// types only (erased at build time); this one needs derivePriorityTier at
// runtime, so it must reach past the barrel.
import {
  derivePriorityTier,
  type BlastRadius,
  type BusinessImpact,
  type DokPriority,
  type PriorityTier,
} from '@doklo-beta/core/schemas';

const IMPACTS: { value: BusinessImpact; label: string; hint: string }[] = [
  { value: 'revenue',    label: 'Revenue',    hint: 'Money moves directly' },
  { value: 'core_value', label: 'Core value', hint: 'The output the product exists to produce' },
  { value: 'compliance', label: 'Compliance', hint: 'A legal or contractual obligation' },
  { value: 'enabling',   label: 'Enabling',   hint: 'The three above are unreachable without it' },
  { value: 'supporting', label: 'Supporting', hint: 'The three above stay reachable without it' },
];

const BLASTS: { value: BlastRadius; label: string; hint: string }[] = [
  { value: 'blocking',  label: 'Blocking',  hint: 'Every user is stopped' },
  { value: 'degrading', label: 'Degrading', hint: 'Some features, or some users' },
  { value: 'cosmetic',  label: 'Cosmetic',  hint: 'Inconvenient, still passable' },
];

const TIER_TONE: Record<PriorityTier, string> = {
  critical:   'bg-status-deprecated-bg text-status-deprecated-fg',
  standard:   'bg-status-review-bg text-status-review-fg',
  peripheral: 'bg-surface-2 text-ink-muted',
};

const DEFAULT_PRIORITY: DokPriority = {
  impact: 'enabling',
  blast_radius: 'degrading',
  signals: [],
  curated: {},
};

/**
 * True when a person pinned revenue or compliance and no evidence backs it.
 *
 * Rendered as an ambient badge, never as a save-blocking error and never as a
 * sync warning. A person is allowed to know something the code does not show —
 * that is the whole point of pinning — and a warning that fires on every run is
 * a warning nobody reads. This repo already has one of those: the IA placement
 * check was built, tested, and left with no production consumer.
 */
export function priorityLacksEvidence(priority: DokPriority | undefined): boolean {
  if (priority === undefined) return false;
  if (priority.curated.impact === undefined) return false;
  if (priority.impact !== 'revenue' && priority.impact !== 'compliance') return false;
  return priority.signals.length === 0;
}

export function DokPriorityEditor({
  priority,
  onChange,
  disabled = false,
}: {
  priority: DokPriority | undefined;
  onChange: (next: DokPriority) => void;
  disabled?: boolean;
}) {
  const current = priority ?? DEFAULT_PRIORITY;
  const [reason, setReason] = useState('');
  const tier = derivePriorityTier(priority);
  const canPin = reason.trim().length > 0 && !disabled;

  // Changing an axis in Studio IS a human judgment, so it pins the axis — and a
  // pin requires a reason. Without one there is nothing to write.
  function pin(field: 'impact' | 'blast_radius', value: BusinessImpact | BlastRadius) {
    if (!canPin) return;
    onChange({
      ...current,
      ...(field === 'impact'
        ? { impact: value as BusinessImpact }
        : { blast_radius: value as BlastRadius }),
      curated: {
        ...current.curated,
        [field]: { reason: reason.trim(), at: new Date().toISOString() },
      },
    });
    setReason('');
  }

  function unpin(field: 'impact' | 'blast_radius') {
    if (disabled) return;
    const curated = { ...current.curated };
    delete curated[field];
    onChange({ ...current, curated });
  }

  return (
    <section className="space-y-3" aria-label="Priority">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Priority</h3>
        <span className={`rounded px-2 py-0.5 text-xs ${TIER_TONE[tier]}`}>{tier}</span>
        {priority === undefined && (
          <span className="text-xs text-ink-muted">not judged yet</span>
        )}
        {priorityLacksEvidence(priority) && (
          <span
            className="flex items-center gap-1 text-xs text-status-deprecated-fg"
            title="A pinned revenue/compliance axis with no detector signal behind it."
          >
            <AlertTriangle size={12} aria-hidden /> no evidence backs this
          </span>
        )}
      </header>

      {(['impact', 'blast_radius'] as const).map((field) => {
        const options = field === 'impact' ? IMPACTS : BLASTS;
        const value: string = field === 'impact' ? current.impact : current.blast_radius;
        const pinned = current.curated[field];
        return (
          <div key={field} className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <span>{field === 'impact' ? 'Business impact' : 'Blast radius'}</span>
              {pinned === undefined ? (
                <LockOpen size={11} aria-label="not pinned" />
              ) : (
                <button
                  type="button"
                  onClick={() => unpin(field)}
                  className="flex items-center gap-1 text-accent-ink"
                  title={`Pinned — ${pinned.reason}. Click to unpin.`}
                >
                  <Lock size={11} aria-hidden /> pinned
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={canPin ? option.hint : `${option.hint} — add a reason first`}
                  disabled={!canPin}
                  onClick={() => pin(field, option.value)}
                  className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
                    value === option.value
                      ? 'border-accent-ink bg-accent-soft'
                      : 'border-line'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <label className="block space-y-1">
        <span className="text-xs text-ink-muted">
          Why — required to pin, because the code cannot record it
        </span>
        <input
          value={reason}
          disabled={disabled}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. the settlement API is called from this screen"
          className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-sm"
        />
      </label>

      {current.signals.length > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer">
            {current.signals.length} evidence signal
            {current.signals.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {current.signals.map((signal, index) => (
              <li key={`${signal.file}:${signal.start_line ?? 0}:${index}`}>
                <code>{signal.detector}</code> · {signal.file}
                {signal.start_line !== undefined && `:${signal.start_line}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
