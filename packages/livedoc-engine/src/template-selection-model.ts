import type { Dok } from '@doklo-beta/core';
import type { PublicationSelection } from './publication.js';
import { selectDoks } from './selector.js';
import type {
  TemplateManifest,
  TemplateScope,
} from './template-manifest.js';

export type TemplateSelectionKind =
  | 'all_eligible'
  | 'filter'
  | 'explicit';

export type TemplateSelectionExclusionReason =
  | 'unreviewed'
  | 'template_selector';

export type TemplateSelectionModel = {
  scope: TemplateScope;
  eligible_dok_ids: string[];
  default_kind: 'all_eligible' | 'explicit' | 'template';
  allowed_kinds: TemplateSelectionKind[];
  excluded: Array<{
    dok_id: string;
    reason: TemplateSelectionExclusionReason;
  }>;
};

export class TemplateSelectionError extends Error {
  readonly code = 'TEMPLATE_SELECTION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'TemplateSelectionError';
  }
}

export function buildTemplateSelectionModel(input: {
  manifest: TemplateManifest;
  doks: Dok[];
}): TemplateSelectionModel {
  const ordered = [...input.doks].sort(byDokId);
  const eligibleForReview = input.manifest.stability === 'stable'
    ? ordered.filter((dok) => dok.status === 'active')
    : ordered;
  const reviewEligibleIds = new Set(
    eligibleForReview.map((dok) => dok.dok_id),
  );
  const selected = input.manifest.selector
    ? selectDoks(eligibleForReview, input.manifest.selector)
    : eligibleForReview;
  const eligibleIds = new Set(selected.map((dok) => dok.dok_id));
  const excluded: TemplateSelectionModel['excluded'] = [];

  for (const dok of ordered) {
    if (!reviewEligibleIds.has(dok.dok_id)) {
      excluded.push({ dok_id: dok.dok_id, reason: 'unreviewed' });
    } else if (!eligibleIds.has(dok.dok_id)) {
      excluded.push({
        dok_id: dok.dok_id,
        reason: 'template_selector',
      });
    }
  }

  return {
    scope: input.manifest.scope,
    eligible_dok_ids: [...eligibleIds].sort(compareText),
    default_kind: input.manifest.scope === 'per_dok'
      ? 'explicit'
      : input.manifest.scope === 'workspace'
        ? 'all_eligible'
        : 'template',
    allowed_kinds: ['all_eligible', 'filter', 'explicit'],
    excluded,
  };
}

export function resolveTemplateSelection(
  model: TemplateSelectionModel,
  selection:
    | PublicationSelection
    | { mode: 'all_eligible' },
  doks: Dok[] = [],
): string[] {
  const eligible = new Set(model.eligible_dok_ids);
  if (selection.mode === 'all' || selection.mode === 'all_eligible') {
    if (model.eligible_dok_ids.length === 0) {
      throw new TemplateSelectionError(
        'Template selection resolved to 0 eligible Doks',
      );
    }
    return [...model.eligible_dok_ids];
  }

  if (selection.mode === 'explicit') {
    const invalid = selection.dok_ids
      .filter((dokId) => !eligible.has(dokId))
      .sort(compareText);
    if (invalid.length > 0) {
      throw new TemplateSelectionError(
        `Doks are not eligible for this Template: ${invalid.join(', ')}`,
      );
    }
    return [...selection.dok_ids].sort(compareText);
  }

  const tagsById = new Map(
    doks
      .filter((dok) => eligible.has(dok.dok_id))
      .map((dok) => [dok.dok_id, dok]),
  );
  const selected = model.eligible_dok_ids.filter((dokId) => {
    const dok = tagsById.get(dokId);
    if (!dok) return false;
    const tags = new Set(dok.tags);
    return (selection.include_tags ?? []).every((tag) => tags.has(tag))
      && !(selection.exclude_tags ?? []).some((tag) => tags.has(tag))
      && (
        (selection.statuses?.length ?? 0) === 0
        || selection.statuses!.includes(dok.status)
      );
  });
  if (selected.length === 0) {
    throw new TemplateSelectionError(
      'Template selection resolved to 0 eligible Doks',
    );
  }
  return selected;
}

function byDokId(left: Dok, right: Dok): number {
  return compareText(left.dok_id, right.dok_id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
