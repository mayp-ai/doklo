// packages/generator/__tests__/models-registry.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lookupModel,
  getCost,
  getLimit,
  loadModelsDb,
  type ModelsDb,
} from '../src/models-registry.js';

const DB: ModelsDb = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    models: { 'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' } }, // no cost/limit
  },
};

describe('lookupModel', () => {
  it('splits provider/model on the first slash', () => {
    expect(lookupModel(DB, 'anthropic/claude-sonnet-4-5')?.name).toBe('Claude Sonnet 4.5');
  });
  it('returns undefined for unknown provider or model', () => {
    expect(lookupModel(DB, 'nope/x')).toBeUndefined();
    expect(lookupModel(DB, 'anthropic/nope')).toBeUndefined();
    expect(lookupModel(DB, 'no-slash')).toBeUndefined();
  });
});

describe('getCost / getLimit', () => {
  it('reads cost and limit when present', () => {
    expect(getCost(DB, 'anthropic/claude-sonnet-4-5')).toEqual({
      input: 3, output: 15, cache_read: 0.3, cache_write: 3.75,
    });
    expect(getLimit(DB, 'anthropic/claude-sonnet-4-5')).toEqual({ context: 200000, output: 64000 });
  });
  it('returns undefined when the model has no cost/limit', () => {
    expect(getCost(DB, 'openai/gpt-4o')).toBeUndefined();
    expect(getLimit(DB, 'openai/gpt-4o')).toBeUndefined();
  });
});

describe('loadModelsDb', () => {
  it('reads a fresh cache file without fetching', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-models-'));
    const cacheFile = join(dir, 'models.json');
    await writeFile(cacheFile, JSON.stringify(DB), 'utf8');
    let fetched = false;
    const db = await loadModelsDb({
      cacheFile,
      fetchImpl: (async () => { fetched = true; return new Response('{}'); }) as typeof fetch,
    });
    expect(fetched).toBe(false);
    expect(db.anthropic?.name).toBe('Anthropic');
  });

  it('fetches and writes the cache on a miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-models-'));
    const cacheFile = join(dir, 'sub', 'models.json'); // dir does not exist yet
    const db = await loadModelsDb({
      cacheFile,
      fetchImpl: (async () => new Response(JSON.stringify(DB), { status: 200 })) as typeof fetch,
    });
    expect(db.openai?.name).toBe('OpenAI');
  });
});

describe('loadModelsDb offline resilience', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** A cache file whose mtime is older than the registry TTL. */
  async function staleCache(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-models-stale-'));
    const cacheFile = join(dir, 'models.json');
    await writeFile(cacheFile, JSON.stringify(DB), 'utf8');
    const old = new Date(Date.now() - 3 * DAY_MS);
    await utimes(cacheFile, old, old);
    return cacheFile;
  }

  const offline = (async () => {
    throw new Error('fetch failed: getaddrinfo ENOTFOUND models.dev');
  }) as unknown as typeof fetch;

  it('serves a stale cache when the refresh cannot reach the registry', async () => {
    const cacheFile = await staleCache();

    const db = await loadModelsDb({ cacheFile, fetchImpl: offline });

    expect(db.anthropic?.name).toBe('Anthropic');
  });

  it('serves a stale cache when the registry answers with an error status', async () => {
    const cacheFile = await staleCache();

    const db = await loadModelsDb({
      cacheFile,
      fetchImpl: (async () => new Response('nope', { status: 503 })) as typeof fetch,
    });

    expect(db.openai?.name).toBe('OpenAI');
  });

  it('serves a stale cache when the registry answers with unparseable content', async () => {
    const cacheFile = await staleCache();

    const db = await loadModelsDb({
      cacheFile,
      fetchImpl: (async () => new Response('<html>captive portal</html>', { status: 200 })) as typeof fetch,
    });

    expect(db.anthropic?.name).toBe('Anthropic');
  });

  it('still refreshes and rewrites a stale cache when the registry answers', async () => {
    const cacheFile = await staleCache();
    const fresher: ModelsDb = {
      anthropic: { id: 'anthropic', name: 'Anthropic (refreshed)', env: [], models: {} },
    };

    const db = await loadModelsDb({
      cacheFile,
      fetchImpl: (async () => new Response(JSON.stringify(fresher), { status: 200 })) as typeof fetch,
    });

    expect(db.anthropic?.name).toBe('Anthropic (refreshed)');
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual(fresher);
  });

  it('honours `force` by preferring the network, then falling back to the cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-models-force-'));
    const cacheFile = join(dir, 'models.json');
    await writeFile(cacheFile, JSON.stringify(DB), 'utf8');

    const db = await loadModelsDb({ cacheFile, force: true, fetchImpl: offline });

    expect(db.anthropic?.name).toBe('Anthropic');
  });

  it('surfaces the failure when there is no cache to fall back to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-models-none-'));

    await expect(
      loadModelsDb({ cacheFile: join(dir, 'models.json'), fetchImpl: offline }),
    ).rejects.toThrow(/ENOTFOUND|models\.dev/);
  });
});
