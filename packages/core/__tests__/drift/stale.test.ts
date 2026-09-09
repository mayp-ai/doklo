import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLogicHash } from '../../src/drift/logic-hash.js';
import { isDokStale, dokProjectRoot } from '../../src/drift/stale.js';
import { DokMetaSchema, type Dok } from '../../src/schemas/dok.js';
import type { Workspace } from '../../src/schemas/workspace.js';

// Build a Dok fixture without going through schema parsing — drift logic only
// touches `surfaces` and `_meta`, so a cast keeps the fixtures minimal.
// `logic_hash` is omitted when not provided (drives the no-hash case).
function makeDok(opts: {
  logic_hash?: string;
  anchors?: { file: string }[];
  logic_files?: { file: string }[];
  surfaces?: string[];
  anchor_service_id?: string;
}): Dok {
  const _meta: Record<string, unknown> = { version: 1, history: [], tracking_version: 2 };
  if (opts.logic_hash !== undefined) _meta.logic_hash = opts.logic_hash;
  if (opts.anchors !== undefined) _meta.source_anchors = opts.anchors;
  if (opts.logic_files !== undefined) _meta.logic_files = opts.logic_files;
  if (opts.anchor_service_id !== undefined)
    _meta.anchor_service_id = opts.anchor_service_id;
  return {
    dok_id: 'X-001',
    name: 'x',
    description: 'x',
    status: 'active',
    tags: [],
    surfaces: opts.surfaces ?? ['web'],
    _meta,
  } as unknown as Dok;
}

function makeWorkspace(services: { service_id: string; code_root: string }[]): Workspace {
  return {
    workspace_id: 'w',
    name: 'w',
    services: services.map((s) => ({
      service_id: s.service_id,
      type: 'frontend',
      framework: 'nextjs',
      code_root: s.code_root,
    })),
    default_locale: 'en',
    supported_locales: ['en'],
  } as unknown as Workspace;
}

describe('isDokStale', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doklo-stale-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([undefined, 1, 3])('does not trust tracking version %s even when its hash matches', (version) => {
    writeFileSync(join(root, 'a.ts'), 'X');
    const dok = makeDok({ logic_hash: computeLogicHash([{ file: 'a.ts', content: 'X' }]), anchors: [{ file: 'a.ts' }] });
    dok._meta.tracking_version = version;
    expect(isDokStale(dok, root)).toEqual({ stale: false, reason: 'unverified-tracking' });
  });

  it('requires review after tracking expands even when the stored hash matches', () => {
    writeFileSync(join(root, 'a.ts'), 'X');
    const dok = makeDok({ logic_hash: computeLogicHash([{ file: 'a.ts', content: 'X' }]), anchors: [{ file: 'a.ts' }] });
    delete dok._meta.tracking_version;
    dok._meta.tracking_review_required = true;
    expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'tracking-expanded' });
  });

  it('keeps a hashless tracking repair undecidable', () => {
    const dok = makeDok({});
    dok._meta.tracking_review_required = true;
    expect(isDokStale(dok, root)).toEqual({ stale: false, reason: 'no-hash' });
  });

  it.each([0, -1, 1.5, '2'])('rejects invalid tracking version %s', (version) => {
    expect(DokMetaSchema.safeParse({ tracking_version: version }).success).toBe(false);
  });

  it('rejects non-boolean tracking review flags', () => {
    expect(DokMetaSchema.safeParse({ tracking_review_required: 'true' }).success).toBe(false);
  });

  it('reports changed when an anchor file content is edited after the hash was stored', () => {
    writeFileSync(join(root, 'a.ts'), 'X');
    const h = computeLogicHash([{ file: 'a.ts', content: 'X' }]);
    const dok = makeDok({ logic_hash: h, anchors: [{ file: 'a.ts' }] });

    writeFileSync(join(root, 'a.ts'), 'Y'); // in-place edit → drift

    expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'changed' });
  });

  it('reports not stale when the anchor file is unchanged', () => {
    writeFileSync(join(root, 'a.ts'), 'X');
    const h = computeLogicHash([{ file: 'a.ts', content: 'X' }]);
    const dok = makeDok({ logic_hash: h, anchors: [{ file: 'a.ts' }] });

    expect(isDokStale(dok, root)).toEqual({ stale: false });
  });

  it('reports missing-file when an anchor file has been deleted', () => {
    writeFileSync(join(root, 'a.ts'), 'X');
    const h = computeLogicHash([{ file: 'a.ts', content: 'X' }]);
    const dok = makeDok({ logic_hash: h, anchors: [{ file: 'a.ts' }] });

    rmSync(join(root, 'a.ts')); // deleted source → drift attributed to absence

    expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'missing-file' });
  });

  it('reports no-hash (undecidable, not stale) when the Dok has no stored logic_hash', () => {
    const dok = makeDok({ anchors: [{ file: 'a.ts' }] }); // logic_hash omitted

    expect(isDokStale(dok, root)).toEqual({ stale: false, reason: 'no-hash' });
  });

  it('re-hashes logic_files (shared infra) so a change outside source_anchors is caught (B1)', () => {
    // The display anchor is only the page; the shared util it depends on lives in
    // logic_files. The stored hash was computed over BOTH files.
    writeFileSync(join(root, 'page.tsx'), 'PAGE');
    writeFileSync(join(root, 'shared.ts'), 'V1');
    const h = computeLogicHash([
      { file: 'page.tsx', content: 'PAGE' },
      { file: 'shared.ts', content: 'V1' },
    ]);
    const dok = makeDok({
      logic_hash: h,
      anchors: [{ file: 'page.tsx' }], // display set: page only
      logic_files: [{ file: 'page.tsx' }, { file: 'shared.ts' }], // drift set incl. shared
    });

    // Unchanged on disk → fresh. This only holds if verify re-hashes the same
    // logic_files set generate hashed; re-hashing source_anchors alone would
    // mismatch the stored two-file hash and false-stale it.
    expect(isDokStale(dok, root)).toEqual({ stale: false });

    // Editing the shared util — which is NOT a source_anchor — must register as
    // drift. Re-hashing source_anchors alone would miss it (the B1 false-fresh).
    writeFileSync(join(root, 'shared.ts'), 'V2');
    expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'changed' });
  });

  it('falls back to source_anchors when a trusted Dok has no logic_files', () => {
    writeFileSync(join(root, 'a.ts'), 'X');
    const h = computeLogicHash([{ file: 'a.ts', content: 'X' }]);
    const dok = makeDok({ logic_hash: h, anchors: [{ file: 'a.ts' }] }); // no logic_files

    // Unchanged → fresh via the source_anchors fallback (zero regression).
    expect(isDokStale(dok, root)).toEqual({ stale: false });

    // An edit to the anchor is still caught through the same fallback path.
    writeFileSync(join(root, 'a.ts'), 'Y');
    expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'changed' });
  });

  it('anchor_service_id keeps a multi-service Dok fresh where surfaces[0] would false-stale it (B2)', () => {
    // The end-to-end payoff of B2: two services, and the anchor exists ONLY under
    // the web service. The Dok's surfaces is LLM-authored and points at 'api'
    // (the wrong service); anchor_service_id was stamped deterministically at
    // generate time as 'web'.
    const content = 'export const x = 1;';
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    writeFileSync(join(root, 'apps/web/x.ts'), content);
    mkdirSync(join(root, 'apps/api'), { recursive: true }); // api has NO x.ts

    const ws = makeWorkspace([
      { service_id: 'web', code_root: 'apps/web' },
      { service_id: 'api', code_root: 'apps/api' },
    ]);
    const h = computeLogicHash([{ file: 'x.ts', content }]);
    const dok = makeDok({
      logic_hash: h,
      anchors: [{ file: 'x.ts' }],
      surfaces: ['api'], // polluted / LLM-authored → points at the wrong service
      anchor_service_id: 'web', // deterministic truth stamped by generate
    });

    // Resolves against apps/web → apps/web/x.ts found & unchanged → fresh.
    expect(isDokStale(dok, dokProjectRoot(dok, ws, root))).toEqual({ stale: false });

    // Contrast: without anchor_service_id, surfaces('api') resolves to apps/api,
    // where x.ts is absent → a false `missing-file` stale. That is exactly the B2
    // bug this field fixes.
    const legacy = makeDok({
      logic_hash: h,
      anchors: [{ file: 'x.ts' }],
      surfaces: ['api'],
    });
    expect(isDokStale(legacy, dokProjectRoot(legacy, ws, root))).toEqual({
      stale: true,
      reason: 'missing-file',
    });
  });
});

