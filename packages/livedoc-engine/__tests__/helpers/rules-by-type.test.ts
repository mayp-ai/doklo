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

const doks: Dok[] = [
  dok({ dok_id: 'A', business_rules: { rules: [
    { id: 'BR-A-1', type: 'permission', description: 'admin only' },
    { id: 'BR-A-2', type: 'restriction', description: 'max 5' },
  ] } }),
  dok({ dok_id: 'B', business_rules: { rules: [
    { id: 'BR-B-1', type: 'permission', description: 'owner only' },
    { id: 'BR-B-2', type: 'policy', description: 'soft delete' },
  ] } }),
  dok({ dok_id: 'OLD', status: 'archived', business_rules: { rules: [
    { id: 'BR-OLD-1', type: 'permission', description: 'ignored' },
  ] } }),
];

describe('rules_by_type', () => {
  it('flattens permission rules across active Doks with Dok context', () => {
    const out = render('{{#each (rules_by_type doks "permission")}}{{this.dok_id}}:{{this.rule.id}};{{/each}}', { doks });
    expect(out).toBe('A:BR-A-1;B:BR-B-1;');
  });
  it('counts via len', () => {
    expect(render('{{len (rules_by_type doks "restriction")}}', { doks })).toBe('1');
    expect(render('{{len (rules_by_type doks "policy")}}', { doks })).toBe('1');
  });
  it('excludes archived Doks', () => {
    const out = render('{{#each (rules_by_type doks "permission")}}{{this.dok_id}},{{/each}}', { doks });
    expect(out).not.toContain('OLD');
  });
  it('returns empty for unknown type', () => {
    expect(render('{{len (rules_by_type doks "nope")}}', { doks })).toBe('0');
  });
});
