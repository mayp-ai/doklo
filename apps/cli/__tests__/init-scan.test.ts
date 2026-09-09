import { describe, it, expect } from 'vitest';
import { postInitScan } from '../src/commands/init.js';

describe('postInitScan', () => {
  it('aggregates scan counts across services', async () => {
    const fakeRunScan = async () => ({
      results: [
        { serviceId: 'web', counts: { routes: 5, components: 3, stores: 1 } },
        { serviceId: 'api', counts: { routes: 2, components: 0, stores: 0 } },
      ],
      skipped: [],
    });
    const summary = await postInitScan('/tmp/whatever', { runScan: fakeRunScan as never });
    expect(summary).toEqual({ services: 2, routes: 7, components: 3 });
  });

  it('returns null (best-effort) when scan throws — never fails init', async () => {
    const boom = async () => {
      throw new Error('unparseable project');
    };
    const summary = await postInitScan('/tmp/whatever', { runScan: boom as never });
    expect(summary).toBeNull();
  });
});
