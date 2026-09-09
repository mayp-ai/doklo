import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadHubModel, MissingHubError } from '../../src/hub/loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (name: string) => join(here, 'fixtures', name);

describe('loadHubModel', () => {
  it('loads a per-Dok layout workspace', async () => {
    const hub = await loadHubModel(fix('per-dok'));
    expect(hub.layout).toBe('per-dok');
    expect(hub.workspace.workspace_id).toBe('test-ws');
    expect(hub.doks).toHaveLength(1);
    expect(hub.doks[0].dok_id).toBe('AUTH-SIGNIN');
    expect(hub.doks[0].tags).toEqual(['tutorial', 'auth']);
  });

  it('loads a legacy single-array layout workspace', async () => {
    const hub = await loadHubModel(fix('legacy'));
    expect(hub.layout).toBe('legacy');
    expect(hub.doks).toHaveLength(1);
    expect(hub.doks[0].dok_id).toBe('BILL-CHARGE');
  });

  it('loads per-service IA slices when present', async () => {
    const hub = await loadHubModel(fix('with-services'));
    expect(hub.services).toHaveLength(1);
    expect(hub.services[0].service_id).toBe('web');
    expect(hub.services[0].ia?.version).toBe(1);
    expect(hub.services[0].ia?.trees).toHaveLength(1);
    expect(hub.services[0].ia?.trees[0].tree_id).toBe('nav-desktop');
  });

  it('loads a v2 per-service IA slice without migrating it', async () => {
    const hub = await loadHubModel(fix('with-services-v2'));
    expect(hub.services).toHaveLength(1);
    expect(hub.services[0].service_id).toBe('web');
    expect(hub.services[0].ia?.version).toBe(2);
    expect(hub.services[0].ia?.trees).toHaveLength(1);
    expect(hub.services[0].ia?.trees[0].tree_id).toBe('web-routes');
  });

  it('drops an ia.json that satisfies neither contract, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hub = await loadHubModel(fix('bad-ia'));
      expect(hub.services).toHaveLength(1);
      expect(hub.services[0].service_id).toBe('web');
      expect(hub.services[0].ia).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ia.json'));
    } finally {
      warn.mockRestore();
    }
  });

  it('returns empty defaults when lexicon/roles are absent', async () => {
    const hub = await loadHubModel(fix('per-dok'));
    expect(hub.lexicon.terms).toEqual([]);
    expect(hub.roles.roles).toEqual([]);
  });

  it('throws MissingHubError when workspace.json is missing', async () => {
    await expect(loadHubModel(fix('no-workspace'))).rejects.toBeInstanceOf(MissingHubError);
  });

  it('respects preferLayout=legacy even when per-Dok dir would exist', async () => {
    // per-dok fixture has no legacy doks.json — loader returns []
    const hub = await loadHubModel(fix('per-dok'), { preferLayout: 'legacy' });
    expect(hub.layout).toBe('legacy');
    expect(hub.doks).toEqual([]);
  });

  it('raises a dedicated error for legacy -NNN dok files', async () => {
    // fixture: .doklo/hub/doks/AUTH-001.json — pre-migration numbered Dok ID
    await expect(loadHubModel(fix('legacy-numbered'))).rejects.toThrow(
      /legacy numbered Dok ID scheme/i,
    );
  });
});
