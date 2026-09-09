'use client';
import { useState } from 'react';
import { EyeOff } from 'lucide-react';
import type { ConsolidatedFeatureGroup } from '../../lib/consolidation';
import type { ConsolidationAction } from '../../lib/hooks/use-consolidation-reducer';
import type { ConfirmationCopy } from '../confirmation-dialog';
import { FeatureRow } from './feature-row';

export function GroupColumn({
  group, groups, onAct, onConfirmAct, selectedFeatures, onToggleFeature, groupSelected, onToggleSelectGroup,
}: {
  group: ConsolidatedFeatureGroup;
  groups: ConsolidatedFeatureGroup[];
  onAct: (a: ConsolidationAction) => void;
  onConfirmAct: (
    action: ConsolidationAction,
    copy: ConfirmationCopy,
    trigger: HTMLButtonElement,
  ) => void;
  selectedFeatures: Set<string>;
  onToggleFeature: (canonicalId: string) => void;
  groupSelected: boolean;
  onToggleSelectGroup: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(group.label);
  const allExcluded = group.features.length > 0 && group.features.every((f) => f.decision === 'exclude');

  return (
    <div data-group={group.group_id}
         className="rounded-lg border border-border bg-surface p-3 motion-safe:transition-colors">
      <div className="mb-2 flex items-center gap-2">
        <input type="checkbox" checked={groupSelected} onChange={onToggleSelectGroup}
               aria-label={`Select group ${group.label}`} className="accent-accent" />
        {editing ? (
          <input autoFocus value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            onBlur={() => { setEditing(false); if (label.trim() && label !== group.label) onAct({ type: 'renameGroup', groupId: group.group_id, label: label.trim() }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setLabel(group.label); setEditing(false); } }}
            className="min-w-0 flex-1 rounded border border-accent bg-canvas px-1 text-sm text-ink-strong" />
        ) : (
          <button type="button" onClick={() => setEditing(true)}
            className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-ink-strong hover:text-accent-ink">
            {group.label}
          </button>
        )}
        <span className="font-mono text-[11px] text-ink-faint">{group.features.filter((f) => f.decision !== 'exclude').length}</span>
        <button type="button"
          onClick={(event) => onConfirmAct(
            { type: 'excludeGroup', groupId: group.group_id, exclude: !allExcluded },
            {
              title: allExcluded ? `Include ${group.label}?` : `Exclude ${group.label}?`,
              description: allExcluded
                ? 'Every Dok in this group will return to its previous generation decision.'
                : 'Every Dok in this group will be excluded from the generation plan.',
              confirmLabel: allExcluded ? 'Include group' : 'Exclude group',
            },
            event.currentTarget,
          )}
          title={allExcluded ? 'Include entire group' : 'Exclude entire group'} aria-label={allExcluded ? 'Include entire group' : 'Exclude entire group'}
          className="text-ink-muted hover:text-ink"><EyeOff size={14} /></button>
      </div>
      <ul className="space-y-0.5">
        {group.features.map((f) => (
          <FeatureRow key={f.canonical_id} feature={f} groupId={group.group_id} groups={groups}
            onAct={onAct} onConfirmAct={onConfirmAct} selected={selectedFeatures.has(f.canonical_id)}
            onToggleSelect={() => onToggleFeature(f.canonical_id)} />
        ))}
      </ul>
      {group.excluded.length > 0 && (
        <p className="mt-2 text-[11px] text-ink-faint">ⓘ AI excluded {group.excluded.length} (read-only)</p>
      )}
    </div>
  );
}
