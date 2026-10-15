// "Still accurate" (judge-gated sync design §4.6, §4.7): the Studio actions
// that read a Dok's drift and re-stamp its drift baseline. Temp workspaces
// with real source files; git only as the drift read itself uses it (the
// source inventory). `source_commit` needs a repository, so the "with commit"
// case stubs it as a fixture on top of the real computation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeLogicHash, readAnchorContentsSync, type Dok } from '@doklo-beta/core';
import type { DriftConfirmation } from '@doklo-beta/cli/api';
// The CLI's drift entry point and judge cache, straight from its build: the
// readers Studio has to agree with, and the writer of a real cached verdict.
import {
  computeDriftConfirmation as cliComputeDriftConfirmation,
  isDokStale as cliIsDokStale,
} from '../../cli/dist/lib/drift.js';
import {
  currentJudgeCacheFacts,
  judgeCacheFile,
  writeJudgeCache,
} from '../../cli/dist/lib/judge/cache.js';
import { revisionOf } from '../lib/load-state';
import {
  bulkConfirmDoksStillAccurateAction,
  confirmDokStillAccurateAction,
  readDokDriftAction,
  readDoksDriftAction,
} from '../lib/actions';

const harness = vi.hoisted(() => ({
  /** Rewrites what computeDriftConfirmation returns (null: pass the real result through). */
  confirmation: null as null | ((real: DriftConfirmation | null) => DriftConfirmation | null),
  atomicFaultPathPart: null as string | null,
}));

vi.mock('@doklo-beta/cli/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/cli/api')>();
  return {
    ...actual,
    computeDriftConfirmation: async (
      ...args: Parameters<typeof actual.computeDriftConfirmation>
    ) => {
      const real = await actual.computeDriftConfirmation(...args);
      return harness.confirmation ? harness.confirmation(real) : real;
    },
  };
});

vi.mock('@doklo-beta/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/core')>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (
        harness.atomicFaultPathPart !== null &&
        String(args[0]).includes(harness.atomicFaultPathPart)
      ) {
        throw Object.assign(new Error('permission denied by deterministic test fault'), {
          code: 'EACCES',
        });
      }
      return actual.writeFileAtomic(...args);
    },
  };
});

const ROWS_SOURCE =
  "export const limit = 10;\nexport function rows() { return 'https://example.com//x'; }\n";
const PAGE_SOURCE = 'export const pageSize = 20;\nexport const label = "Page";\n';
/** A commit the stored Dok claims — this workspace has no repository. */
const STORED_COMMIT = 'f'.repeat(40);
const FIXTURE_COMMIT = 'c'.repeat(40);
/** The three facts a confirmation may write — everything else must keep its bytes. */
const DRIFT_FACTS = ['logic_hash_normalized', 'logic_files', 'source_commit'] as const;

const originalRoot = process.env.DOKLO_WORKSPACE_ROOT;
const scratchRoots: string[] = [];

