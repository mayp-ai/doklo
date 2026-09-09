import { describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { selectDoks } from '../src/selector.js';

function dok(over: Partial<Dok>): Dok {
  return {
    dok_id: 'DOK-X',
    name: 'x',
    status: 'active',
    tags: [],
    surfaces: [],
    description: 'x',
    _meta: { version: 1, history: [] },
    ...over,
  };
}

const doks: Dok[] = [
  dok({ dok_id: 'AUTH', tags: ['tutorial', 'auth'], surfaces: ['web'], status: 'active' }),
  dok({ dok_id: 'BILL', tags: ['payment'], surfaces: ['api'], status: 'active' }),
  dok({ dok_id: 'INT', tags: ['internal'], surfaces: ['admin'], status: 'planned' }),
  dok({ dok_id: 'OLD', tags: ['tutorial'], surfaces: ['web'], status: 'archived' }),
];

describe('selectDoks', () => {
  it('returns all when selector is empty', () => {
    expect(selectDoks(doks, {})).toHaveLength(4);
  });

  it('filters by include_tags (OR within array)', () => {
    const r = selectDoks(doks, { include_tags: ['tutorial'] });
    expect(r.map((d) => d.dok_id).sort()).toEqual(['AUTH', 'OLD']);
  });

  it('filters by include_services', () => {
    const r = selectDoks(doks, { include_services: ['web'] });
    expect(r.map((d) => d.dok_id).sort()).toEqual(['AUTH', 'OLD']);
  });

  it('filters by include_statuses', () => {
    const r = selectDoks(doks, { include_statuses: ['active'] });
    expect(r.map((d) => d.dok_id).sort()).toEqual(['AUTH', 'BILL']);
  });

  it('AND across categories', () => {
    const r = selectDoks(doks, {
      include_tags: ['tutorial'],
      include_statuses: ['active'],
    });
    expect(r.map((d) => d.dok_id)).toEqual(['AUTH']);
  });

  it('exclude_tags removes matching', () => {
    const r = selectDoks(doks, {
      include_tags: ['tutorial'],
      exclude_tags: ['internal'],
    });
    expect(r.map((d) => d.dok_id).sort()).toEqual(['AUTH', 'OLD']);
  });

  it('explicit_ids are unconditional and bypass exclude_tags', () => {
    const r = selectDoks(doks, {
      include_tags: ['nonexistent'],
      exclude_tags: ['internal'],
      explicit_ids: ['INT'],
    });
    expect(r.map((d) => d.dok_id)).toEqual(['INT']);
  });

  it('explicit_ids bypass status filter too', () => {
    const r = selectDoks(doks, {
      include_statuses: ['active'],
      explicit_ids: ['OLD'],
    });
    expect(r.map((d) => d.dok_id).sort()).toEqual(['AUTH', 'BILL', 'OLD']);
  });

  it('deduplicates when explicit_id overlaps with filter match', () => {
    const r = selectDoks(doks, {
      include_tags: ['tutorial'],
      explicit_ids: ['AUTH'],
    });
    const ids = r.map((d) => d.dok_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns empty when no Dok matches and no explicit_ids', () => {
    const r = selectDoks(doks, { include_tags: ['nonexistent'] });
    expect(r).toEqual([]);
  });
});
