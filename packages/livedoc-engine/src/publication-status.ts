import { createHash } from 'node:crypto';
import type { Dok } from '@doklo-beta/core';
import {
  classifyDokChanges,
  dokContentDigest,
} from './dok-changes.js';
import {
  publicationDigest,
  type PublicationV1,
} from './publication.js';
import type { PublicationRenderEvidence } from './render.js';
import {
  PublicationSelectionError,
} from './render-selection.js';
import {
  buildTemplateSelectionModel,
  resolveTemplateSelection,
  TemplateSelectionError,
} from './template-selection-model.js';
import type { TemplateManifest } from './template-manifest.js';

export type PublicationRenderState =
  | 'not_rendered'
  | 'current'
  | 'update_available'
  | 'definition_changed'
  | 'blocked';

export type PublicationPublishState =
  | 'no_destination'
  | 'not_published'
  | 'published'
  | 'publish_needed'
  | 'publish_blocked';

export type PublicationStatusReason =
  | 'missing_dok'
  | 'selection_empty'
  | 'definition_changed'
  | 'membership_changed'
  | 'content_changed'
  | 'render_inputs_changed'
  | 'freshness_unknown'
  | 'template_changed'
  | 'template_invalid'
  | 'evidence_invalid'
  | 'publish_blocked';

export type PublicationPublishRecord = {
  schema_version: 1;
  publication: string;
  definition_sha256: string;
};

export type PublicationStatus = {
  render_state: PublicationRenderState;
  publish_state: PublicationPublishState;
  freshness: 'proven' | 'unknown';
  template_update_available: boolean;
  reasons: PublicationStatusReason[];
  resolved_dok_ids: string[];
  input_fingerprint: string;
};

