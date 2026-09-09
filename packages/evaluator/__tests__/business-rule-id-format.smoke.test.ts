import { describe, it, expect } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { businessRuleIdFormat } from '../src/criteria/business-rule-id-format.js';
import type { EvalInput } from '../src/types.js';

function makeDok(dokId: string, extra: Partial<Dok> = {}): Dok {
  return {
    dok_id: dokId,
    name: 'Test',
    status: 'draft',
    tags: [],
    surfaces: [],
    description: 'A description.',
    _meta: { version: 1, history: [] },
    ...extra,
  } as Dok;
}

describe('business-rule-id-format', () => {
  it('passes when BR/AC ids embed their own dok_id', () => {
    const dok = makeDok('AUTH-SIGNIN', {
      business_rules: {
        rules: [{ id: 'BR-AUTH-SIGNIN-01', description: 'rule', type: 'validation' }],
      },
      acceptance_criteria: {
        criteria: [
          { id: 'AC-AUTH-SIGNIN-01', statement: 'ac', related_rules: ['BR-AUTH-SIGNIN-01'] },
        ],
      },
    });
    const input: EvalInput = { doks: [dok] };
    expect(businessRuleIdFormat.evaluate(input)).toEqual([]);
  });

  // Sibling ambiguity: dok_id 'AUTH' is a string-prefix of the sibling
  // dok_id 'AUTH-SIGNIN'. A BR/AC id embedding the SIBLING's id
  // (BR-AUTH-SIGNIN-01) must not be accepted as belonging to 'AUTH' just
  // because it starts with 'BR-AUTH-' — the tail after that prefix has to
  // be exactly the 2-digit serial, not another dok_id segment. This is the
  // same ambiguity Task 1 fixed in packages/core/src/schemas/dok.ts's
  // superRefine (exact-tail `^\d{2}$` check instead of bare startsWith).

  it('flags a BR id that structurally belongs to a sibling dok, despite starting with this dok_id + "-"', () => {
    const dok = makeDok('AUTH', {
      business_rules: {
        rules: [{ id: 'BR-AUTH-SIGNIN-01', description: 'rule', type: 'validation' }],
      },
    });
    const input: EvalInput = { doks: [dok] };
    const violations = businessRuleIdFormat.evaluate(input) as Awaited<
      ReturnType<typeof businessRuleIdFormat.evaluate>
    >;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("does not embed dok_id 'AUTH'");
  });

  it('flags an AC id that structurally belongs to a sibling dok, despite starting with this dok_id + "-"', () => {
    const dok = makeDok('AUTH', {
      acceptance_criteria: {
        criteria: [{ id: 'AC-AUTH-SIGNIN-01', statement: 'ac', related_rules: [] }],
      },
    });
    const input: EvalInput = { doks: [dok] };
    const violations = businessRuleIdFormat.evaluate(input) as Awaited<
      ReturnType<typeof businessRuleIdFormat.evaluate>
    >;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("does not embed dok_id 'AUTH'");
  });

  it('does not false-positive when the dok_id and BR id genuinely match past the shared prefix', () => {
    // 'AUTH-SIGNIN' vs a rule under a same-prefixed but distinct sibling
    // 'AUTH-SIGNUP' must still be flagged (they are different doks) —
    // this just pins that the exact-tail check does not over-match either.
    const dok = makeDok('AUTH-SIGNIN', {
      business_rules: {
        rules: [{ id: 'BR-AUTH-SIGNUP-01', description: 'rule', type: 'validation' }],
      },
    });
    const input: EvalInput = { doks: [dok] };
    const violations = businessRuleIdFormat.evaluate(input) as Awaited<
      ReturnType<typeof businessRuleIdFormat.evaluate>
    >;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("does not embed dok_id 'AUTH-SIGNIN'");
  });

  it('autoFix rebuilds ids from the dok_id, preserving order and related_rules pointers', () => {
    const dok = makeDok('AUTH-SIGNIN', {
      business_rules: {
        rules: [
          { id: 'BR-WRONG-01', description: 'r1', type: 'validation' },
          { id: 'BR-WRONG-02', description: 'r2', type: 'policy' },
        ],
      },
      acceptance_criteria: {
        criteria: [{ id: 'AC-WRONG-01', statement: 'ac', related_rules: ['BR-WRONG-01'] }],
      },
    });
    const input: EvalInput = { doks: [dok] };
    const violations = businessRuleIdFormat.evaluate(input) as Awaited<
      ReturnType<typeof businessRuleIdFormat.evaluate>
    >;
    const patch = businessRuleIdFormat.autoFix!(violations, input);
    const fixed = patch.doks[0]!;
    expect(fixed.business_rules?.rules.map((r) => r.id)).toEqual([
      'BR-AUTH-SIGNIN-01',
      'BR-AUTH-SIGNIN-02',
    ]);
    const ac = fixed.acceptance_criteria?.criteria[0]!;
    expect(ac.id).toBe('AC-AUTH-SIGNIN-01');
    expect(ac.related_rules).toEqual(['BR-AUTH-SIGNIN-01']);
  });
});
