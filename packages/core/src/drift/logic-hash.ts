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
