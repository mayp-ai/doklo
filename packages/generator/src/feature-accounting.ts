export interface ConsolidatedFeatureAccounting {
  canonicalFeatureId: string;
  sourceFeatureIds: readonly string[];
  excluded: boolean;
  serviceId?: string;
  dokId?: string;
  existing?: boolean;
  notSelected?: boolean;
  interrupted?: boolean;
  failed?: string;
}

export interface FeatureAccountingInput {
  sourceFeatures: readonly (string | { id: string; serviceId?: string })[];
  consolidated: readonly ConsolidatedFeatureAccounting[];
  serviceId?: string;
}

export interface FeatureLedgerEntry {
  sourceFeatureId: string;
  serviceId: string;
  canonicalFeatureId: string | null;
  dokId: string | null;
  status: 'success' | 'skipped' | 'failed';
  reasonCode:
    | 'GENERATED'
    | 'EXISTING_PRESERVED'
    | 'EXCLUDED_BY_CONSOLIDATION'
    | 'NOT_SELECTED'
    | 'INTERRUPTED'
    | 'GENERATION_FAILED';
  message: string;
}

export type GenerationLedgerModel =
  | 'anthropic/claude-sonnet-5'
  | 'openai/gpt-5.6-terra';

export interface GenerationLedgerMetadata {
  workspaceId: string;
  model: GenerationLedgerModel;
  planDigest: string;
  startedAt: string;
  completedAt: string;
}

export interface GenerationLedger {
  schema_version: 1;
  workspaceId: string;
  model: GenerationLedgerModel;
  planDigest: string;
  startedAt: string;
  completedAt: string;
  entries: FeatureLedgerEntry[];
  summary: {
    sourceFeatures: number;
    success: number;
    skipped: number;
    failed: number;
  };
}

type FeatureLedgerIdentity = Pick<
  FeatureLedgerEntry,
  'sourceFeatureId' | 'serviceId' | 'canonicalFeatureId' | 'dokId'
>;

/** Explicit ledger state transitions used by reconciliation and integrations. */
export function markGenerated(identity: FeatureLedgerIdentity): FeatureLedgerEntry {
  return {
    ...identity,
    status: 'success',
    reasonCode: 'GENERATED',
    message: 'Generated Dok.',
  };
}

export function markPreserved(
  identity: FeatureLedgerIdentity,
  message = 'Existing Dok preserved.',
): FeatureLedgerEntry {
  return {
    ...identity,
    status: 'skipped',
    reasonCode: 'EXISTING_PRESERVED',
    message,
  };
}

export function markExcluded(identity: FeatureLedgerIdentity): FeatureLedgerEntry {
  return {
    ...identity,
    status: 'skipped',
    reasonCode: 'EXCLUDED_BY_CONSOLIDATION',
    message: 'Excluded by consolidation.',
  };
}

export function markNotSelected(identity: FeatureLedgerIdentity): FeatureLedgerEntry {
  return {
    ...identity,
    status: 'skipped',
    reasonCode: 'NOT_SELECTED',
    message: 'Not selected by onlyDokIds; no existing Dok to preserve.',
  };
}

export function markInterrupted(identity: FeatureLedgerIdentity): FeatureLedgerEntry {
  return {
    ...identity,
    status: 'failed',
    reasonCode: 'INTERRUPTED',
    message: 'Generation interrupted; retry this Dok.',
  };
}

export function markFailed(
  identity: FeatureLedgerIdentity,
  message: string,
): FeatureLedgerEntry {
  return {
    ...identity,
    status: 'failed',
    reasonCode: 'GENERATION_FAILED',
    message,
  };
}

/** Reconcile every original feature ID before any Hub write occurs. */
export function reconcileSourceFeatures(input: FeatureAccountingInput): FeatureLedgerEntry[] {
  const source = input.sourceFeatures.map((item) => typeof item === 'string' ? {
    id: item,
    serviceId: input.serviceId,
  } : item);
  const sourceIds = new Set<string>();
  for (const item of source) {
    if (sourceIds.has(item.id)) throw new Error(`DUPLICATE_SOURCE_FEATURE: ${item.id}`);
    sourceIds.add(item.id);
  }

  const seen = new Set<string>();
  const entries: FeatureLedgerEntry[] = [];
  for (const group of input.consolidated) {
    const local = new Set<string>();
    for (const sourceFeatureId of group.sourceFeatureIds) {
      if (local.has(sourceFeatureId) || seen.has(sourceFeatureId)) {
        throw new Error(`DUPLICATE_SOURCE_FEATURE: ${sourceFeatureId}`);
      }
      local.add(sourceFeatureId);
      if (!sourceIds.has(sourceFeatureId)) {
        throw new Error(`UNKNOWN_SOURCE_FEATURE: ${sourceFeatureId}`);
      }
      seen.add(sourceFeatureId);
      const sourceItem = source.find((item) => item.id === sourceFeatureId)!;
      const serviceId = group.serviceId ?? sourceItem.serviceId ?? input.serviceId ?? '';
      const identity: FeatureLedgerIdentity = {
        sourceFeatureId,
        serviceId,
        canonicalFeatureId: group.canonicalFeatureId,
        dokId: group.dokId ?? null,
      };
      if (group.failed !== undefined) {
        entries.push(markFailed(identity, group.failed));
      } else if (group.excluded) {
        entries.push(markExcluded(identity));
      } else if (group.interrupted) {
        entries.push(markInterrupted(identity));
      } else if (group.existing) {
        entries.push(markPreserved(identity));
      } else if (group.notSelected) {
        entries.push(markNotSelected(identity));
      } else {
        entries.push(markGenerated(identity));
      }
    }
  }
  const missing = [...sourceIds].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`MISSING_SOURCE_FEATURE: ${missing.join(', ')}`);
  return entries.sort((a, b) => a.sourceFeatureId.localeCompare(b.sourceFeatureId));
}

export function finalizeGenerationLedger(
  entries: readonly FeatureLedgerEntry[],
  metadata: GenerationLedgerMetadata,
): GenerationLedger {
  const summary = {
    sourceFeatures: entries.length,
    success: entries.filter((entry) => entry.status === 'success').length,
    skipped: entries.filter((entry) => entry.status === 'skipped').length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
  };
  return {
    schema_version: 1,
    ...metadata,
    entries: [...entries],
    summary,
  };
}
