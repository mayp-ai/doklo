// The CLI's single drift entry point.
//
// Drift is stamped in one place (`doklo generate`) and read in three (`doklo
// sync`, `doklo show`, the MCP server). The format-only layer (judge-gated sync
// design §4.2) works only if all four use the same normaliser: generate stamps
// `_meta.logic_hash_normalized` with it, and every reader recomputes it with it.
// A reader that called core's `isDokStale` without the normaliser would keep a
// comments-only edit stale while the others call it fresh — the split-reader
// failure drift hardening B4 recorded. So nothing else in the CLI imports
// core's `isDokStale` or `computeNormalizedLogicHash`; it imports this module
// (pinned by __tests__/drift-normalizer-contract.test.ts).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  computeNormalizedLogicHash,
  computeSourceFileSha256,
  isDokStale as isDokStaleWithOptions,
  readAnchorContentsSync,
  type Dok,
  type LogicHashInput,
  type SourceAnchor,
  type StaleResult,
} from '@doklo-beta/core';
import { tsTreeNormalizer } from '@doklo-beta/adapter-nextjs';

/** The one normaliser every CLI drift surface uses, for stamping and for verifying. */
export const DRIFT_NORMALIZER = tsTreeNormalizer;

/**
 * Whether one tracked file changed in form only between two of its texts —
 * comments, whitespace, line endings — judged by the same normaliser that
 * stamps and verifies `_meta.logic_hash_normalized`. The sync judge leaves
 * such a file out of the diff it sends (design §4.3). False when either text
 * cannot be normalised (another language, or a parse error): not sure means a
 * real change.
 */
export function isFormatOnlyFileChange(file: string, before: string, after: string): boolean {
  const a = DRIFT_NORMALIZER.normalizeForHash(file, before);
  const b = DRIFT_NORMALIZER.normalizeForHash(file, after);
  return a !== null && b !== null && a === b;
}

/**
 * Staleness of a Dok against its sources under `projectRoot`
 * (`dokProjectRoot`), with the format-only layer always on: a Dok whose
 * tracked sources changed only in comments, whitespace or line endings reads
 * `{ stale: false, reason: 'format-only' }`.
 */
export function isDokStale(dok: Dok, projectRoot: string): StaleResult {
  return isDokStaleWithOptions(dok, projectRoot, { normalize: DRIFT_NORMALIZER });
}

/** The two baseline facts stamped beside `_meta.logic_hash`. */
export interface DriftEvidence {
  /** `"<normaliser version>:<sha256>"` over the same contents as `logic_hash`. */
  logic_hash_normalized: string;
  /** The drift file set, in order and with duplicates, each read file carrying its `sha256`. */
  logic_files: SourceAnchor[];
}

/**
 * One read, two hashes: given the drift file set and the contents
 * `readAnchorContents` returned for it — the very input of `computeLogicHash` —
 * the normalised hash and the per-file content hashes. A file that could not
 * be read has no content, so its entry carries no `sha256`.
 */
export function computeDriftEvidence(
  files: readonly string[],
  contents: readonly LogicHashInput[],
): DriftEvidence {
  const sha256 = new Map(contents.map(({ file, content }) => [file, computeSourceFileSha256(content)]));
  return {
    logic_hash_normalized: computeNormalizedLogicHash(contents, DRIFT_NORMALIZER),
    logic_files: files.map((file) => {
      const hash = sha256.get(file);
      return hash === undefined ? { file } : { file, sha256: hash };
    }),
  };
}

const execFileAsync = promisify(execFile);
/** Same bound Studio uses for its git reads: a slow or hung git costs at most this. */
const SOURCE_COMMIT_TIMEOUT_MS = 2_000;
/** A full object id (SHA-1 or SHA-256 repositories). */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `_meta.source_commit`: the commit HEAD points at in the repository that holds
 * `projectRoot` — the Dok's project root, so a service kept in its own
 * repository gets its own commit. `undefined` when `projectRoot` is not in a
 * git repository, HEAD has no commit yet, or git fails or times out; the field
 * is then simply absent. Repository state, never a clock.
 */
export async function readSourceCommit(projectRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', projectRoot, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      { timeout: SOURCE_COMMIT_TIMEOUT_MS, windowsHide: true },
    );
    const commit = stdout.trim();
    return COMMIT_ID.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The drift baseline a person's "still accurate" confirmation re-stamps
 * (judge-gated sync design §4.6): the normalised hash, the per-file hashes and
 * the commit, recomputed from the Dok's tracked files as they are now — the
 * same read, the same hash functions and the same normaliser as generation and
 * staleness. Never `logic_hash`: it stays the release digest's evidence that
 * the code changed, so a confirmed change is never published as an update.
 */
export interface DriftConfirmation {
  logic_hash_normalized: string;
  /** The drift file set, in order and with duplicates, each entry carrying its `sha256`. */
  logic_files: SourceAnchor[];
  /** HEAD of the Dok's project root; absent outside git or when git cannot say. */
  source_commit?: string;
}

/**
 * Compute the baseline facts a "still accurate" confirmation writes into
 * `_meta` (the caller writes them; nothing here touches the Dok). They replace
 * the stored three — as generation stamps them, a missing `source_commit`
 * means the stored one is removed, never kept beside hashes it was not taken
 * with. Written, they make the CLI's staleness read the Dok as fresh until its
 * tracked sources change again (reason `format-only`: the normalised hash now
 * matches while `logic_hash` still differs), and they move the judge's next
 * diff base to now.
 *
 * Null when the Dok tracks no file (nothing to confirm) or when any tracked
 * file cannot be read: confirming would bless a source nobody read.
 */
export async function computeDriftConfirmation(
  dok: Dok,
  projectRoot: string,
): Promise<DriftConfirmation | null> {
  const files = (dok._meta?.logic_files ?? dok._meta?.source_anchors ?? []).map((anchor) => anchor.file);
  if (files.length === 0) return null;
  const read = readAnchorContentsSync(files, projectRoot);
  if (read.missing.length > 0) return null;
  const evidence = computeDriftEvidence(files, read.contents);
  const commit = await readSourceCommit(projectRoot);
  return { ...evidence, ...(commit === undefined ? {} : { source_commit: commit }) };
}
