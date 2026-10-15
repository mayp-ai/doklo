// The sync judge's cache (design §4.7) and the "still accurate" baseline the
// CLI computes for Studio (design §4.6): a cached verdict holds for exactly the
// code, base and Dok text the judge read; a confirmation re-stamps the
// normalised hash, per-file hashes and commit — never logic_hash — so the
// Dok reads fresh again.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DokSchema, computeLogicHash, readAnchorContentsSync, type Dok } from '@doklo-beta/core';
import { computeDriftConfirmation, computeDriftEvidence, isDokStale } from '../src/lib/drift.js';
import {
  JudgeCacheRecordSchema,
  currentJudgeCacheFacts,
  dokBodySha256,
  judgeCacheFile,
  judgeCacheMatches,
  readCurrentJudgeVerdict,
  readJudgeCache,
  removeJudgeCache,
  writeJudgeCache,
  type JudgeCacheRecord,
} from '../src/lib/judge/cache.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-judge-cache-'));
  roots.push(root);
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

const SOURCE = "export const limit = 10;\nexport function rows() { return 'https://example.com//x'; }\n";

function stampedDok(root: string, meta: Record<string, unknown> = {}): Dok {
  const read = readAnchorContentsSync(['src/rows.ts'], root);
  const evidence = computeDriftEvidence(['src/rows.ts'], read.contents);
  return DokSchema.parse({
    dok_id: 'ROWS',
    name: 'Rows',
    status: 'active',
    tags: [],
    surfaces: ['web'],
    description: 'Lists rows a page at a time for the dashboard.',
    user_actions: { steps: [{ order: 1, actor: { kind: 'system' }, intent: 'List rows', outcome: 'Rows listed', variants: [{ platform: 'all', interaction: 'auto' }] }] },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
    _meta: {
      version: 1,
      history: [],
      tracking_version: 2,
      source_anchors: [{ file: 'src/rows.ts' }],
      logic_hash: computeLogicHash(read.contents),
      source_commit: 'b'.repeat(40),
      ...evidence,
      ...meta,
    },
  });
}

function recordFor(dok: Dok, facts: { logicHash: string; sourceCommit: string; dokSha256: string }): JudgeCacheRecord {
  return {
    schema_version: 1,
    dok_id: dok.dok_id,
    logic_hash: facts.logicHash,
    source_commit: facts.sourceCommit,
    dok_sha256: facts.dokSha256,
    verdict: 'accurate',
    errors: [],
    omissions: [],
    checked: [{ claim_path: 'description', evidence_files: ['src/rows.ts'], reason: 'paging unchanged' }],
    summary: 'Only the limit constant moved; the Dok still holds.',
    model: 'anthropic/claude-sonnet-5',
    prompt_digest: 'p'.repeat(64),
    request_digest: 'r'.repeat(64),
  };
}