afterEach(async () => {
  harness.confirmation = null;
  harness.atomicFaultPathPart = null;
  if (originalRoot === undefined) delete process.env.DOKLO_WORKSPACE_ROOT;
  else process.env.DOKLO_WORKSPACE_ROOT = originalRoot;
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type JsonRecord = Record<string, any>;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function dokPath(root: string, dokId: string): string {
  return join(root, '.doklo', 'hub', 'doks', `${dokId}.json`);
}

/** A Dok stamped exactly as generation stamps it, then reviewed and approved. */
async function stampedDok(root: string, dokId: string, files: string[]): Promise<JsonRecord> {
  const read = readAnchorContentsSync(files, root);
  const evidence = await cliComputeDriftConfirmation(
    { dok_id: dokId, _meta: { logic_files: files.map((file) => ({ file })) } } as unknown as Dok,
    root,
  );
  if (evidence === null) throw new Error(`fixture: cannot stamp ${dokId}`);
  return {
    dok_id: dokId,
    name: `${dokId} name`,
    status: 'active',
    tags: [],
    surfaces: ['web'],
    description: 'Lists rows a page at a time for the dashboard.',
    user_actions: {
      steps: [{
        order: 1,
        actor: { kind: 'system' },
        intent: 'List rows',
        outcome: 'Rows listed',
        variants: [{ platform: 'all', interaction: 'auto' }],
      }],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
    server_extension: { retained: true },
    _meta: {
      version: 3,
      history: [{
        version: 3,
        date: '2026-10-01',
        change: 'Status changed to active',
        kind: 'status',
        from: 'review',
        to: 'active',
        author: 'reviewer',
      }],
      tracking_version: 2,
      anchor_service_id: 'web',
      source_anchors: files.map((file) => ({ file })),
      logic_hash: computeLogicHash(read.contents),
      logic_hash_normalized: evidence.logic_hash_normalized,
      logic_files: evidence.logic_files,
      source_commit: STORED_COMMIT,
      edited_by_human: true,
      pending_change: {
        summary: 'Rows now load ten at a time.',
        source: 'diff',
        base_version: 2,
        previous_status: 'active',
      },
      server_meta_extension: { retained: true },
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, 'utf-8')) as JsonRecord;
}

async function bytesAndRevision(path: string): Promise<{ bytes: string; revision: string }> {
  const bytes = await readFile(path, 'utf-8');
  return { bytes, revision: revisionOf(bytes) };
}

/** Two approved Doks over their own source files: ROWS (src/rows.ts) and PAGE (src/page.ts). */
async function driftWorkspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doklo-studio-drift-')));
  scratchRoots.push(root);
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeJson(join(root, 'workspace.json'), {
    workspace_id: 'drift-demo',
    name: 'Drift demo',
    services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
    default_locale: 'en',
    supported_locales: ['en'],
  });
  await writeFile(join(root, 'src/rows.ts'), ROWS_SOURCE, 'utf-8');
  await writeFile(join(root, 'src/page.ts'), PAGE_SOURCE, 'utf-8');
  await writeJson(dokPath(root, 'ROWS'), await stampedDok(root, 'ROWS', ['src/rows.ts']));
  await writeJson(dokPath(root, 'PAGE'), await stampedDok(root, 'PAGE', ['src/page.ts']));
  process.env.DOKLO_WORKSPACE_ROOT = root;
  return root;
}

async function editMeta(root: string, dokId: string, edit: (meta: JsonRecord) => void): Promise<void> {
  const dok = await readJson(dokPath(root, dokId));
  edit(dok._meta);
  await writeJson(dokPath(root, dokId), dok);
}

async function changeRowsCode(root: string, content = ROWS_SOURCE.replace('10;', '5;')): Promise<string> {
  await writeFile(join(root, 'src/rows.ts'), content, 'utf-8');
  return content;
}

function withoutDriftFacts(dok: JsonRecord): JsonRecord {
  const meta = { ...dok._meta };
  for (const key of DRIFT_FACTS) delete meta[key];
  return { ...dok, _meta: meta };
}

/** A cached `accurate` verdict that holds for the Dok's code, base and text as they are now. */
async function cacheAccurateVerdict(root: string, dokId: string): Promise<void> {
  const dok = await readJson(dokPath(root, dokId)) as Dok;
  const facts = currentJudgeCacheFacts(dok, root);
  if (facts === null) throw new Error('fixture: no cache facts');
  await writeJudgeCache(root, {
    schema_version: 1,
    dok_id: dokId,
    logic_hash: facts.logicHash,
    source_commit: facts.sourceCommit,
    dok_sha256: facts.dokSha256,
    verdict: 'accurate',
    errors: [],
    omissions: [],
    checked: [{
      claim_path: 'user_actions.steps[0].intent',
      evidence_files: ['src/rows.ts'],
      reason: 'Rows are still listed; only the page size changed.',
    }],
    summary: 'The Dok never states a page size, so it still holds.',
    model: 'anthropic/claude-sonnet-5',
    prompt_digest: 'a'.repeat(64),
    request_digest: 'b'.repeat(64),
  });
}

async function cliStaleness(root: string, dokId: string) {
  return cliIsDokStale(await readJson(dokPath(root, dokId)) as Dok, root);
}

async function studioStaleness(dokId: string) {
  const result = await readDokDriftAction({ dokId });
  if (!result.ok) throw new Error(result.error);
  return result.drift;
}

describe('readDokDriftAction', () => {
  it('reads unchanged sources as fresh, with no verdict and nothing blocking', async () => {
    const root = await driftWorkspace();
    const { revision } = await bytesAndRevision(dokPath(root, 'ROWS'));

    await expect(readDokDriftAction({ dokId: 'ROWS' })).resolves.toEqual({
      ok: true,
      dokId: 'ROWS',
      revision,
      drift: { stale: false },
      verdict: null,
      blocked: null,
    });
  });

  // Studio has to call a Dok fresh or stale exactly where `doklo show`, `doklo
  // sync` and MCP do — they all read through the CLI's drift entry point.
  it.each([
    { state: 'fresh', expected: { stale: false }, arrange: async () => {} },
    {
      state: 'format-only',
      expected: { stale: false, reason: 'format-only' },
      arrange: async (root: string) => {
        await changeRowsCode(root, `// Page size.\n${ROWS_SOURCE.replace(/\n/g, '\r\n').replace('10;', '10; /* rows */')}`);
      },
    },
    {
      state: 'changed',
      expected: { stale: true, reason: 'changed' },
      arrange: async (root: string) => {
        await changeRowsCode(root);
      },
    },
    {
      state: 'missing-file',
      expected: { stale: true, reason: 'missing-file' },
      arrange: async (root: string) => {
        await rm(join(root, 'src/rows.ts'));
      },
    },
    {
      state: 'tracking-expanded',
      expected: { stale: true, reason: 'tracking-expanded' },
      arrange: async (root: string) => {
        await editMeta(root, 'ROWS', (meta) => {
          meta.tracking_review_required = true;
        });
      },
    },
    {
      state: 'unverified-tracking',
      expected: { stale: false, reason: 'unverified-tracking' },
      arrange: async (root: string) => {
        await changeRowsCode(root);
        await editMeta(root, 'ROWS', (meta) => {
          delete meta.tracking_version;
        });
      },
    },
    {
      state: 'no-hash',
      expected: { stale: false, reason: 'no-hash' },
      arrange: async (root: string) => {
        await editMeta(root, 'ROWS', (meta) => {
          delete meta.logic_hash;
        });
      },
    },
  ])('agrees with the CLI drift entry point: $state', async ({ arrange, expected }) => {
    const root = await driftWorkspace();
    await arrange(root);

    const studio = await studioStaleness('ROWS');
    expect(studio).toEqual(expected);
    expect(studio).toEqual(await cliStaleness(root, 'ROWS'));
  });

  it('shows the judge’s verdict only while it holds for the code it read', async () => {
    const root = await driftWorkspace();
    await changeRowsCode(root);
    await cacheAccurateVerdict(root, 'ROWS');

    const judged = await readDokDriftAction({ dokId: 'ROWS' });
    expect(judged).toMatchObject({
      ok: true,
      drift: { stale: true, reason: 'changed' },
      blocked: null,
      verdict: {
        model: 'anthropic/claude-sonnet-5',
        summary: 'The Dok never states a page size, so it still holds.',
        checked: [{
          claimPath: 'user_actions.steps[0].intent',
          files: ['src/rows.ts'],
          reason: 'Rows are still listed; only the page size changed.',
        }],
      },
    });

    // The code moved again: the verdict no longer describes it.
    await changeRowsCode(root, ROWS_SOURCE.replace('10;', '3;'));
    expect(await readDokDriftAction({ dokId: 'ROWS' })).toMatchObject({
      ok: true,
      drift: { stale: true, reason: 'changed' },
      verdict: null,
    });
  });

  it('names what blocks a confirmation before anyone presses it', async () => {
    const root = await driftWorkspace();
    await editMeta(root, 'ROWS', (meta) => {
      meta.tracking_review_required = true;
    });
    await rm(join(root, 'src/page.ts'));

    await expect(readDokDriftAction({ dokId: 'ROWS' })).resolves.toMatchObject({
      ok: true,
      drift: { stale: true, reason: 'tracking-expanded' },
      blocked: 'TRACKING_REVIEW_REQUIRED',
    });
    await expect(readDokDriftAction({ dokId: 'PAGE' })).resolves.toMatchObject({
      ok: true,
      drift: { stale: true, reason: 'missing-file' },
      blocked: 'NOTHING_TO_CONFIRM',
    });
  });

  it('reports an unknown Dok and a malformed id without throwing', async () => {
    await driftWorkspace();
    await expect(readDokDriftAction({ dokId: 'NOPE' })).resolves.toMatchObject({
      ok: false,
      code: 'MISSING',
    });
    await expect(readDokDriftAction({ dokId: '../escape' })).resolves.toMatchObject({
      ok: false,
      code: 'INVALID',
    });
  });
});

describe('readDoksDriftAction', () => {
  it('lists only the stale Doks, in catalog order', async () => {
    const root = await driftWorkspace();
    await changeRowsCode(root);
    await cacheAccurateVerdict(root, 'ROWS');

    const result = await readDoksDriftAction();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.stale.map((entry) => entry.dokId)).toEqual(['ROWS']);
    expect(result.stale[0]).toMatchObject({
      revision: revisionOf(await readFile(dokPath(root, 'ROWS'), 'utf-8')),
      drift: { stale: true, reason: 'changed' },
      verdict: { model: 'anthropic/claude-sonnet-5' },
      blocked: null,
    });
  });
});

describe('confirmDokStillAccurateAction', () => {
  it('re-stamps exactly the three drift facts and leaves every other byte alone', async () => {
    const root = await driftWorkspace();
    const path = dokPath(root, 'ROWS');
    const changed = await changeRowsCode(root);
    const before = await bytesAndRevision(path);
    const beforeDok = JSON.parse(before.bytes) as JsonRecord;
    expect(await studioStaleness('ROWS')).toEqual({ stale: true, reason: 'changed' });
    const expected = await cliComputeDriftConfirmation(beforeDok as Dok, root);
    if (expected === null) throw new Error('fixture: cannot compute the confirmation');

    const result = await confirmDokStillAccurateAction({
      dokId: 'ROWS',
      expectedRevision: before.revision,
    });

    expect(result).toEqual({
      ok: true,
      dokId: 'ROWS',
      path,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      drift: { stale: false, reason: 'format-only' },
      stamped: {
        logic_hash_normalized: expected.logic_hash_normalized,
        source_commit: null,
        files: 1,
      },
      judgeCacheRemoved: true,
    });
    const after = await bytesAndRevision(path);
    expect(result.ok && result.revision).toBe(after.revision);
    const afterDok = JSON.parse(after.bytes) as JsonRecord;

    // The three facts, recomputed from the code as it is now.
    expect(afterDok._meta.logic_hash_normalized).toBe(expected.logic_hash_normalized);
    expect(afterDok._meta.logic_hash_normalized).not.toBe(beforeDok._meta.logic_hash_normalized);
    expect(afterDok._meta.logic_files).toEqual([{ file: 'src/rows.ts', sha256: sha256(changed) }]);
    // No repository here: the stored base is removed, never kept beside
    // hashes it was not taken with.
    expect(afterDok._meta).not.toHaveProperty('source_commit');

    // Nothing else: logic_hash, status, history, version, edited_by_human,
    // pending_change and extension fields keep their values and their order.
    expect(afterDok._meta.logic_hash).toBe(beforeDok._meta.logic_hash);
    expect(afterDok.status).toBe('active');
    expect(afterDok._meta.version).toBe(3);
    expect(afterDok._meta.history).toEqual(beforeDok._meta.history);
    expect(afterDok._meta.edited_by_human).toBe(true);
    expect(afterDok._meta.pending_change).toEqual(beforeDok._meta.pending_change);
    expect(JSON.stringify(withoutDriftFacts(afterDok)))
      .toBe(JSON.stringify(withoutDriftFacts(beforeDok)));

    // Every drift reader now reads it as fresh — form only since confirmation.
    expect(await cliStaleness(root, 'ROWS')).toEqual({ stale: false, reason: 'format-only' });
    expect(await studioStaleness('ROWS')).toEqual({ stale: false, reason: 'format-only' });
  });

  it('records the diff base when git names one', async () => {
    const root = await driftWorkspace();
    harness.confirmation = (real) => (real === null ? null : { ...real, source_commit: FIXTURE_COMMIT });
    await changeRowsCode(root);
    const before = await bytesAndRevision(dokPath(root, 'ROWS'));

    const result = await confirmDokStillAccurateAction({
      dokId: 'ROWS',
      expectedRevision: before.revision,
    });

    expect(result).toMatchObject({ ok: true, stamped: { source_commit: FIXTURE_COMMIT } });
    const afterDok = await readJson(dokPath(root, 'ROWS'));
    expect(afterDok._meta.source_commit).toBe(FIXTURE_COMMIT);
    // It replaces the stored base in place.
    expect(Object.keys(afterDok._meta)).toEqual(Object.keys(JSON.parse(before.bytes)._meta));
  });

  it('keeps every other field of a logic_files entry, and records a legacy anchor set as logic_files', async () => {
    const root = await driftWorkspace();
    await editMeta(root, 'ROWS', (meta) => {
      meta.logic_files = meta.logic_files.map((entry: JsonRecord) => ({ ...entry, service_id: 'web' }));
    });
    await editMeta(root, 'PAGE', (meta) => {
      delete meta.logic_files;
    });
    const changed = await changeRowsCode(root);
    const pageChanged = PAGE_SOURCE.replace('20', '25');
    await writeFile(join(root, 'src/page.ts'), pageChanged, 'utf-8');
    const pageBefore = await readJson(dokPath(root, 'PAGE'));

    for (const dokId of ['ROWS', 'PAGE']) {
      const { revision } = await bytesAndRevision(dokPath(root, dokId));
      expect(await confirmDokStillAccurateAction({ dokId, expectedRevision: revision }))
        .toMatchObject({ ok: true, drift: { stale: false, reason: 'format-only' } });
    }

    expect((await readJson(dokPath(root, 'ROWS')))._meta.logic_files)
      .toEqual([{ file: 'src/rows.ts', service_id: 'web', sha256: sha256(changed) }]);
    const pageAfter = await readJson(dokPath(root, 'PAGE'));
    expect(pageAfter._meta.logic_files).toEqual([{ file: 'src/page.ts', sha256: sha256(pageChanged) }]);
    expect(pageAfter._meta.source_anchors).toEqual(pageBefore._meta.source_anchors);
    expect(pageAfter._meta.logic_hash).toBe(pageBefore._meta.logic_hash);
    expect(await cliStaleness(root, 'PAGE')).toEqual({ stale: false, reason: 'format-only' });
  });

  it('drops the judge’s cached verdict once a person has confirmed', async () => {
    const root = await driftWorkspace();
    await changeRowsCode(root);
    await cacheAccurateVerdict(root, 'ROWS');
    const cachePath = join(root, judgeCacheFile('ROWS'));
    await expect(readFile(cachePath, 'utf-8')).resolves.toContain('"verdict": "accurate"');
    const { revision } = await bytesAndRevision(dokPath(root, 'ROWS'));

    const result = await confirmDokStillAccurateAction({ dokId: 'ROWS', expectedRevision: revision });

    expect(result).toMatchObject({ ok: true, judgeCacheRemoved: true });
    await expect(readFile(cachePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not hide the next real change', async () => {
    const root = await driftWorkspace();
    await changeRowsCode(root);
    const { revision } = await bytesAndRevision(dokPath(root, 'ROWS'));
    expect(await confirmDokStillAccurateAction({ dokId: 'ROWS', expectedRevision: revision }))
      .toMatchObject({ ok: true });

    await changeRowsCode(root, ROWS_SOURCE.replace('10;', '50;'));

    expect(await cliStaleness(root, 'ROWS')).toEqual({ stale: true, reason: 'changed' });
    expect(await studioStaleness('ROWS')).toEqual({ stale: true, reason: 'changed' });
  });

  it.each([
    {
      label: 'a fresh Dok',
      arrange: async () => {},
      code: 'NOT_STALE',
      error: /is not stale \(its tracked sources are unchanged\)/u,
    },
    {
      label: 'a Dok changed in form only',
      arrange: async (root: string) => {
        await changeRowsCode(root, `/* header */\n${ROWS_SOURCE}`);
      },
      code: 'NOT_STALE',
      error: /changed in form only/u,
    },
    {
      label: 'a Dok whose recovered tracking needs review',
      arrange: async (root: string) => {
        await changeRowsCode(root);
        await editMeta(root, 'ROWS', (meta) => {
          meta.tracking_review_required = true;
        });
      },
      code: 'TRACKING_REVIEW_REQUIRED',
      error: /needs review.*does not clear that review/u,
    },
    {
      label: 'a Dok with a tracked file that cannot be read',
      arrange: async (root: string) => {
        await rm(join(root, 'src/rows.ts'));
      },
      code: 'NOTHING_TO_CONFIRM',
      error: /cannot be read/u,
    },
    {
      label: 'a Dok the confirmation cannot be computed for',
      arrange: async (root: string) => {
        await changeRowsCode(root);
        harness.confirmation = () => null;
      },
      code: 'NOTHING_TO_CONFIRM',
      error: /nothing to confirm/u,
    },
  ])('refuses $label and changes nothing', async ({ arrange, code, error }) => {
    const root = await driftWorkspace();
    await arrange(root);
    await cacheAccurateVerdictIfPossible(root);
    const path = dokPath(root, 'ROWS');
    const before = await bytesAndRevision(path);
    const cacheBefore = await readFile(join(root, judgeCacheFile('ROWS')), 'utf-8').catch(() => null);

    const result = await confirmDokStillAccurateAction({
      dokId: 'ROWS',
      expectedRevision: before.revision,
    });

    expect(result).toMatchObject({ ok: false, code, preserved: true, path });
    if (!result.ok) expect(result.error).toMatch(error);
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
    expect(await readFile(join(root, judgeCacheFile('ROWS')), 'utf-8').catch(() => null))
      .toBe(cacheBefore);
  });

  it('refuses a stale revision and malformed input without writing', async () => {
    const root = await driftWorkspace();
    await changeRowsCode(root);
    const path = dokPath(root, 'ROWS');
    const before = await bytesAndRevision(path);

    await expect(confirmDokStillAccurateAction({
      dokId: 'ROWS',
      expectedRevision: revisionOf('an older Dok'),
    })).resolves.toMatchObject({ ok: false, code: 'CONFLICT', preserved: true });
    await expect(confirmDokStillAccurateAction({
      dokId: 'ROWS',
      expectedRevision: 'not-a-revision',
    })).resolves.toMatchObject({ ok: false, code: 'INVALID', preserved: true });
    await expect(confirmDokStillAccurateAction(null as never))
      .resolves.toMatchObject({ ok: false, code: 'INVALID', preserved: true });
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
  });
});

/** Seed a holding verdict where the Dok can have one (stale `changed`), to prove a refusal leaves it be. */
async function cacheAccurateVerdictIfPossible(root: string): Promise<void> {
  const dok = await readJson(dokPath(root, 'ROWS')) as Dok;
  if (currentJudgeCacheFacts(dok, root) !== null) await cacheAccurateVerdict(root, 'ROWS');
}

describe('bulkConfirmDoksStillAccurateAction', () => {
  async function twoStaleDoks(root: string) {
    await changeRowsCode(root);
    await writeFile(join(root, 'src/page.ts'), PAGE_SOURCE.replace('20', '30'), 'utf-8');
    const [rows, page] = await Promise.all([
      bytesAndRevision(dokPath(root, 'ROWS')),
      bytesAndRevision(dokPath(root, 'PAGE')),
    ]);
    return { rows, page };
  }

  it('confirms every selected stale Dok, each re-stamped on its own', async () => {
    const root = await driftWorkspace();
    const { rows, page } = await twoStaleDoks(root);
    await cacheAccurateVerdict(root, 'ROWS');

    const result = await bulkConfirmDoksStillAccurateAction({
      targets: [
        { dokId: 'ROWS', expectedRevision: rows.revision },
        { dokId: 'PAGE', expectedRevision: page.revision },
      ],
    });

    expect(result).toEqual({
      ok: true,
      confirmed: [
        { dokId: 'ROWS', revision: revisionOf(await readFile(dokPath(root, 'ROWS'), 'utf-8')) },
        { dokId: 'PAGE', revision: revisionOf(await readFile(dokPath(root, 'PAGE'), 'utf-8')) },
      ],
    });
    for (const [dokId, before] of [['ROWS', rows], ['PAGE', page]] as const) {
      const afterDok = await readJson(dokPath(root, dokId));
      expect(JSON.stringify(withoutDriftFacts(afterDok)))
        .toBe(JSON.stringify(withoutDriftFacts(JSON.parse(before.bytes))));
      expect(await cliStaleness(root, dokId)).toEqual({ stale: false, reason: 'format-only' });
    }
    await expect(readFile(join(root, judgeCacheFile('ROWS')), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      label: 'a target that is not stale',
      targets: (revisions: { rows: string; page: string }) => [
        { dokId: 'ROWS', expectedRevision: revisions.rows },
        { dokId: 'PAGE', expectedRevision: revisions.page },
      ],
      arrange: async (root: string) => {
        await writeFile(join(root, 'src/page.ts'), PAGE_SOURCE, 'utf-8');
      },
      failures: [{ dokId: 'PAGE', code: 'NOT_STALE' }],
    },
    {
      label: 'a stale revision',
      targets: (revisions: { rows: string; page: string }) => [
        { dokId: 'ROWS', expectedRevision: revisions.rows },
        { dokId: 'PAGE', expectedRevision: revisionOf('an older Dok') },
      ],
      arrange: async () => {},
      failures: [{ dokId: 'PAGE', code: 'CONFLICT' }],
    },
    {
      label: 'an unknown Dok',
      targets: (revisions: { rows: string; page: string }) => [
        { dokId: 'ROWS', expectedRevision: revisions.rows },
        { dokId: 'GONE', expectedRevision: revisions.page },
      ],
      arrange: async () => {},
      failures: [{ dokId: 'GONE', code: 'MISSING' }],
    },
    {
      label: 'recovered tracking that needs review',
      targets: (revisions: { rows: string; page: string }) => [
        { dokId: 'ROWS', expectedRevision: revisions.rows },
        { dokId: 'PAGE', expectedRevision: revisions.page },
      ],
      arrange: async (root: string) => {
        await editMeta(root, 'PAGE', (meta) => {
          meta.tracking_review_required = true;
        });
      },
      failures: [{ dokId: 'PAGE', code: 'TRACKING_REVIEW_REQUIRED' }],
    },
  ])('preflights every target and writes nothing when one fails: $label', async ({ targets, arrange, failures }) => {
    const root = await driftWorkspace();
    await twoStaleDoks(root);
    await arrange(root);
    const [rows, page] = await Promise.all([
      bytesAndRevision(dokPath(root, 'ROWS')),
      bytesAndRevision(dokPath(root, 'PAGE')),
    ]);

    const result = await bulkConfirmDoksStillAccurateAction({
      targets: targets({ rows: rows.revision, page: page.revision }),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PREFLIGHT_FAILED',
      confirmed: [],
      failures: failures.map((failure) => ({ ...failure, preserved: true })),
    });
    expect(await readFile(dokPath(root, 'ROWS'), 'utf-8')).toBe(rows.bytes);
    expect(await readFile(dokPath(root, 'PAGE'), 'utf-8')).toBe(page.bytes);
  });

  it('rejects duplicate and empty selections as invalid', async () => {
    const root = await driftWorkspace();
    const { rows } = await twoStaleDoks(root);

    await expect(bulkConfirmDoksStillAccurateAction({
      targets: [
        { dokId: 'ROWS', expectedRevision: rows.revision },
        { dokId: 'ROWS', expectedRevision: rows.revision },
      ],
    })).resolves.toMatchObject({ ok: false, code: 'INVALID', confirmed: [], failures: [] });
    await expect(bulkConfirmDoksStillAccurateAction({ targets: [] }))
      .resolves.toMatchObject({ ok: false, code: 'INVALID' });
    expect(await readFile(dokPath(root, 'ROWS'), 'utf-8')).toBe(rows.bytes);
  });

  it('reports a late write failure Dok by Dok and keeps the failed Dok as it was', async () => {
    const root = await driftWorkspace();
    const { rows, page } = await twoStaleDoks(root);
    harness.atomicFaultPathPart = 'PAGE.json';

    const result = await bulkConfirmDoksStillAccurateAction({
      targets: [
        { dokId: 'ROWS', expectedRevision: rows.revision },
        { dokId: 'PAGE', expectedRevision: page.revision },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PARTIAL_FAILURE',
      confirmed: [{ dokId: 'ROWS', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
      failures: [{ dokId: 'PAGE', code: 'WRITE_FAILED', preserved: true }],
    });
    expect(await cliStaleness(root, 'ROWS')).toEqual({ stale: false, reason: 'format-only' });
    expect(await readFile(dokPath(root, 'PAGE'), 'utf-8')).toBe(page.bytes);
    expect(await cliStaleness(root, 'PAGE')).toEqual({ stale: true, reason: 'changed' });
  });
});
