// Freshness signal for a Dok, surfaced to agents as `is_stale`.
//
// Staleness is a trust signal: an agent needs to know whether a Dok still
// reflects the code it was derived from. The real judgement lives in the drift
// module of @doklo-beta/core: `isDokStale` re-hashes the Dok's on-disk source
// anchors and compares that against the stored `_meta.logic_hash`.
//
// This wrapper adapts that core result into the tri-state the MCP tools expose:
//   - undecidable (Dok has no stored hash or verified tracking) → 'unknown', an honest "we can't say"
//   - otherwise → the boolean drift verdict.
// It resolves the workspace synchronously because the MCP server invokes the
// tools on a synchronous path.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  derivePriorityTier,
  dokProjectRoot,
  isDokStale,
  type Dok,
  type PriorityTier,
  type Workspace,
} from '@doklo-beta/core';

/**
 * Tri-state drift verdict, surfaced to agents as `is_stale`.
 *
 * Freshness concerns tracked source evidence, never document correctness:
 *   - `true`      — the tracked source files changed after the Dok was
 *                   generated, or recovered tracking needs review. Treat the Dok as possibly outdated and prefer
 *                   the current code; `doklo sync` regenerates it.
 *   - `false`     — those sources are byte-identical to what the Dok was
 *                   generated from. This is *not* a claim that the Dok is
 *                   correct: a Dok that was wrong when written stays `false`
 *                   for as long as the code sits still.
 *   - `'unknown'` — no drift hash was recorded (or the workspace could not be
 *                   read, or source tracking is unverified), so the check could not decide either way.
 */
export type Staleness = boolean | 'unknown';

/**
 * The Dok's priority tier, for an agent deciding how much to distrust a stale
 * Dok. `is_stale` reports whether the anchored bytes moved; this reports what
 * it costs to be wrong. Unjudged derives to `standard` — never quiet.
 */
export function resolveDokTier(dok: Dok): PriorityTier {
  return derivePriorityTier(dok.priority);
}

export function resolveDokStaleness(dok: Dok, workspaceRoot: string): Staleness {
  const workspace = readWorkspaceSync(workspaceRoot);
  // No readable/parseable workspace → we can't resolve anchor roots, so drift
  // is undecidable. Graceful: the MCP server starts fine without a workspace.
  if (!workspace) return 'unknown';

  const projectRoot = dokProjectRoot(dok, workspace, workspaceRoot);
  const r = isDokStale(dok, projectRoot);
  // Missing hashes and unverified dependency tracking are undecidable.
  return r.reason === 'no-hash' || r.reason === 'unverified-tracking' ? 'unknown' : r.stale;
}

/**
 * Read + parse workspace.json synchronously, mirroring core's hub loader
 * candidate order: `.doklo/hub/workspace.json` first, then `<root>/workspace.json`.
 * The first candidate that reads is the one we commit to.
 *
 * A plain `JSON.parse` + cast (no zod) is deliberate: on this call path the
 * server has just run `loadHubModel`, which already zod-validated this same
 * file. Re-validating here would only pay that cost N extra times per tool call.
 *
 * Returns null on any read/parse failure — the caller degrades that to
 * 'unknown'. Per-call reads are the intended MVP (the server reloads the whole
 * Hub on every tool call too), so there is deliberately no caching here.
 */
function readWorkspaceSync(workspaceRoot: string): Workspace | null {
  const candidates = [
    join(workspaceRoot, '.doklo', 'hub', 'workspace.json'),
    join(workspaceRoot, 'workspace.json'),
  ];
  for (const path of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue; // not at this location — try the next candidate
    }
    try {
      return JSON.parse(raw) as Workspace;
    } catch {
      return null; // found the file but it's malformed → undecidable
    }
  }
  return null;
}