describe('judge cache file', () => {
  it('round-trips one record per Dok under .doklo/cache/judge, with no clock in it', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src/rows.ts'), SOURCE, 'utf-8');
    const dok = stampedDok(root);
    const record = recordFor(dok, { logicHash: 'h', sourceCommit: 'c', dokSha256: dokBodySha256(dok) });
    await writeJudgeCache(root, record);

    expect(judgeCacheFile('ROWS')).toBe('.doklo/cache/judge/ROWS.json');
    const raw = JSON.parse(await readFile(join(root, '.doklo/cache/judge/ROWS.json'), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      'checked', 'dok_id', 'dok_sha256', 'errors', 'logic_hash', 'model', 'omissions',
      'prompt_digest', 'request_digest', 'schema_version', 'source_commit', 'summary', 'verdict',
    ]);
    expect(await readJudgeCache(root, 'ROWS')).toEqual(record);

    await removeJudgeCache(root, 'ROWS');
    expect(await readJudgeCache(root, 'ROWS')).toBeNull();
    await removeJudgeCache(root, 'ROWS'); // idempotent
  });

  it('treats a missing, malformed, foreign or non-accurate record as absent', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src/rows.ts'), SOURCE, 'utf-8');
    const dok = stampedDok(root);
    const record = recordFor(dok, { logicHash: 'h', sourceCommit: 'c', dokSha256: dokBodySha256(dok) });
    expect(await readJudgeCache(root, 'ROWS')).toBeNull();
    await mkdir(join(root, '.doklo/cache/judge'), { recursive: true });
    await writeFile(join(root, '.doklo/cache/judge/ROWS.json'), '{not json', 'utf-8');
    expect(await readJudgeCache(root, 'ROWS')).toBeNull();
    await writeFile(join(root, '.doklo/cache/judge/ROWS.json'), JSON.stringify({ ...record, dok_id: 'OTHER' }), 'utf-8');
    expect(await readJudgeCache(root, 'ROWS')).toBeNull();
    await writeFile(join(root, '.doklo/cache/judge/ROWS.json'), JSON.stringify({ ...record, verdict: 'needs_update' }), 'utf-8');
    expect(await readJudgeCache(root, 'ROWS')).toBeNull();
    await writeFile(join(root, '.doklo/cache/judge/ROWS.json'), JSON.stringify({ ...record, cached_at: '2026-10-15T00:00:00Z' }), 'utf-8');
    expect(await readJudgeCache(root, 'ROWS')).toBeNull();
    expect(await readJudgeCache(root, '../escape')).toBeNull();
    await expect(writeJudgeCache(root, { ...record, dok_id: '../escape' })).rejects.toThrow();
    expect(JudgeCacheRecordSchema.safeParse(record).success).toBe(true);
  });

  it('a verdict holds for the code, base and Dok text the judge read — and only those', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src/rows.ts'), SOURCE, 'utf-8');
    const dok = stampedDok(root);
    await writeFile(join(root, 'src/rows.ts'), SOURCE.replace('10;', '25;'), 'utf-8'); // the change the judge read
    const facts = currentJudgeCacheFacts(dok, root)!;
    expect(facts).toMatchObject({ dokId: 'ROWS', sourceCommit: 'b'.repeat(40) });
    await writeJudgeCache(root, recordFor(dok, facts));

    expect(await readCurrentJudgeVerdict(root, dok, root)).toMatchObject({ model: 'anthropic/claude-sonnet-5' });
    // Operational metadata (history, version) is not what the judge read.
    const reviewed = DokSchema.parse({ ...dok, _meta: { ...dok._meta, version: 3, history: [{ version: 3, date: '2026-10-15', change: 'x' }] } });
    expect(await readCurrentJudgeVerdict(root, reviewed, root)).not.toBeNull();
    // A different Dok text, a different base, or more code change: the verdict no longer holds.
    const edited = DokSchema.parse({ ...dok, description: 'Lists every row at once.' });
    expect(await readCurrentJudgeVerdict(root, edited, root)).toBeNull();
    const rebased = DokSchema.parse({ ...dok, _meta: { ...dok._meta, source_commit: 'c'.repeat(40) } });
    expect(await readCurrentJudgeVerdict(root, rebased, root)).toBeNull();
    await writeFile(join(root, 'src/rows.ts'), SOURCE.replace('10;', '30;'), 'utf-8');
    expect(await readCurrentJudgeVerdict(root, dok, root)).toBeNull();
    expect(judgeCacheMatches(recordFor(dok, facts), facts)).toBe(true);
  });

  it('hashes a raw Dok file and its parsed form alike', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src/rows.ts'), SOURCE, 'utf-8');
    const dok = stampedDok(root);
    const raw = JSON.parse(JSON.stringify(dok)) as Record<string, unknown>;
    delete raw['tags'];
    delete raw['surfaces'];
    expect(dokBodySha256({ ...raw, tags: [], surfaces: ['web'] })).toBe(dokBodySha256(dok));
  });
});

describe('“still accurate” baseline for Studio (computeDriftConfirmation)', () => {
  it('re-stamps the normalised hash, per-file hashes and commit — never logic_hash — so the Dok reads fresh', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src/rows.ts'), SOURCE, 'utf-8');
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'add', '-A']);
    execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dok = stampedDok(root);
    await writeFile(join(root, 'src/rows.ts'), SOURCE.replace('10;', '25;'), 'utf-8');
    expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'changed' });

    const confirmation = await computeDriftConfirmation(dok, root);
    expect(confirmation).not.toBeNull();
    expect(confirmation!.source_commit).toBe(head);
    expect(confirmation!.logic_files).toEqual([{ file: 'src/rows.ts', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    const confirmed = DokSchema.parse({ ...dok, _meta: { ...dok._meta, ...confirmation } });
    expect(confirmed._meta.logic_hash).toBe(dok._meta.logic_hash);
    expect(isDokStale(confirmed, root)).toEqual({ stale: false, reason: 'format-only' });
    // A later real change is stale again.
    await writeFile(join(root, 'src/rows.ts'), SOURCE.replace('10;', '40;'), 'utf-8');
    expect(isDokStale(confirmed, root)).toEqual({ stale: true, reason: 'changed' });
  });

  it('refuses when a tracked file cannot be read or nothing is tracked; no commit outside git', async () => {
    const root = await workspace();
    await writeFile(join(root, 'src/rows.ts'), SOURCE, 'utf-8');
    const dok = stampedDok(root);
    const outsideGit = await computeDriftConfirmation(dok, root);
    expect(outsideGit).not.toBeNull();
    expect(outsideGit).not.toHaveProperty('source_commit');
    await rm(join(root, 'src/rows.ts'));
    expect(await computeDriftConfirmation(dok, root)).toBeNull();
    const untracked = DokSchema.parse({ ...dok, _meta: { ...dok._meta, logic_files: [], source_anchors: [] } });
    expect(await computeDriftConfirmation(untracked, root)).toBeNull();
  });
});
