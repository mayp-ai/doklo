import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeLogicHash, loadHubModel, type Dok } from '@doklo-beta/core';
import {
  searchDoks,
  getDok,
  listDoksTool,
  DokNotFoundError,
} from '../src/mcp/tools.js';
import { resolveDokStaleness } from '../src/mcp/staleness.js';

// ───────── fixture builders (per-Dok layout, mirrors show.test.ts) ────

interface HubFixture {
  doks: Record<string, unknown>;
  lexicon?: unknown;
}

async function tmpHub(fixture: HubFixture): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-mcp-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [
        { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
        { service_id: 'api', type: 'backend', framework: 'nextjs', code_root: '.' },
      ],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  if (fixture.lexicon !== undefined) {
    await writeFile(
      join(root, '.doklo', 'hub', 'lexicon.json'),
      JSON.stringify(fixture.lexicon),
      'utf-8',
    );
  }
  for (const [id, content] of Object.entries(fixture.doks)) {
    await writeFile(
      join(root, '.doklo/hub/doks', `${id}.json`),
      JSON.stringify(content),
      'utf-8',
    );
  }
  return root;
}

/** A minimal valid Dok, overridable per field. */
function dok(dokId: string, over: Record<string, unknown> = {}) {
  return {
    dok_id: dokId,
    name: 'Placeholder name',
    status: 'active',
    tags: ['demo'],
    surfaces: ['web'],
    description: 'A test dok with enough description content for the schema.',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'system' },
          intent: 'Render the view',
          outcome: 'View rendered',
          variants: [{ platform: 'all', interaction: 'auto' }],
        },
      ],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
    ...over,
  };
}

/** A Dok carrying a single-file source anchor + logic_hash, so drift detection
 *  has a stored hash to compare the on-disk source against. */
function hashedDok(
  dokId: string,
  file: string,
  logicHash: string,
  over: Record<string, unknown> = {},
) {
  return dok(dokId, {
    _meta: {
      version: 1,
      history: [],
      source_anchors: [{ file }],
      logic_hash: logicHash,
      tracking_version: 2,
    },
    ...over,
  });
}

/** Write a source file (creating parent dirs) under a workspace root, so an
 *  anchored Dok can be re-hashed against real on-disk content. */
async function writeSource(
  root: string,
  file: string,
  content: string,
): Promise<void> {
  const abs = join(root, file);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

// A Dok whose name is a TermRef into the lexicon, and which references a second
// term only inside a variant target — the lever for the lexicon-only match test.
const DASHBOARD_DOK = dok('DASH', {
  name: { term_ref: 'TERM-NAV-DASHBOARD' },
  description: 'Landing surface after signing in.',
  tags: ['home'],
  user_actions: {
    steps: [
      {
        order: 1,
        actor: { kind: 'system' },
        intent: 'Show the primary landing surface',
        outcome: 'Widgets are visible',
        variants: [
          {
            platform: 'all',
            interaction: 'auto',
            target: { term_ref: 'TERM-WIDGET-REVENUE' },
          },
        ],
      },
    ],
  },
});

// A Dok carrying source anchors + a searchable intent.
const AUTH_DOK = dok('AUTH', {
  name: 'Sign in',
  description: 'Authenticate an existing user with email and password.',
  tags: ['auth', 'security'],
  status: 'active',
  user_actions: {
    steps: [
      {
        order: 1,
        actor: { kind: 'external', label: 'Visitor' },
        intent: 'Submit login credentials',
        outcome: 'Session established',
        variants: [{ platform: 'desktop', interaction: 'submit' }],
      },
    ],
  },
  business_rules: {
    rules: [
      {
        id: 'BR-AUTH-01',
        type: 'validation',
        description: 'Email must be a valid address.',
      },
    ],
  },
  acceptance_criteria: {
    criteria: [
      {
        id: 'AC-AUTH-01',
        statement: 'Invalid credentials show an error.',
        related_rules: ['BR-AUTH-01'],
      },
    ],
  },
  _meta: {
    version: 3,
    history: [{ version: 1, date: '2026-01-01', change: 'created' }],
    logic_hash: 'deadbeef',
    tracking_version: 2,
    generation_confidence: 0.9,
    source_anchors: [
      { file: 'src/auth/login.ts', symbol: 'login', start_line: 10, end_line: 42 },
    ],
  },
});

// A draft-status Dok, only surfaced on `api`, for filter tests.
const REPORT_DOK = dok('RPT', {
  name: 'Export report',
  status: 'draft',
  surfaces: ['api'],
  tags: ['report'],
});

const LEXICON = {
  version: 1,
  terms: [
    {
      term_id: 'TERM-NAV-DASHBOARD',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'Dashboard' },
      related_doks: [],
    },
    {
      term_id: 'TERM-WIDGET-REVENUE',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'Revenue widget' },
      related_doks: [],
    },
  ],
};

