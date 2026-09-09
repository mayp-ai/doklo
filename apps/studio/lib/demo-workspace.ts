// Demo-workspace detection.
//
// Studio ships a sample workspace (apps/studio/demo) so the UI can be
// developed and demonstrated without running a real analysis. That data is
// hand-written, not produced from anyone's code, so it must never be
// presented the way a user's own Hub is. The signal travels with the data —
// a marker file inside the workspace — rather than with an environment flag,
// so pointing Studio at the sample workspace by any route still labels it.
//
// Three outcomes, not two. "Marker unreadable" is not evidence of a demo:
// stamping "this is bundled sample data" across a user's real Hub is the
// same lie pointed the other way. Unprovable is its own answer.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { workspaceRoot } from './data';

/** Marker filename, relative to `<workspace>/.doklo/`. */
export const DEMO_MARKER_FILE = 'DEMO_WORKSPACE';

export type DemoWorkspaceStatus =
  /** The marker is present: bundled sample data. */
  | 'demo'
  /** The marker is provably absent: the user's own workspace. */
  | 'own'
  /** The marker could be neither read nor ruled out. */
  | 'unverified';

export interface DemoWorkspaceState {
  status: DemoWorkspaceStatus;
  /** Absolute path the marker was looked for at. Shown to the user when the
   *  status is `unverified`, so the unreadable path is nameable. */
  markerPath: string;
  /** errno code behind an `unverified` result (e.g. EACCES), else null. */
  reason: string | null;
}

export function demoMarkerPath(root: string = workspaceRoot()): string {
  return join(resolve(root), '.doklo', DEMO_MARKER_FILE);
}

/** ENOENT/ENOTDIR prove the marker is absent. Every other failure leaves the
 *  question open. */
function provesAbsence(code: string | null): boolean {
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errnoCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

export async function loadDemoWorkspaceState(
  root: string = workspaceRoot(),
): Promise<DemoWorkspaceState> {
  const markerPath = demoMarkerPath(root);
  try {
    await readFile(markerPath, 'utf-8');
    return { status: 'demo', markerPath, reason: null };
  } catch (error) {
    const code = errnoCode(error);
    return provesAbsence(code)
      ? { status: 'own', markerPath, reason: null }
      : { status: 'unverified', markerPath, reason: code ?? 'unknown' };
  }
}
