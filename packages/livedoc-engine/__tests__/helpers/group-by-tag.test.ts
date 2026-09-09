import { describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { createEngine } from '../../src/handlebars-setup.js';

function dok(over: Partial<Dok>): Dok {
  return {
    dok_id: 'X', name: 'x', status: 'active', tags: [], surfaces: [],
    description: 'x', _meta: { version: 1, history: [] }, ...over,
  };
}

function render(tpl: string, ctx: unknown) {
  return createEngine().compile(tpl)(ctx);
}

describe('group_doks_by_primary_tag', () => {
  it('groups by first tag; each Dok appears once', () => {
    const doks = [
      dok({ dok_id: 'A', tags: ['ui', 'web'] }),
      dok({ dok_id: 'B', tags: ['ui'] }),
      dok({ dok_id: 'C', tags: ['api'] }),
    ];
    const out = render(
      '{{#each (group_doks_by_primary_tag doks)}}{{this.tag}}={{len this.doks}};{{/each}}',
      { doks },
    );
    // ui has 2, api has 1 → sorted by count desc
    expect(out).toBe('ui=2;api=1;');
  });

  it("falls under 'untagged' when Dok has no tags", () => {
    const doks = [dok({ dok_id: 'A' })];
    const out = render(
      '{{#each (group_doks_by_primary_tag doks)}}{{this.tag}}{{/each}}',
      { doks },
    );
    expect(out).toBe('untagged');
  });

  it('excludes archived Doks', () => {
    const doks = [
      dok({ dok_id: 'A', tags: ['a'], status: 'active' }),
      dok({ dok_id: 'B', tags: ['a'], status: 'archived' }),
    ];
    const out = render(
      '{{#each (group_doks_by_primary_tag doks)}}{{this.tag}}={{len this.doks}}{{/each}}',
      { doks },
    );
    expect(out).toBe('a=1');
  });
});

describe('limit helper', () => {
  it('slices to first N', () => {
    expect(render('{{#each (limit arr 2)}}{{this}},{{/each}}', { arr: [1, 2, 3, 4] })).toBe('1,2,');
  });
  it('passes through when N>=length', () => {
    expect(render('{{#each (limit arr 10)}}{{this}},{{/each}}', { arr: [1, 2] })).toBe('1,2,');
  });
});

describe('filter_active_with_steps', () => {
  it('keeps active doks that have user_actions.steps', () => {
    const doks = [
      dok({ dok_id: 'A', user_actions: { steps: [{ order: 1, actor: { kind: 'system' }, intent: 'i', outcome: 'o', variants: [] }] } }),
      dok({ dok_id: 'B' }),
      dok({ dok_id: 'C', status: 'deprecated', user_actions: { steps: [{ order: 1, actor: { kind: 'system' }, intent: 'i', outcome: 'o', variants: [] }] } }),
    ];
    const out = render(
      '{{#each (filter_active_with_steps doks)}}{{this.dok_id}};{{/each}}',
      { doks },
    );
    expect(out).toBe('A;');
  });
});