async function fullHub(): Promise<{ hub: Awaited<ReturnType<typeof loadHubModel>>; root: string }> {
  const root = await tmpHub({
    doks: {
      'AUTH': AUTH_DOK,
      'DASH': DASHBOARD_DOK,
      'RPT': REPORT_DOK,
    },
    lexicon: LEXICON,
  });
  const hub = await loadHubModel(root);
  return { hub, root };
}

// ───────── list_doks ─────────────────────────────────────────────────

describe('listDoksTool', () => {
  it('returns every Dok, sorted by id, with resolved per-Dok staleness', async () => {
    const { hub, root } = await fullHub();
    const res = listDoksTool(hub, root, {});
    expect(res.total).toBe(3);
    expect(res.doks.map((d) => d.dok_id)).toEqual(['AUTH', 'DASH', 'RPT']);
    // DASH / RPT carry no logic_hash → drift is undecidable → 'unknown'.
    // AUTH stores a logic_hash but its anchor file is absent on disk (the
    // fixture never writes src/auth/login.ts) → genuinely stale.
    const staleOf = (id: string) => res.doks.find((d) => d.dok_id === id)?.is_stale;
    expect(staleOf('DASH')).toBe('unknown');
    expect(staleOf('RPT')).toBe('unknown');
    expect(staleOf('AUTH')).toBe(true);
    // TermRef name resolved to the lexicon display string.
    expect(res.doks.find((d) => d.dok_id === 'DASH')?.name).toBe('Dashboard');
  });

  it('filters by status', async () => {
    const { hub, root } = await fullHub();
    const res = listDoksTool(hub, root, { status: 'draft' });
    expect(res.doks.map((d) => d.dok_id)).toEqual(['RPT']);
  });

  it('filters by surfacing service', async () => {
    const { hub, root } = await fullHub();
    const res = listDoksTool(hub, root, { service: 'api' });
    expect(res.doks.map((d) => d.dok_id)).toEqual(['RPT']);
  });

  it('excludes no-hash Doks from a stale: true filter', async () => {
    const { hub, root } = await fullHub();
    const res = listDoksTool(hub, root, { stale: true });
    // Only AUTH is judged stale (hashed, anchor missing). DASH / RPT
    // have no logic_hash → 'unknown' → excluded from a boolean stale filter.
    expect(res.doks.map((d) => d.dok_id)).toEqual(['AUTH']);
  });
});

// ───────── search_doks ───────────────────────────────────────────────

