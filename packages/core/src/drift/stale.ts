import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveContainedPathSync } from '../fs/path-containment.js';
import { computeLogicHash, type LogicHashInput } from './logic-hash.js';
import type { Dok } from '../schemas/dok.js';
import type { Workspace } from '../schemas/workspace.js';

/**
 * Outcome of reading a Dok's source anchors off disk.
 * `missing` lists anchors whose file could not be read — the signal that lets
 * us distinguish a *deleted* source from one that was merely *edited*.
 */
export interface AnchorRead {
  contents: LogicHashInput[];
  missing: string[];
}

/**
 * Read anchor files synchronously — the single definition of what a drift hash
 * is computed over.
 *
 * Both sides of drift detection run through this one function: generate (via
 * the async `readAnchorContents` facade below) and verify (`isDokStale`, and
 * the MCP server, which is synchronous — hence `readFileSync`). Keeping the
 * rule physically singular is the point: when it lived in two places they
 * silently diverged, one side gained path containment and the other did not,
 * and every anchor that escaped the project root produced a structural false
 * stale — generate excluded it from the hash while verify included it.
 *
 * The rule, per file: resolve the path under `projectRoot` refusing any escape
 * (`resolveContainedPathSync` — the same containment the async resolver applies,
 * kept beside it so the two cannot drift apart), then read it. Anything that
 * fails either step is excluded from the hash input and recorded in `missing` —
 * its absence shifts the hash, which is itself the drift signal, and the record
 * lets the caller attribute the drift to a file it could not read.
 *
 * Duplicate entries are preserved as-is: de-duplication would change the hash
 * for any Dok whose file set repeats a path, so it is tracked separately.
 */
export function readAnchorContentsSync(
  files: string[],
  projectRoot: string,
): AnchorRead {
  const contents: LogicHashInput[] = [];
  const missing: string[] = [];
  for (const file of files) {
    try {
      const absolute = resolveContainedPathSync(projectRoot, file);
      contents.push({ file, content: readFileSync(absolute, 'utf-8') });
    } catch {
      missing.push(file);
    }
  }
  return { contents, missing };
}

/**
 * Async facade over {@link readAnchorContentsSync}, for callers on an async path
 * (generate). It deliberately adds no logic of its own: the sync form is the
 * constrained one — MCP consumes drift synchronously — so making it the single
 * implementation is what guarantees compute and verify cannot drift apart. The
 * cost is blocking reads during generate, which is negligible next to the LLM
 * calls that surround them.
 */
export async function readAnchorContents(
  files: string[],
  projectRoot: string,
): Promise<AnchorRead> {
  return readAnchorContentsSync(files, projectRoot);
}

/**
 * Resolve the directory a Dok's anchor paths are relative to.
 *
 * At generate time anchors were hashed relative to the owning service's
 * `code_root` (via `join(workspaceRoot, code_root)`), and each
 * `source_anchors[].file` is stored code_root-relative. Drift detection must
 * resolve against the *same* base, or the recomputed hash can never line up
 * with the stored one.
 *
 * Which service? Deterministic first: `_meta.anchor_service_id`, the service
 * generate stamped as the anchor base. `surfaces[0]` is only a legacy fallback
 * (Doks generated before anchor_service_id) — it is LLM-authored, so relying on
 * it risks resolving anchors against the wrong service. code_root fallbacks
 * (single-service workspace, then workspace root `code_root` ".") stay as the
 * last resort when neither yields a matching service.
 */
export function dokProjectRoot(
  dok: Dok,
  workspace: Workspace,
  workspaceRoot: string,
): string {
  const svcId = dok._meta?.anchor_service_id ?? dok.surfaces?.[0];
  const svc =
    (svcId
      ? workspace.services.find((s) => s.service_id === svcId)
      : undefined) ??
    (workspace.services.length === 1 ? workspace.services[0] : undefined);
  return join(workspaceRoot, svc?.code_root ?? '.');
}

/** Why a Dok is stale — or why staleness could not be decided (`no-hash` or `unverified-tracking`). */
export type StaleReason = 'changed' | 'missing-file' | 'tracking-expanded' | 'no-hash' | 'unverified-tracking';

export interface StaleResult {
  stale: boolean;
  reason?: StaleReason;
}

/**
 * Decide whether a Dok has drifted from the code it was generated from, by
 * comparing its stored `_meta.logic_hash` against a hash recomputed from the
 * anchor files on disk right now.
 *
 * No stored hash → `no-hash`: there is nothing to compare against, so drift is
 * *undecidable*, which is reported as NOT stale. We never flag a Dok as drifted
 * on absent evidence. Missing/unsupported tracking versions are also undecidable:
 * their source graph may have omitted dependencies. A recovered graph marked
 * `tracking_review_required` is stale even when its old hash happens to match.
 *
 * The file set re-hashed is `_meta.logic_files` — the exact set generate hashed,
 * the full reachable closure incl. shared infra — so a change to a shared
 * dependency is caught even though it is not a display `source_anchor`. Trusted
 * Doks without `logic_files` fall back to `source_anchors` (their hash was
 * computed over that set, so compute still equals verify).
 *
 * When the hashes differ we attribute the cause: any anchor file that couldn't
 * be read → `missing-file` (a source was deleted/moved); otherwise → `changed`
 * (a source's contents were edited in place).
 */
export function isDokStale(dok: Dok, projectRoot: string): StaleResult {
  const stored = dok._meta?.logic_hash;
  if (!stored) return { stale: false, reason: 'no-hash' };
  if (dok._meta?.tracking_review_required === true) {
    return { stale: true, reason: 'tracking-expanded' };
  }
  if (dok._meta?.tracking_version !== 2) {
    return { stale: false, reason: 'unverified-tracking' };
  }

  const files = (dok._meta?.logic_files ?? dok._meta?.source_anchors ?? []).map((a) => a.file);
  const { contents, missing } = readAnchorContentsSync(files, projectRoot);

  // Reuse the exact hash the generator stored — compute must equal verify, or a
  // legitimately-unchanged Dok could never match.
  if (computeLogicHash(contents) === stored) return { stale: false };
  return { stale: true, reason: missing.length > 0 ? 'missing-file' : 'changed' };
}
