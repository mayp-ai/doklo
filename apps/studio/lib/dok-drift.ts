// Dok drift in Studio: whether a Dok is stale, the sync judge's unconfirmed
// verdict beside it, and the "Still accurate" confirmation that re-stamps its
// drift baseline (judge-gated sync design §4.6, §4.7). Server-only: it reads
// tracked source files and runs git, through core and the CLI's drift entry
// point. Client components import only its types.
//
// Staleness has to read here exactly as `doklo show`, `doklo sync` and the MCP
// server read it, or a comments-only edit would be fresh in the terminal and
// stale in Studio — the split-reader failure the CLI's drift contract test
// pins. The CLI's library entry point (`@doklo-beta/cli/api`) does not export
// its `isDokStale`; it exports `computeDriftConfirmation`, which reads the
// tracked files with the same function and hashes them with the same
// normaliser. So `inspectDokDrift` runs core's gates and raw comparison, then —
// only where the raw hash moved — compares the stored normalised hash with the
// one `computeDriftConfirmation` computes now: the same decision, in the same
// order, as the CLI entry point (`apps/cli/src/lib/drift.ts`).
// __tests__/dok-drift-actions.test.ts pins the agreement state by state.
import {
  dokProjectRoot,
  isDokStale,
  type Dok,
  type DokMeta,
  type SourceAnchor,
  type StaleReason,
  type StaleResult,
  type Workspace,
} from '@doklo-beta/core';
import type { DriftConfirmation, JudgeCacheRecord } from '@doklo-beta/cli/api';

/**
 * The CLI library, loaded on first use. Its drift entry point carries the
 * TypeScript parser the normaliser needs; no other Studio save should pay to
 * load it.
 */
function cliApi(): Promise<typeof import('@doklo-beta/cli/api')> {
  return import('@doklo-beta/cli/api');
}

/** A Dok's freshness as the CLI reads it (`{ stale, reason? }`). */
export type DokDriftState = StaleResult;

/**
 * Why "Still accurate" refuses a Dok. `NOT_STALE`: nothing to confirm (fresh,
 * changed in form only, or drift undecidable). `TRACKING_REVIEW_REQUIRED`: a
 * scan recovered dependencies after generation; that review gate stays, and
 * only regeneration clears it. `NOTHING_TO_CONFIRM`: a tracked file cannot be
 * read, or the Dok tracks none — confirming would bless a source nobody read.
 */
export type DokDriftRefusal = 'NOT_STALE' | 'TRACKING_REVIEW_REQUIRED' | 'NOTHING_TO_CONFIRM';

/** The refusals a stale Dok can show before anyone presses the button. */
export type DokDriftBlock = Exclude<DokDriftRefusal, 'NOT_STALE'>;

/** The sync judge's cached `accurate` verdict, as the editor shows it. */
export interface DokJudgeVerdict {
  /** The model that gave the verdict, e.g. `anthropic/claude-sonnet-5`. */
  model: string;
  /** One sentence, in the workspace locale: why the Dok still holds. */
  summary: string;
  /** The Dok statements the judge verified, and the files that show they hold. */
  checked: Array<{ claimPath: string; files: string[]; reason: string }>;
}

/** One Dok's drift, as a Studio screen needs it. */
export interface DokDriftView {
  dokId: string;
  /** The revision of the Dok file the drift was read from. */
  revision: string;
  drift: DokDriftState;
  /**
   * The judge's unconfirmed `accurate` verdict while it still holds for the
   * Dok's code, diff base and text — read for a stale `changed` Dok only, as
   * `doklo show` reads it. Never a freshness claim: the Dok stays stale until a
   * person confirms it.
   */
  verdict: DokJudgeVerdict | null;
  /** Why "Still accurate" cannot apply to this stale Dok; null when it can, or when the Dok is not stale. */
  blocked: DokDriftBlock | null;
}

export interface DokDriftInspection {
  drift: DokDriftState;
  /**
   * The baseline a confirmation would stamp, computed when the raw hash moved
   * (`changed`): null when a tracked file cannot be read or nothing is
   * tracked; undefined for every other state, which has nothing to confirm.
   */
  confirmation?: DriftConfirmation | null;
}

/**
 * A Dok's staleness against its sources under `projectRoot`
 * (`dokProjectRoot`), with the format-only layer on: a Dok whose tracked
 * sources changed only in comments, whitespace or line endings since it was
 * generated or last confirmed reads `{ stale: false, reason: 'format-only' }`.
 */
export async function inspectDokDrift(dok: Dok, projectRoot: string): Promise<DokDriftInspection> {
  // Core without a normaliser: the 0.3.2 gates (no-hash, tracking-expanded,
  // unverified-tracking) and the raw comparison, in the CLI's order.
  const raw = isDokStale(dok, projectRoot);
  if (!raw.stale || raw.reason !== 'changed') return { drift: raw };
  const { computeDriftConfirmation } = await cliApi();
  const confirmation = await computeDriftConfirmation(dok, projectRoot);
  // The stored value is "<normaliser version>:<sha256>", so string equality
  // is the CLI's version check and hash comparison in one.
  const stored = dok._meta?.logic_hash_normalized;
  const formOnly = confirmation !== null
    && stored !== undefined
    && confirmation.logic_hash_normalized === stored;
  return {
    drift: formOnly ? { stale: false, reason: 'format-only' } : raw,
    confirmation,
  };
}

function trackedFileCount(dok: Dok): number {
  return (dok._meta?.logic_files ?? dok._meta?.source_anchors ?? []).length;
}

