import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConsolidated, listConsolidatedServices } from '../lib/data';

const DEMO = fileURLToPath(new URL('../demo', import.meta.url));
const original = process.env.DOKLO_WORKSPACE_ROOT;
afterEach(() => {
  if (original === undefined) delete process.env.DOKLO_WORKSPACE_ROOT;
  else process.env.DOKLO_WORKSPACE_ROOT = original;
});

describe('consolidated loaders', () => {
  it('lists services with a consolidated cache', async () => {
    process.env.DOKLO_WORKSPACE_ROOT = DEMO;
    expect(await listConsolidatedServices()).toContain('web');
  });
  it('loads and validates the web consolidated config', async () => {
    process.env.DOKLO_WORKSPACE_ROOT = DEMO;
    const cfg = await loadConsolidated('web');
    expect(cfg?.groups.length).toBe(4);
    expect(cfg?.groups.find((g) => g.group_id === 'order')?.features[0].decision).toBe('merge');
  });
  it('returns null for a service with no cache', async () => {
    process.env.DOKLO_WORKSPACE_ROOT = DEMO;
    expect(await loadConsolidated('api')).toBeNull();
  });
});