describe('searchDoks', () => {
  it('matches on resolved name', async () => {
    const { hub, root } = await fullHub();
    const res = searchDoks(hub, root, 'sign in');
    expect(res.results.map((r) => r.dok_id)).toContain('AUTH');
    const hit = res.results.find((r) => r.dok_id === 'AUTH');
    expect(hit?.matched_on).toBe('name');
    // AUTH is stale: it stores a logic_hash but its anchor file is absent.
    expect(hit?.is_stale).toBe(true);
  });

  it('matches on a user-action intent', async () => {
    const { hub, root } = await fullHub();
    const res = searchDoks(hub, root, 'credentials');
    const hit = res.results.find((r) => r.dok_id === 'AUTH');
    expect(hit).toBeDefined();
    expect(hit?.matched_on).toBe('intent');
  });

  it('matches via a lexicon term referenced only in a variant target', async () => {
    const { hub, root } = await fullHub();
    // "revenue" appears nowhere in DASH's own text — only in the display
    // string of TERM-WIDGET-REVENUE, which the Dok references via a variant.
    const res = searchDoks(hub, root, 'revenue');
    const hit = res.results.find((r) => r.dok_id === 'DASH');
    expect(hit).toBeDefined();
    expect(hit?.matched_on).toBe('lexicon');
  });

  it('returns an empty result set when nothing matches', async () => {
    const { hub, root } = await fullHub();
    const res = searchDoks(hub, root, 'zzz-nonexistent-token');
    expect(res.total).toBe(0);
    expect(res.results).toEqual([]);
  });

  it('sorts results by dok_id', async () => {
    const { hub, root } = await fullHub();
    // "sign" matches AUTH (name "Sign in") and DASH (description
    // "...after signing in") — two hits, asserting stable id ordering.
    const res = searchDoks(hub, root, 'sign');
    expect(res.results.map((r) => r.dok_id)).toEqual(['AUTH', 'DASH']);
  });
});

// ───────── get_dok ───────────────────────────────────────────────────

describe('getDok', () => {
  it('returns the full body with source_anchors and is_stale', async () => {
    const { hub, root } = await fullHub();
    const res = getDok(hub, root, 'AUTH');
    expect(res.dok_id).toBe('AUTH');
    expect(res.name).toBe('Sign in');
    // Stale: AUTH stores a logic_hash but its anchor file is absent on disk.
    expect(res.is_stale).toBe(true);
    expect(res.source_anchors).toEqual([
      { file: 'src/auth/login.ts', symbol: 'login', start_line: 10, end_line: 42 },
    ]);
    expect(res.business_rules.rules[0]?.id).toBe('BR-AUTH-01');
    expect(res.acceptance_criteria.criteria[0]?.id).toBe('AC-AUTH-01');
    // Actor discriminated union is passed through untouched.
    expect(res.user_actions.steps[0]?.actor).toEqual({ kind: 'external', label: 'Visitor' });
  });

  it('resolves a TermRef name to its lexicon display string', async () => {
    const { hub, root } = await fullHub();
    const res = getDok(hub, root, 'DASH');
    expect(res.name).toBe('Dashboard');
    // The variant target TermRef is resolved too — no TermRef object leaks.
    expect(res.user_actions.steps[0]?.variants[0]?.target).toBe('Revenue widget');
  });

  it('is case-insensitive on the id', async () => {
    const { hub, root } = await fullHub();
    const res = getDok(hub, root, 'auth');
    expect(res.dok_id).toBe('AUTH');
  });

  it('throws DokNotFoundError for an unknown id', async () => {
    const { hub, root } = await fullHub();
    expect(() => getDok(hub, root, 'NOPE')).toThrowError(DokNotFoundError);
  });

  it('never exposes operational meta (logic_hash, version, history, confidence)', async () => {
    const { hub, root } = await fullHub();
    const res = getDok(hub, root, 'AUTH');
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('logic_hash');
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('generation_confidence');
    expect(serialized).not.toContain('history');
    expect('_meta' in res).toBe(false);
  });
});

// ───────── staleness (drift wired) ────────────────────────────────────

