// models.dev registry: model metadata (cost, limits, capabilities) keyed by
// 'provider/model'. Cached locally; never required at call time for the
// model to work — only for pricing and weak-model signals.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const API_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelCost {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}
export interface ModelLimit {
  context: number;
  output: number;
}
export interface ModelInfo {
  id: string;
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input: string[]; output: string[] };
  limit?: ModelLimit;
  cost?: ModelCost;
  release_date?: string;
  last_updated?: string;
}
export interface ProviderInfo {
  id: string;
  name: string;
  env: string[];
  npm?: string;
  doc?: string;
  models: Record<string, ModelInfo>;
}
export type ModelsDb = Record<string, ProviderInfo>;

export interface LoadModelsOptions {
  force?: boolean;
  cacheFile?: string;
  fetchImpl?: typeof fetch;
}

function defaultCacheFile(): string {
  const base = process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
  return join(base, 'doklo', 'models.json');
}

interface CachedModelsDb {
  db: ModelsDb;
  ageMs: number;
}

/** The cache as it is on disk, however old. Null when it is absent or
 *  unusable — either way there is nothing to fall back to. */
async function readCache(cacheFile: string): Promise<CachedModelsDb | null> {
  try {
    const stat = await fs.stat(cacheFile);
    const db = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as ModelsDb;
    return { db, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

export async function loadModelsDb(opts: LoadModelsOptions = {}): Promise<ModelsDb> {
  const cacheFile = opts.cacheFile ?? defaultCacheFile();
  const doFetch = opts.fetchImpl ?? fetch;

  const cached = await readCache(cacheFile);
  if (!opts.force && cached !== null && cached.ageMs < TTL_MS) return cached.db;

  try {
    const res = await doFetch(API_URL);
    if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
    const db = (await res.json()) as ModelsDb;
    await fs.mkdir(join(cacheFile, '..'), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(db), 'utf8');
    return db;
  } catch (error) {
    // Registry data is advisory — pricing, limits and weak-model hints. A
    // model works without it, so an expired copy is worth far more than a
    // failed command. Only a total absence of data is worth reporting.
    if (cached !== null) return cached.db;
    throw error;
  }
}

/** ref = 'provider/model', split on the FIRST slash. */
export function lookupModel(db: ModelsDb, ref: string): ModelInfo | undefined {
  const slash = ref.indexOf('/');
  if (slash < 0) return undefined;
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  return db[provider]?.models[model];
}

export function getCost(db: ModelsDb, ref: string): ModelCost | undefined {
  return lookupModel(db, ref)?.cost;
}

export function getLimit(db: ModelsDb, ref: string): ModelLimit | undefined {
  return lookupModel(db, ref)?.limit;
}