describe('dokProjectRoot', () => {
  const workspaceRoot = '/root';

  it('resolves against anchor_service_id deterministically, ignoring a polluted surfaces[0] (B2)', () => {
    // surfaces is LLM-authored output; anchor_service_id is stamped
    // deterministically at generate time. When they disagree the deterministic
    // one MUST win, or a hallucinated surface silently resolves anchor paths
    // against the wrong service.
    const dok = makeDok({ anchors: [], surfaces: ['api'], anchor_service_id: 'web' });
    const ws = makeWorkspace([
      { service_id: 'web', code_root: 'apps/web' },
      { service_id: 'api', code_root: 'apps/api' },
    ]);

    // Had we trusted surfaces[0]='api' this would be apps/api; anchor_service_id wins.
    expect(dokProjectRoot(dok, ws, workspaceRoot).endsWith('apps/web')).toBe(true);
  });

  it('falls back to surfaces[0] when anchor_service_id is absent (legacy Doks)', () => {
    // Doks generated before anchor_service_id existed carry only surfaces — the
    // pre-existing resolution must be preserved for them (zero regression).
    const dok = makeDok({ anchors: [], surfaces: ['api'] });
    const ws = makeWorkspace([
      { service_id: 'web', code_root: 'apps/web' },
      { service_id: 'api', code_root: 'apps/api' },
    ]);

    expect(dokProjectRoot(dok, ws, workspaceRoot).endsWith('apps/api')).toBe(true);
  });

  it('resolves against the code_root of the service matching the first surface', () => {
    const dok = makeDok({ anchors: [], surfaces: ['web'] });
    const ws = makeWorkspace([{ service_id: 'web', code_root: 'apps/web' }]);

    expect(dokProjectRoot(dok, ws, workspaceRoot).endsWith('apps/web')).toBe(true);
  });

  it('falls back to the sole service when the Dok has no surface', () => {
    const dok = makeDok({ anchors: [], surfaces: [] });
    const ws = makeWorkspace([{ service_id: 'only', code_root: 'pkg' }]);

    expect(dokProjectRoot(dok, ws, workspaceRoot).endsWith('pkg')).toBe(true);
  });

  it('falls back to the workspace root when a surface matches no service (multi-service)', () => {
    const dok = makeDok({ anchors: [], surfaces: ['nomatch'] });
    const ws = makeWorkspace([
      { service_id: 'web', code_root: 'apps/web' },
      { service_id: 'api', code_root: 'apps/api' },
    ]);

    // No match + more than one service → workspace root (code_root ".").
    expect(dokProjectRoot(dok, ws, workspaceRoot)).toBe(join(workspaceRoot, '.'));
  });
});