describe('staleness (drift wired)', () => {
  it('reports legacy hashed Doks as unknown and excludes them from both boolean filters', async () => {
    const legacy = hashedDok('LEGACY', 'src/legacy.ts', computeLogicHash([{ file: 'src/legacy.ts', content: 'X' }]));
    delete (legacy._meta as Record<string, unknown>).tracking_version;
    const root = await tmpHub({ doks: { LEGACY: legacy } });
    await writeSource(root, 'src/legacy.ts', 'X');
    const hub = await loadHubModel(root);
    expect(getDok(hub, root, 'LEGACY').is_stale).toBe('unknown');
    expect(listDoksTool(hub, root, { stale: false }).doks).toEqual([]);
    expect(listDoksTool(hub, root, { stale: true }).doks).toEqual([]);
  });

  it('reports recovered tracking as stale even when source bytes match', async () => {
    const repaired = hashedDok('REPAIRED', 'src/repaired.ts', computeLogicHash([
      { file: 'src/repaired.ts', content: 'X' },
    ]));
    (repaired._meta as Record<string, unknown>).tracking_review_required = true;
    const root = await tmpHub({ doks: { REPAIRED: repaired } });
    await writeSource(root, 'src/repaired.ts', 'X');
    const hub = await loadHubModel(root);
    expect(getDok(hub, root, 'REPAIRED').is_stale).toBe(true);
    expect(listDoksTool(hub, root, { stale: true }).doks.map((d) => d.dok_id)).toEqual(['REPAIRED']);
    expect(listDoksTool(hub, root, { stale: false }).doks).toEqual([]);
  });

  it('reports is_stale false when the anchor hash still matches disk', async () => {
    const content = 'export const a = 1;\n';
    const hash = computeLogicHash([{ file: 'src/a.ts', content }]);
    const root = await tmpHub({
      doks: { 'FRESH': hashedDok('FRESH', 'src/a.ts', hash) },
    });
    await writeSource(root, 'src/a.ts', content);
    const hub = await loadHubModel(root);
    expect(getDok(hub, root, 'FRESH').is_stale).toBe(false);
  });

  it('reports is_stale true when the anchor content changed since hashing', async () => {
    const original = 'export const a = 1;\n';
    const hash = computeLogicHash([{ file: 'src/a.ts', content: original }]);
    const root = await tmpHub({
      doks: { 'STALE': hashedDok('STALE', 'src/a.ts', hash) },
    });
    // Write DIFFERENT content than what was hashed → the recomputed hash drifts.
    await writeSource(root, 'src/a.ts', 'export const a = 2;\n');
    const hub = await loadHubModel(root);
    expect(getDok(hub, root, 'STALE').is_stale).toBe(true);
  });

  it("reports is_stale 'unknown' for a Dok with no logic_hash", async () => {
    const root = await tmpHub({ doks: { 'NOHASH': dok('NOHASH') } });
    const hub = await loadHubModel(root);
    expect(getDok(hub, root, 'NOHASH').is_stale).toBe('unknown');
  });

  it('list_doks stale filter partitions fresh / stale / no-hash', async () => {
    const freshContent = 'export const f = 1;\n';
    const freshHash = computeLogicHash([{ file: 'src/fresh.ts', content: freshContent }]);
    const staleHash = computeLogicHash([
      { file: 'src/stale.ts', content: 'export const s = 1;\n' },
    ]);
    const root = await tmpHub({
      doks: {
        'FRESH': hashedDok('FRESH', 'src/fresh.ts', freshHash),
        'STALE': hashedDok('STALE', 'src/stale.ts', staleHash),
        'NOHASH': dok('NOHASH'),
      },
    });
    await writeSource(root, 'src/fresh.ts', freshContent);
    // src/stale.ts on disk differs from what staleHash was computed over.
    await writeSource(root, 'src/stale.ts', 'export const s = 2;\n');
    const hub = await loadHubModel(root);

    const stale = listDoksTool(hub, root, { stale: true });
    expect(stale.doks.map((d) => d.dok_id)).toEqual(['STALE']);

    const fresh = listDoksTool(hub, root, { stale: false });
    expect(fresh.doks.map((d) => d.dok_id)).toEqual(['FRESH']);
    // NOHASH is 'unknown' → matches neither boolean filter.
  });

  it("resolves 'unknown' when the workspace root has no workspace.json", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'doklo-mcp-empty-'));
    // Unit-level: a hashed Dok, but no resolvable workspace → the resolver
    // degrades gracefully to 'unknown' rather than throwing.
    const orphan = hashedDok('ORPH', 'src/x.ts', 'somehash') as unknown as Dok;
    expect(resolveDokStaleness(orphan, emptyRoot)).toBe('unknown');
  });
});
