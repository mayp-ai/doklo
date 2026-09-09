'use client';
import { EyeOff, Eye } from 'lucide-react';
import { DokIdSchema } from '@doklo-beta/core/schemas';
import type { ConsolidatedFeature, ConsolidatedFeatureGroup } from '../../lib/consolidation';
import type { ConsolidationAction } from '../../lib/hooks/use-consolidation-reducer';
import type { ConfirmationCopy } from '../confirmation-dialog';

export function FeatureRow({
  feature, groupId, groups, onAct, onConfirmAct, selected, onToggleSelect,
}: {
  feature: ConsolidatedFeature;
  groupId: string;
  groups: ConsolidatedFeatureGroup[];
  onAct: (a: ConsolidationAction) => void;
  onConfirmAct: (
    action: ConsolidationAction,
    copy: ConfirmationCopy,
    trigger: HTMLButtonElement,
  ) => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const excluded = feature.decision === 'exclude';
  const others = groups.filter((g) => g.group_id !== groupId);
  // dok_id_prefix IS the final Dok id (no -NNN serial) — invalid here means
  // the generator will hard-fail on this feature. Flag it live, but never
  // block or rewrite what the user typed (fail-closed lives at save time).
  const prefixValid = DokIdSchema.safeParse(feature.dok_id_prefix ?? '').success;
  return (
    <li className={[
      'flex items-center gap-2 rounded px-2 py-1.5 text-[13px]',
      excluded ? 'text-ink-faint line-through' : 'text-ink',
    ].join(' ')}>
      <input type="checkbox" checked={selected} onChange={onToggleSelect}
             aria-label={`Select ${feature.label}`} className="accent-accent" />
      {excluded ? (
        <span className="font-mono text-[11px] text-ink-muted">{feature.dok_id_prefix}</span>
      ) : (
        <input
          type="text"
          spellCheck={false}
          value={feature.dok_id_prefix ?? ''}
          onChange={(e) => onAct({
            type: 'editDokIdPrefix',
            canonicalId: feature.canonical_id,
            dokIdPrefix: e.currentTarget.value,
          })}
          aria-label={`Edit dok_id_prefix for ${feature.label}`}
          aria-invalid={!prefixValid}
          className={[
            'w-28 shrink-0 rounded border bg-canvas px-1 py-0.5 font-mono text-[11px]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            prefixValid ? 'border-border text-ink-muted' : 'border-status-draft-fg text-status-draft-fg',
          ].join(' ')}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{feature.label}</span>
      {feature.decision === 'merge' && !excluded && (
        <span className="rounded bg-accent-soft px-1 text-[10px] text-accent-ink">merge</span>
      )}
      {others.length > 0 && !excluded && (
        <select
          value=""
          onChange={(e) => e.currentTarget.value && onAct({ type: 'moveFeature', canonicalId: feature.canonical_id, toGroupId: e.currentTarget.value })}
          aria-label="Move to another group"
          className="rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-ink-muted"
        >
          <option value="">Move▾</option>
          {others.map((g) => <option key={g.group_id} value={g.group_id}>{g.label}</option>)}
        </select>
      )}
      <button type="button"
        onClick={(event) => onConfirmAct(
          { type: 'toggleExclude', canonicalId: feature.canonical_id },
          {
            title: excluded ? `Include ${feature.label}?` : `Exclude ${feature.label}?`,
            description: excluded
              ? 'This Dok will return to its previous generation decision.'
              : 'This Dok will be excluded from the generation plan.',
            confirmLabel: excluded ? 'Include Dok' : 'Exclude Dok',
          },
          event.currentTarget,
        )}
        aria-label={excluded ? `Include ${feature.label}` : `Exclude ${feature.label}`}
        title={excluded ? `Include ${feature.label}` : `Exclude ${feature.label}`}
        className="text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {excluded ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </li>
  );
}
