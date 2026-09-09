import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { computeLogicHash } from '@doklo-beta/core';
import {
  loadDok,
  listDoks,
  dokStaleness,
  printDok,
  DokNotFoundError,
} from '../src/commands/show.js';

async function tmpHubWith(dokFiles: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-show-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  for (const [id, content] of Object.entries(dokFiles)) {
    await writeFile(
      join(root, '.doklo/hub/doks', `${id}.json`),
      JSON.stringify(content),
      'utf-8',
    );
  }
  return root;
}

function dummyDok(dokId: string, name: string) {
  return {
    dok_id: dokId,
    name,
    status: 'active',
    tags: ['demo'],
    surfaces: ['web'],
    description: 'A test dok with enough description content to pass length checks.',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'system' },
          intent: 'Render',
          outcome: 'Rendered',
          variants: [{ platform: 'all', interaction: 'auto' }],
        },
      ],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
  };
}

// A Dok carrying drift metadata: source anchors + (optionally) the stored
// logic_hash they were generated from. Omit `logicHash` to model a Dok that
// never recorded one (drift undecidable → "unknown").
function dokWithAnchors(
  dokId: string,
  name: string,
  anchorFiles: string[],
  logicHash?: string,
) {
  return {
    ...dummyDok(dokId, name),
    _meta: {
      version: 1,
      history: [],
      source_anchors: anchorFiles.map((file) => ({ file })),
      ...(logicHash ? { logic_hash: logicHash, tracking_version: 2 } : {}),
    },
  };
}

// Capture console.log output produced by a synchronous renderer (printDok).
function capture(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('loadDok', () => {
  it('loads + validates a single Dok by id', async () => {
    const root = await tmpHubWith({ 'AUTH': dummyDok('AUTH', 'Sign in') });
    const dok = await loadDok({ root, dokId: 'AUTH' });
    expect(dok.dok_id).toBe('AUTH');
    expect(dok.name).toBe('Sign in');
  });

  it('throws DokNotFoundError when the id does not exist', async () => {
    const root = await tmpHubWith({});
    await expect(loadDok({ root, dokId: 'NOPE' })).rejects.toThrowError(
      DokNotFoundError,
    );
  });

  it('throws (with Zod message) when the file is schema-invalid', async () => {
    const root = await tmpHubWith({});
    await writeFile(
      join(root, '.doklo/hub/doks/BAD.json'),
      JSON.stringify({ dok_id: 'BAD' /* missing required fields */ }),
      'utf-8',
    );
    await expect(loadDok({ root, dokId: 'BAD' })).rejects.toThrow();
  });

  it('is case-insensitive on the id (UPPER preferred, but lowercase resolves)', async () => {
    const root = await tmpHubWith({ 'AUTH': dummyDok('AUTH', 'Sign in') });
    const dok = await loadDok({ root, dokId: 'auth' });
    expect(dok.dok_id).toBe('AUTH');
  });
});

describe('listDoks', () => {
  it('returns every Dok summary, sorted by dok_id', async () => {
    const root = await tmpHubWith({
      'USER': dummyDok('USER', 'Profile'),
      'AUTH': dummyDok('AUTH', 'Sign in'),
      'AUTH-SIGNUP': dummyDok('AUTH-SIGNUP', 'Sign up'),
    });
    const list = await listDoks({ root });
    expect(list.map((d) => d.dok_id)).toEqual(['AUTH', 'AUTH-SIGNUP', 'USER']);
    expect(list[0]).toMatchObject({ dok_id: 'AUTH', name: 'Sign in' });
  });

  it('returns empty array when no Doks exist', async () => {
    const root = await tmpHubWith({});
    const list = await listDoks({ root });
    expect(list).toEqual([]);
  });

  it('reports schema-invalid files in the result.problems array', async () => {
    const root = await tmpHubWith({ 'GOOD': dummyDok('GOOD', 'Good') });
    await writeFile(
      join(root, '.doklo/hub/doks/BAD.json'),
      JSON.stringify({ dok_id: 'BAD' }),
      'utf-8',
    );
    const list = await listDoks({ root });
    expect(list).toHaveLength(1);
    expect(list[0]?.dok_id).toBe('GOOD');
  });
});

describe('dokStaleness (freshness on `show`)', () => {
  it('is fresh when the anchor file still matches the stored logic hash', async () => {
    const content = 'export function signup() {\n  return true;\n}\n';
    const logicHash = computeLogicHash([{ file: 'src/auth.ts', content }]);
    const root = await tmpHubWith({
      'AUTH': dokWithAnchors('AUTH', 'Sign in', ['src/auth.ts'], logicHash),
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/auth.ts'), content, 'utf-8');

    const dok = await loadDok({ root, dokId: 'AUTH' });
    const staleness = await dokStaleness(root, dok);
    expect(staleness).toEqual({ stale: false });
    const out = capture(() => printDok(dok, chalk, staleness));
    expect(out).toContain('fresh');
    // "fresh" must not read as "this doc is correct" — the line states the
    // byte-identity claim it actually makes.
    expect(out).toContain('unchanged since generation');
    expect(out).toContain('not a proof the doc is correct');
  });

  it('is stale (changed) when the anchor file diverges from the stored hash', async () => {
    const original = 'export function signup() {\n  return true;\n}\n';
    const logicHash = computeLogicHash([{ file: 'src/auth.ts', content: original }]);
    const root = await tmpHubWith({
      'AUTH': dokWithAnchors('AUTH', 'Sign in', ['src/auth.ts'], logicHash),
    });
    await mkdir(join(root, 'src'), { recursive: true });
    // Edit the source in place after the hash was recorded → drift.
    await writeFile(join(root, 'src/auth.ts'), original + '// edited\n', 'utf-8');

    const dok = await loadDok({ root, dokId: 'AUTH' });
    const staleness = await dokStaleness(root, dok);
    expect(staleness).toEqual({ stale: true, reason: 'changed' });
    const out = capture(() => printDok(dok, chalk, staleness));
    expect(out).toContain('stale (changed)');
    // Stale must say which side wins and what to do about it.
    expect(out).toContain('trust the code over this doc');
    expect(out).toContain('doklo sync');
  });

  it('prints unknown instead of fresh for legacy source tracking', async () => {
    const root = await tmpHubWith({ 'AUTH': dokWithAnchors('AUTH', 'Sign in', ['src/auth.ts'], 'legacy-hash') });
    const dok = await loadDok({ root, dokId: 'AUTH' });
    delete dok._meta.tracking_version;
    const staleness = await dokStaleness(root, dok);
    expect(staleness).toEqual({ stale: false, reason: 'unverified-tracking' });
    const out = capture(() => printDok(dok, chalk, staleness));
    expect(out).toContain('unknown');
    expect(out).not.toContain('🟢 fresh');
  });

  it('is unknown when the Dok has no stored logic hash', async () => {
    const root = await tmpHubWith({ 'AUTH': dummyDok('AUTH', 'Sign in') });
    const dok = await loadDok({ root, dokId: 'AUTH' });
    const staleness = await dokStaleness(root, dok);
    expect(staleness).toEqual({ stale: false, reason: 'no-hash' });
    const out = capture(() => printDok(dok, chalk, staleness));
    expect(out).toContain('unknown');
    // Undecidable is actionable: say how to start tracking drift at all.
    expect(out).toContain('regenerate to start drift tracking');
  });
});
