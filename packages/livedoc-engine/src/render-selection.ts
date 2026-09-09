import type { Dok } from '@doklo-beta/core';
import type { PublicationSelection, PublicationV1 } from './publication.js';

export type PublicationTarget = { doks: Dok[]; dokId?: string };

export class PublicationSelectionError extends Error {
  readonly code = 'PUBLICATION_SELECTION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'PublicationSelectionError';
  }
}

export function resolvePublicationDokIds(
  doks: Dok[],
  selection: PublicationSelection,
): string[] {
  const ordered = [...doks].sort((a, b) => compareText(a.dok_id, b.dok_id));
  const available = new Set(ordered.map((dok) => dok.dok_id));

  if (selection.mode === 'explicit') {
    const missing = selection.dok_ids.filter((dokId) => !available.has(dokId)).sort(compareText);
    if (missing.length > 0) {
      throw new PublicationSelectionError(
        `Publication selection references missing Doks: ${missing.join(', ')}`,
      );
    }
    return [...selection.dok_ids].sort(compareText);
  }

  const selected = selection.mode === 'all'
    ? ordered
    : ordered.filter((dok) => matchesFilter(dok, selection));
  if (selected.length === 0) {
    throw new PublicationSelectionError('Publication selection resolved to 0 Doks');
  }
  return selected.map((dok) => dok.dok_id);
}

export function selectPublicationDoks(
  doks: Dok[],
  publication: PublicationV1,
  renderMode: 'per_dok' | 'workspace',
): { selectedDokIds: string[]; targets: PublicationTarget[] } {
  const byId = new Map(doks.map((dok) => [dok.dok_id, dok]));
  const selectedDokIds = [...publication.selected_dok_ids].sort(compareText);
  const missing = selectedDokIds.filter((dokId) => !byId.has(dokId));
  if (missing.length > 0) {
    throw new PublicationSelectionError(
      `Publication snapshot references missing Doks: ${missing.join(', ')}`,
    );
  }
  if (selectedDokIds.length === 0) {
    throw new PublicationSelectionError('Publication snapshot contains 0 Doks');
  }

  const selected = selectedDokIds.map((dokId) => byId.get(dokId)!);
  return {
    selectedDokIds,
    targets: renderMode === 'per_dok'
      ? selected.map((dok) => ({ doks: [dok], dokId: dok.dok_id }))
      : [{ doks: selected }],
  };
}

function matchesFilter(
  dok: Dok,
  selection: Extract<PublicationSelection, { mode: 'filter' }>,
): boolean {
  const tags = new Set(dok.tags);
  return (selection.include_tags ?? []).every((tag) => tags.has(tag))
    && !(selection.exclude_tags ?? []).some((tag) => tags.has(tag))
    && (
      (selection.statuses?.length ?? 0) === 0
      || selection.statuses!.includes(dok.status)
    );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
