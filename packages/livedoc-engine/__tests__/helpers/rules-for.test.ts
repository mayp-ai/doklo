import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/handlebars-setup.js';

function render(tpl: string, ctx: unknown): string {
  const hb = createEngine();
  return hb.compile(tpl)(ctx);
}

const RULES = [
  { id: 'BR-X-01', description: 'a', type: 'validation' },
  { id: 'BR-X-02', description: 'b', type: 'restriction' },
  { id: 'BR-X-03', description: 'c', type: 'policy' },
];

describe('rules_for helper', () => {
  it('resolves rule ids to rule objects, preserving id order', () => {
    const out = render(
      '{{#each (rules_for ids rules)}}{{this.type}},{{/each}}',
      { ids: ['BR-X-03', 'BR-X-01'], rules: RULES },
    );
    expect(out).toBe('policy,validation,');
  });

  it('skips ids with no matching rule', () => {
    const out = render(
      '{{len (rules_for ids rules)}}',
      { ids: ['BR-X-02', 'BR-MISSING'], rules: RULES },
    );
    expect(out).toBe('1');
  });

  it('returns empty array for non-array inputs', () => {
    expect(render('{{len (rules_for ids rules)}}', { ids: null, rules: RULES })).toBe('0');
    expect(render('{{len (rules_for ids rules)}}', { ids: ['BR-X-01'], rules: null })).toBe('0');
  });
});