/** Why "Still accurate" cannot apply to a stale Dok, or null when it can (or when the Dok is not stale). */
export function driftBlock(dok: Dok, drift: DokDriftState): DokDriftBlock | null {
  if (!drift.stale) return null;
  if (drift.reason === 'tracking-expanded') return 'TRACKING_REVIEW_REQUIRED';
  if (drift.reason !== 'changed' || trackedFileCount(dok) === 0) return 'NOTHING_TO_CONFIRM';
  return null;
}

/** Plain-language reason a confirmation was refused, for the action result. */
export function driftRefusalMessage(dokId: string, refusal: DokDriftRefusal, drift: DokDriftState): string {
  if (refusal === 'TRACKING_REVIEW_REQUIRED') {
    return `Dok ${dokId}: recovered source tracking needs review. Regenerate it with \`doklo sync\`; a confirmation does not clear that review.`;
  }
  if (refusal === 'NOTHING_TO_CONFIRM') {
    return `Dok ${dokId}: a tracked source file cannot be read, or the Dok tracks none — there is nothing to confirm.`;
  }
  return `Dok ${dokId} is not stale (${notStaleReason(drift.reason)}) — there is nothing to confirm.`;
}

function notStaleReason(reason: StaleReason | undefined): string {
  switch (reason) {
    case 'format-only': return 'its tracked sources changed in form only';
    case 'no-hash': return 'it has no logic hash to compare';
    case 'unverified-tracking': return 'its source tracking is unverified';
    default: return 'its tracked sources are unchanged';
  }
}

/**
 * The per-file hashes a confirmation stamps. `computeDriftConfirmation`
 * returns the drift set in order, duplicates kept. When the Dok records that
 * set as `logic_files`, each entry keeps every other field it carries and gets
 * its new `sha256`. A legacy Dok tracks its display `source_anchors`, which
 * never carry a hash, so the set is recorded as `logic_files` the way
 * generation records it — the same files, so the raw hash is unchanged.
 */
function stampLogicFiles(
  existing: readonly SourceAnchor[] | undefined,
  stamped: readonly SourceAnchor[],
): SourceAnchor[] {
  const aligned = existing !== undefined
    && existing.length === stamped.length
    && existing.every((entry, index) => entry.file === stamped[index]?.file);
  if (!aligned) return stamped.map((entry) => ({ ...entry }));
  return existing.map((entry, index) => {
    const next: SourceAnchor = { ...entry };
    const sha256 = stamped[index]?.sha256;
    if (sha256 === undefined) delete next.sha256;
    else next.sha256 = sha256;
    return next;
  });
}

/**
 * The Dok with a confirmation's three baseline facts written into `_meta` —
 * `logic_hash_normalized`, `logic_files[].sha256` and `source_commit`
 * (removed when the confirmation has none, never kept beside hashes it was
 * not taken with) — and nothing else changed. `logic_hash`, `status`,
 * `history`, `version`, `edited_by_human` and `pending_change` keep their
 * bytes: a confirmation is not a content change (design §4.6), and
 * `logic_hash` stays the release digest's evidence that the code changed.
 * Existing keys keep their place, so the file diff is the three facts.
 */
export function applyDriftConfirmation(dok: Dok, confirmation: DriftConfirmation): Dok {
  const meta = { ...(dok._meta ?? {}) } as DokMeta;
  meta.logic_hash_normalized = confirmation.logic_hash_normalized;
  meta.logic_files = stampLogicFiles(dok._meta?.logic_files, confirmation.logic_files);
  if (confirmation.source_commit === undefined) delete meta.source_commit;
  else meta.source_commit = confirmation.source_commit;
  return { ...dok, _meta: meta };
}

export function judgeVerdictView(record: JudgeCacheRecord): DokJudgeVerdict {
  return {
    model: record.model,
    summary: record.summary,
    checked: record.checked.map((item) => ({
      claimPath: item.claim_path,
      files: [...item.evidence_files],
      reason: item.reason,
    })),
  };
}

/** The judge's cached verdict for a Dok while it still holds, or null. Reads the cache only — no model. */
export async function readJudgeVerdict(
  root: string,
  dok: Dok,
  projectRoot: string,
): Promise<DokJudgeVerdict | null> {
  const { readCurrentJudgeVerdict } = await cliApi();
  const record = await readCurrentJudgeVerdict(root, dok, projectRoot);
  return record === null ? null : judgeVerdictView(record);
}

/**
 * Drop a confirmed Dok's cached verdict: a person has now confirmed what the
 * judge only proposed. Best effort — the Dok write already happened, and a
 * leftover record cannot make the Dok stale again — so a failure is reported,
 * not thrown.
 */
export async function removeConfirmedJudgeVerdict(root: string, dokId: string): Promise<boolean> {
  try {
    const { removeJudgeCache } = await cliApi();
    await removeJudgeCache(root, dokId);
    return true;
  } catch {
    return false;
  }
}

/** One Dok's drift view: staleness, the judge's verdict when it applies, and what blocks a confirmation. */
export async function viewDokDrift(input: {
  dok: Dok;
  revision: string;
  root: string;
  workspace: Workspace;
}): Promise<DokDriftView> {
  const projectRoot = dokProjectRoot(input.dok, input.workspace, input.root);
  const { drift } = await inspectDokDrift(input.dok, projectRoot);
  const verdict = drift.stale && drift.reason === 'changed'
    ? await readJudgeVerdict(input.root, input.dok, projectRoot)
    : null;
  return {
    dokId: input.dok.dok_id,
    revision: input.revision,
    drift,
    verdict,
    blocked: driftBlock(input.dok, drift),
  };
}
