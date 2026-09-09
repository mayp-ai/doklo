import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/handlebars-setup.js';

function render(tpl: string, ctx: unknown): string {
  const hb = createEngine();
  return hb.compile(tpl)(ctx);
}

const DOKS = [
  {
    dok_id: 'A-001',
    name: 'Alpha',
    status: 'active',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'role', role_ref: 'ROLE-USER' },
          intent: 'i1',
          outcome: 'o1',
          variants: [
            { platform: 'desktop', interaction: 'click' },
            { platform: 'mobile', interaction: 'tap' },
          ],
        },
        {
          order: 2,
          actor: { kind: 'system' },
          intent: 'i2',
          outcome: 'o2',
          variants: [{ platform: 'all', interaction: 'auto' }],
        },
      ],
    },
    business_rules: {
      rules: [
        { id: 'BR-A-01', description: 'r1', type: 'permission', applies_to_roles: ['ROLE-ADMIN'] },
        { id: 'BR-A-02', description: 'r2', type: 'validation', applies_to_roles: ['ROLE-USER'] },
      ],
    },
    acceptance_criteria: {
      criteria: [
        { id: 'AC-A-01', statement: 's1', related_rules: ['BR-A-02'] },
        { id: 'AC-A-02', statement: 's2', related_rules: [] },
      ],
    },
    _meta: { version: 1, history: [], source_anchors: [{ file: 'src/a.ts' }, { file: 'src/shared.ts' }] },
  },
  {
    dok_id: 'B-001',
    name: 'Beta',
    status: 'active',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'role', role_ref: 'ROLE-ADMIN' },
          intent: 'i1',
          outcome: 'o1',
          variants: [{ platform: 'desktop', interaction: 'click' }],
        },
      ],
    },
    business_rules: { rules: [] },
    acceptance_criteria: {
      criteria: [{ id: 'AC-B-01', statement: 's', related_rules: [] }],
    },
    _meta: { version: 1, history: [], source_anchors: [{ file: 'src/shared.ts' }] },
  },
];

const ROLES = [
  { role_id: 'ROLE-ADMIN', name: 'Admin', extends: [], scope: 'global' },
  { role_id: 'ROLE-USER', name: 'User', extends: [], scope: 'global' },
];

describe('invert_anchors helper', () => {
  it('groups doks by shared source file, sorted by path', () => {
    const out = render(
      '{{#each (invert_anchors doks)}}{{this.file}}={{#each this.doks}}{{this.dok_id}},{{/each}};{{/each}}',
      { doks: DOKS },
    );
    expect(out).toBe('src/a.ts=A-001,;src/shared.ts=A-001,B-001,;');
  });

  it('exposes aggregate rule/ac counts per file', () => {
    const out = render(
      '{{#each (invert_anchors doks)}}{{this.file}}:{{this.rule_count}}/{{this.ac_count}};{{/each}}',
      { doks: DOKS },
    );
    expect(out).toBe('src/a.ts:2/2;src/shared.ts:2/3;');
  });

  it('returns empty for doks without anchors', () => {
    const bare = [{ dok_id: 'X', _meta: { version: 1, history: [] } }];
    expect(render('{{len (invert_anchors doks)}}', { doks: bare })).toBe('0');
  });
});

describe('expand_acs helper', () => {
  it('flattens one row per acceptance criterion with resolved rules', () => {
    const out = render(
      '{{#each (expand_acs doks)}}{{this.dok.dok_id}}/{{this.criterion.id}}/{{len this.rules}};{{/each}}',
      { doks: DOKS },
    );
    expect(out).toBe('A-001/AC-A-01/1;A-001/AC-A-02/0;B-001/AC-B-01/0;');
  });
});

describe('role_matrix helper', () => {
  it('builds dok × role cells with step and rule counts', () => {
    const out = render(
      '{{#each (role_matrix doks roles)}}{{this.dok.dok_id}}:{{#each this.cells}}{{this.role_id}}=s{{this.step_count}}r{{this.rule_count}},{{/each}};{{/each}}',
      { doks: DOKS, roles: ROLES },
    );
    expect(out).toBe(
      'A-001:ROLE-ADMIN=s0r1,ROLE-USER=s1r1,;B-001:ROLE-ADMIN=s1r0,ROLE-USER=s0r0,;',
    );
  });
});

describe('doks_without_rule_type helper', () => {
  it('returns active doks lacking any rule of the given type', () => {
    const doks = [
      ...DOKS, // A-001 has permission rule; B-001 has none
      { dok_id: 'C-001', status: 'planned', business_rules: { rules: [] } },
    ];
    const out = render(
      '{{#each (doks_without_rule_type doks "permission")}}{{this.dok_id}},{{/each}}',
      { doks },
    );
    // B-001: active without permission rules. C-001 excluded (not active).
    expect(out).toBe('B-001,');
  });
});

describe('where_status helper', () => {
  it('filters doks by status', () => {
    const doks = [...DOKS, { dok_id: 'C-001', status: 'planned' }];
    expect(render('{{len (where_status doks "active")}}', { doks })).toBe('2');
    expect(render('{{len (where_status doks "planned")}}', { doks })).toBe('1');
  });
});

describe('rule_types helper', () => {
  it('returns unique rule types in first-appearance order', () => {
    const rules = [
      { id: 'r1', description: '', type: 'validation' },
      { id: 'r2', description: '', type: 'permission' },
      { id: 'r3', description: '', type: 'validation' },
    ];
    expect(render('{{join (rule_types rules) "+"}}', { rules })).toBe('validation+permission');
    expect(render('{{len (rule_types rules)}}', { rules: null })).toBe('0');
  });
});

describe('doks_for_role helper', () => {
  it('keeps doks where the role acts in a step or rules apply to it', () => {
    const out = render(
      '{{#each (doks_for_role doks "ROLE-ADMIN")}}{{this.dok_id}},{{/each}}',
      { doks: DOKS },
    );
    // A-001: permission rule applies_to_roles ROLE-ADMIN; B-001: ROLE-ADMIN actor step
    expect(out).toBe('A-001,B-001,');
  });

  it('filters out doks with no relation to the role', () => {
    const out = render(
      '{{#each (doks_for_role doks "ROLE-MENTOR")}}{{this.dok_id}},{{/each}}',
      { doks: DOKS },
    );
    expect(out).toBe('');
  });
});

describe('variant_matrix helper', () => {
  it('lists platform coverage per user step and flags missing platforms', () => {
    const out = render(
      '{{#with (variant_matrix doks)}}{{join this.platforms "+"}}|{{#each this.rows}}{{this.dok.dok_id}}#{{this.step.order}}miss:{{join this.missing ","}};{{/each}}{{/with}}',
      { doks: DOKS },
    );
    // platform universe from role-actor steps only: desktop, mobile
    expect(out).toBe('desktop+mobile|A-001#1miss:;B-001#1miss:mobile;');
  });
});
