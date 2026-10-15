// One normaliser for every drift surface (judge-gated sync design §4.2).
//
// generate stamps `_meta.logic_hash_normalized`; sync, show and the MCP server
// recompute it to tell a form-only edit from a real one. If any surface called
// core's `isDokStale` without the normaliser, a comments-only edit would read as
// fresh on one screen and stale on another — the split-reader failure drift
// hardening B4 recorded. So the CLI reaches core's drift functions through one
// entry point, `src/lib/drift.ts`, and this file pins that two ways: by source
// (nothing else imports them) and by behaviour (each surface reports the same
// verdict for the same Dok).
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLogicHash, loadHubModel, readAnchorContentsSync, type Dok } from '@doklo-beta/core';
import { tsTreeNormalizer } from '@doklo-beta/adapter-nextjs';
import { DRIFT_NORMALIZER, computeDriftEvidence, isDokStale } from '../src/lib/drift.js';
import { runSync } from '../src/commands/sync.js';
import { dokStaleness } from '../src/commands/show.js';
import { resolveDokStaleness } from '../src/mcp/staleness.js';
import { getDok, listDoksTool } from '../src/mcp/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const ENTRY = 'lib/drift.ts';

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Names imported from `@doklo-beta/core` by one module (value and type imports). */
function coreImports(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@doklo-beta\/core'/g)) {
    for (const raw of match[1]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('drift normaliser contract — source', () => {
  it('only the CLI drift entry point imports core’s staleness and normalised-hash functions', async () => {
    const guarded = new Set(['isDokStale', 'computeNormalizedLogicHash']);
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcDir)) {
      const rel = relative(srcDir, file);
      if (rel === ENTRY) continue;
      const source = await readFile(file, 'utf-8');
      for (const name of coreImports(source)) {
        if (guarded.has(name)) offenders.push(`${rel}: ${name}`);
      }
      if (/import\s*\*\s*as\s+\w+\s+from\s*'@doklo-beta\/core'/.test(source)) offenders.push(`${rel}: namespace import`);
    }
    expect(offenders).toEqual([]);
  });

  it('every module that judges staleness imports isDokStale from the entry point', async () => {
    const callers: string[] = [];
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcDir)) {
      const rel = relative(srcDir, file);
      if (rel === ENTRY) continue;
      const source = await readFile(file, 'utf-8');
      if (!/\bisDokStale\s*\(/.test(source)) continue;
      callers.push(rel);
      const fromEntry = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']*)'/g)]
        .some((m) => /\bisDokStale\b/.test(m[1]!) && /(^|\/)lib\/drift\.js$|^\.\/drift\.js$/.test(m[2]!));
      if (!fromEntry) offenders.push(rel);
    }
    // The three surfaces named by the design all judge staleness here.
    expect(callers.sort()).toEqual(['commands/show.ts', 'commands/sync.ts', 'mcp/staleness.ts']);
    expect(offenders).toEqual([]);
  });

  it('the entry point always injects its normaliser', async () => {
    const source = await readFile(join(srcDir, ENTRY), 'utf-8');
    expect(source).toMatch(/isDokStaleWithOptions\(dok,\s*projectRoot,\s*\{\s*normalize:\s*DRIFT_NORMALIZER\s*\}\)/);
    expect(DRIFT_NORMALIZER).toBe(tsTreeNormalizer);
  });
});

describe('drift normaliser contract — behaviour', () => {
  async function workspaceWithStampedDok(): Promise<{ root: string; content: string }> {
    const root = await mkdtemp(join(tmpdir(), 'doklo-drift-contract-'));
    const content = "export const limit = 10;\nexport function rows() { return 'https://example.com//x'; }\n";
    await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/rows.ts'), content, 'utf-8');
    await writeFile(join(root, 'workspace.json'), JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'en',
      supported_locales: ['en'],
    }), 'utf-8');
    // Stamped exactly as generate stamps it: the same read, the entry point's evidence.
    const read = readAnchorContentsSync(['src/rows.ts'], root);
    const evidence = computeDriftEvidence(['src/rows.ts'], read.contents);
    await writeFile(join(root, '.doklo/hub/doks/ROWS.json'), JSON.stringify({
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
        anchor_service_id: 'web',
        source_anchors: [{ file: 'src/rows.ts' }],
        logic_hash: computeLogicHash(read.contents),
        ...evidence,
      },
    }), 'utf-8');
    return { root, content };
  }

  async function verdicts(root: string) {
    const hub = await loadHubModel(root);
    const dok = hub.doks.find((d) => d.dok_id === 'ROWS') as Dok;
    const check = await runSync({ root, check: true });
    return {
      entry: isDokStale(dok, root),
      show: await dokStaleness(root, dok),
      sync: { stale: check.stale.map((s) => s.dokId), formatOnly: check.formatOnly },
      mcp: resolveDokStaleness(dok, root),
      mcpGet: getDok(hub, root, 'ROWS').is_stale,
      mcpFresh: listDoksTool(hub, root, { stale: false }).doks.map((d) => d.dok_id),
    };
  }

  it('a comments-and-whitespace edit is format-only on every surface', async () => {
    const { root, content } = await workspaceWithStampedDok();
    try {
      await writeFile(join(root, 'src/rows.ts'), `// Page size.\n${content.replace(/\n/g, '\r\n').replace('10;', '10; /* rows */')}`, 'utf-8');
      expect(await verdicts(root)).toEqual({
        entry: { stale: false, reason: 'format-only' },
        show: { stale: false, reason: 'format-only' },
        sync: { stale: [], formatOnly: ['ROWS'] },
        mcp: false,
        mcpGet: false,
        mcpFresh: ['ROWS'],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a real edit is stale on every surface', async () => {
    const { root, content } = await workspaceWithStampedDok();
    try {
      await writeFile(join(root, 'src/rows.ts'), content.replace('10;', '5;'), 'utf-8');
      expect(await verdicts(root)).toEqual({
        entry: { stale: true, reason: 'changed' },
        show: { stale: true, reason: 'changed' },
        sync: { stale: ['ROWS'], formatOnly: [] },
        mcp: true,
        mcpGet: true,
        mcpFresh: [],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a change inside a string literal that looks like a comment is a real change', async () => {
    const { root, content } = await workspaceWithStampedDok();
    try {
      await writeFile(join(root, 'src/rows.ts'), content.replace('//x', '//y'), 'utf-8');
      expect((await verdicts(root)).sync).toEqual({ stale: ['ROWS'], formatOnly: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
