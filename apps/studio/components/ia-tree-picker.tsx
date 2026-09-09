'use client';

import { useStudio } from './studio-store';
import type { StudioIaTree } from '../lib/ia-route';

/**
 * The v2 structure types a person authors, in listing order. Studio supports
 * all of them today — schema, validation, and rendering — so a type missing
 * from a workspace is absent data, not an absent feature; that is why the
 * placeholder reads "none yet" rather than "planned". route_hierarchy is left
 * out because the producer writes it, and the frozen v1 types are never
 * advertised.
 */
const CURATED_LABELS = {
  organization: 'Product organization · Curated',
  navigation: 'Navigation · Curated',
} as const;

type CuratedStructureType = keyof typeof CURATED_LABELS;

const CURATED_STRUCTURE_TYPES = Object.keys(
  CURATED_LABELS,
) as CuratedStructureType[];

/** Placeholder values, kept outside the `service::tree` key space so the store
 *  resolves them to no selection even if a browser ever submitted one. */
function absentValue(type: CuratedStructureType): string {
  return `absent:${type}`;
}

/**
 * What a structure is evidence of, not how it is stored. v2 types have a
 * fixed evidence class; a curated v1 navigation tree earns the same wording
 * because it is curated by construction. Everything else — including a v1
 * tree that mixes producer and human edits — keeps the raw type and source
 * so Studio never overstates what the file proves.
 */
function structureLabel(tree: StudioIaTree): string {
  if (tree.type === 'route_hierarchy') return 'Route hierarchy · Code-derived';
  if (tree.type === 'organization') return CURATED_LABELS.organization;
  if (tree.type === 'navigation' && tree.source === 'manual') {
    return CURATED_LABELS.navigation;
  }
  return `${tree.type} · ${tree.source}`;
}

export function IaTreePicker() {
  const { iaTrees, selectedIaTreeKey, setSelectedIaTreeKey } = useStudio();
  const hasTrees = iaTrees.length > 0;
  // Presence is a catalog-wide question: one organization tree in any service
  // is enough for the type to exist, so the list only names what is nowhere.
  const absentCuratedTypes = CURATED_STRUCTURE_TYPES.filter(
    (type) => !iaTrees.some((tree) => tree.type === type),
  );

  return (
    <label className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-ink-muted">Structure</span>
      <select
        name="ia-structure"
        value={selectedIaTreeKey ?? ''}
        onChange={(event) =>
          setSelectedIaTreeKey(event.currentTarget.value || null)
        }
        disabled={!hasTrees}
        aria-label="IA service and tree"
        className={[
          'max-w-[360px] rounded-md border border-border bg-canvas px-2.5 py-1.5 text-xs text-ink',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
          'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-faint',
        ].join(' ')}
      >
        {!hasTrees ? <option value="">No IA structures</option> : null}
        {iaTrees.map((tree) => (
          <option key={tree.key} value={tree.key}>
            {tree.serviceId} · {tree.treeId} · {structureLabel(tree)}
          </option>
        ))}
        {absentCuratedTypes.map((type) => (
          <option key={type} value={absentValue(type)} disabled>
            {CURATED_LABELS[type]} — none yet
          </option>
        ))}
      </select>
    </label>
  );
}