export function projectPublicationStatus(input: {
  publication: PublicationV1;
  definition_sha256?: string;
  manifest: TemplateManifest;
  doks: Dok[];
  evidence?: PublicationRenderEvidence;
  publish_record?: PublicationPublishRecord;
  publish_blocked?: boolean;
  render_input_sha256?: string;
}): PublicationStatus {
  const definitionSha256 = input.definition_sha256
    ?? publicationDigest(input.publication);
  const reasons: PublicationStatusReason[] = [];
  const missing = input.publication.selected_dok_ids
    .filter((dokId) => !input.doks.some((dok) => dok.dok_id === dokId))
    .sort(compareText);
  let resolvedDokIds: string[] = [];
  let selectionBlocked = false;

  if (missing.length > 0) {
    reasons.push('missing_dok');
    selectionBlocked = true;
  } else {
    try {
      resolvedDokIds = resolveTemplateSelection(
        buildTemplateSelectionModel({
          manifest: input.manifest,
          doks: input.doks,
        }),
        input.publication.selection,
        input.doks,
      );
    } catch (error) {
      if (
        !(error instanceof PublicationSelectionError)
        && !(error instanceof TemplateSelectionError)
      ) {
        throw error;
      }
      reasons.push('selection_empty');
      selectionBlocked = true;
    }
  }

  const templateInvalid = input.publication.template !== input.manifest.name
    || !input.manifest.output_formats.includes(input.publication.format)
    || !input.manifest.supported_locales.includes(input.publication.locale);
  if (templateInvalid) reasons.push('template_invalid');

  const evidenceInvalid = input.evidence !== undefined && (
    input.evidence.publication.name !== input.publication.name
    || input.evidence.template.name !== input.publication.template
  );
  if (evidenceInvalid) reasons.push('evidence_invalid');

  const templateUpdateAvailable = input.evidence !== undefined
    && input.evidence.template.version !== input.manifest.version;
  if (templateUpdateAvailable) reasons.push('template_changed');

  const currentById = new Map(
    input.doks.map((dok) => [dok.dok_id, dok]),
  );
  const currentDoks = resolvedDokIds
    .map((dokId) => currentById.get(dokId))
    .filter((dok): dok is Dok => dok !== undefined);
  const snapshots = input.evidence?.dok_snapshots;
  const legacyRenderInputEvidence = input.evidence !== undefined
    && input.render_input_sha256 !== undefined
    && input.evidence.render_input_sha256 === undefined;
  const freshnessUnknown = selectionBlocked
    || legacyRenderInputEvidence
    || (
      snapshots !== undefined
      && currentDoks.some((dok) => {
        const snapshot = snapshots.find((entry) => entry.dok_id === dok.dok_id);
        return !snapshot?.content_sha256;
      })
    );
  if (freshnessUnknown && !selectionBlocked) reasons.push('freshness_unknown');

  let renderState: PublicationRenderState;
  if (selectionBlocked || templateInvalid || evidenceInvalid) {
    renderState = 'blocked';
  } else if (!input.evidence) {
    renderState = 'not_rendered';
  } else if (
    input.evidence.publication.definition_sha256 !== definitionSha256
  ) {
    reasons.push('definition_changed');
    renderState = 'definition_changed';
  } else {
    const evidenceIds = [...input.evidence.selected_dok_ids].sort(compareText);
    const membershipChanged = !sameStrings(resolvedDokIds, evidenceIds);
    if (membershipChanged) reasons.push('membership_changed');
    const changes = classifyDokChanges(currentDoks, snapshots);
    const reviewedContentChanged = currentDoks.some((dok) => {
      const snapshot = snapshots?.find(
        (entry) => entry.dok_id === dok.dok_id,
      );
      return snapshot?.content_sha256 !== undefined
        && snapshot.content_sha256 !== dokContentDigest(dok);
    });
    if (changes.changed.length > 0 || reviewedContentChanged) {
      reasons.push('content_changed');
    }
    const renderInputsChanged = input.render_input_sha256 !== undefined
      && input.evidence.render_input_sha256 !== undefined
      && input.render_input_sha256 !== input.evidence.render_input_sha256;
    if (renderInputsChanged) reasons.push('render_inputs_changed');
    renderState = membershipChanged
      || changes.changed.length > 0
      || reviewedContentChanged
      || renderInputsChanged
      || templateUpdateAvailable
      ? 'update_available'
      : 'current';
  }

  const publishState = projectPublishState({
    publication: input.publication,
    evidence: input.evidence,
    record: input.publish_record,
    blocked: input.publish_blocked === true,
  });
  if (publishState === 'publish_blocked') reasons.push('publish_blocked');

  return {
    render_state: renderState,
    publish_state: publishState,
    freshness: freshnessUnknown ? 'unknown' : 'proven',
    template_update_available: templateUpdateAvailable,
    reasons,
    resolved_dok_ids: resolvedDokIds,
    input_fingerprint: fingerprint({
      definition_sha256: definitionSha256,
      template: {
        name: input.manifest.name,
        version: input.manifest.version,
      },
      resolved_dok_ids: resolvedDokIds,
      doks: currentDoks.map((dok) => ({
        dok_id: dok.dok_id,
        content_sha256: dokContentDigest(dok),
        logic_hash: dok._meta.logic_hash ?? null,
        status: dok.status,
      })),
      render_input_sha256: input.render_input_sha256 ?? null,
      prior_dok_snapshots: input.evidence?.dok_snapshots ?? null,
    }),
  };
}

function projectPublishState(input: {
  publication: PublicationV1;
  evidence?: PublicationRenderEvidence;
  record?: PublicationPublishRecord;
  blocked: boolean;
}): PublicationPublishState {
  if (!input.publication.destination) return 'no_destination';
  if (input.blocked) return 'publish_blocked';
  if (!input.evidence || !input.record) return 'not_published';
  if (
    input.record.publication !== input.publication.name
    || input.record.definition_sha256
      !== input.evidence.publication.definition_sha256
  ) {
    return 'publish_needed';
  }
  return 'published';
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value), 'utf8')
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
