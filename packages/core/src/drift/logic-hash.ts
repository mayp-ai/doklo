import { createHash } from 'node:crypto';

/** A source file a Dok is derived from: repo-relative path + its current text. */
export interface LogicHashInput {
  file: string;
  content: string;
}

/**
 * Deterministic content hash of the source files a Dok is derived from — stored
 * as `_meta.logic_hash`. Drift detection (next cycle) recomputes this from the
 * code on disk and compares: a mismatch means the Dok drifted from its sources
 * and is stale.
 *
 * - Order-independent: inputs are sorted by path, so reordering `source_anchors`
 *   never changes the hash.
 * - Path-sensitive: the path is folded into the digest, so a rename (same
 *   content, new location) still registers as a change.
 * - Separator-safe: a NUL byte delimits path from content and entry from entry,
 *   so ("ab","c") and ("a","bc") can't collide.
 * - Empty input → '': with no anchors there is nothing to track, and the caller
 *   omits `logic_hash` entirely.
 *
 * File-level hashing is the MVP; symbol/line-level precision is M3.
 */
export function computeLogicHash(inputs: LogicHashInput[]): string {
  if (inputs.length === 0) return '';
  const sorted = [...inputs].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  const h = createHash('sha256');
  for (const { file, content } of sorted) {
    h.update(file);
    h.update('\0');
    h.update(content);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * The format-only layer's normaliser (judge-gated sync design §4.2), injected
 * by the caller: core never parses source, so it stays dependency-free. The
 * same instance must stamp `_meta.logic_hash_normalized` at generation and
 * recompute it at verification — compute ≡ verify, as for `logic_hash`.
 */
export interface LogicHashNormalizer {
  /**
   * Algorithm + parser version, e.g. `ts-tree-v1+ts5.4.2`. It prefixes the
   * stored hash, and a stored hash with any other version is never compared:
   * a canonical form is only stable within one normaliser version.
   */
  readonly version: string;
  /**
   * Canonical text of one file — comments, whitespace and line-ending kinds
   * dropped — or `null` when the file is not normalisable (another language,
   * or a parse error). A `null` file is hashed by its raw content, so any edit
   * to it stays a real change. Must be pure; a throw is treated as `null`.
   */
  normalizeForHash(file: string, content: string): string | null;
}

/**
 * `_meta.logic_hash_normalized` — `"<normaliser version>:<sha256>"` over the
 * same inputs `computeLogicHash` hashes, each file reduced to its canonical
 * form. Same shape as `computeLogicHash` (sorted by path, NUL-delimited,
 * duplicates preserved) — and as the benchmark harness that measured it — plus
 * a per-entry tag, `N` (canonical form) or `R` (raw content), so a raw file can
 * never collide with a canonical one. Empty input → '' (nothing to track).
 *
 * Equal normalised hashes with different raw hashes mean the sources changed
 * in form only. This never replaces `logic_hash`, which stays the evidence the
 * release digest and publication fingerprints read.
 */
export function computeNormalizedLogicHash(
  inputs: readonly LogicHashInput[],
  normalizer: LogicHashNormalizer,
): string {
  if (inputs.length === 0) return '';
  const sorted = [...inputs].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  const h = createHash('sha256');
  for (const { file, content } of sorted) {
    let canonical: string | null;
    try {
      canonical = normalizer.normalizeForHash(file, content);
    } catch {
      canonical = null; // Not sure → raw, so the file can only read as changed.
    }
    h.update(file);
    h.update('\0');
    h.update(canonical === null ? 'R' : 'N');
    h.update('\0');
    h.update(canonical ?? content);
    h.update('\0');
  }
  return `${normalizer.version}:${h.digest('hex')}`;
}

/** Whether a stored `logic_hash_normalized` was stamped by this normaliser version. */
export function normalizedHashMatchesVersion(
  stored: string,
  normalizer: LogicHashNormalizer,
): boolean {
  return stored.startsWith(`${normalizer.version}:`);
}

/**
 * `_meta.logic_files[].sha256` — the sha256 hex of one file's decoded text
 * exactly as the drift read returns it (`readAnchorContentsSync`: strict UTF-8,
 * so a leading BOM is not part of it), re-encoded as UTF-8. It names which
 * tracked file changed and lets a later diff confirm its base: hash a base
 * revision's bytes through the same decode before comparing.
 */
export function computeSourceFileSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
