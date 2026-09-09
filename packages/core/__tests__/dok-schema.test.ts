import { describe, expect, it } from 'vitest';
import {
  DokHistoryCategorySchema,
  DokHistoryEntrySchema,
  DokHistoryKindSchema,
  DokMetaSchema,
  DokPendingChangeSchema,
  DokSchema,
} from '../src/schemas/dok.js';
import { DokIdSchema } from '../src/schemas/ids.js';

// Minimal Dok builder parametrized by dok_id and a single business rule id —
// used by the semantic-id grammar tests below, which only need to exercise
// the dok_id / rule-id cross-reference check, not the full validDok shape.
function makeMinimalDok({ dok_id, ruleId }: { dok_id: string; ruleId: string }) {
  return {
    dok_id,
    name: 'Test dok',
    description: 'A minimal dok for schema grammar tests.',
    business_rules: {
      rules: [{
        id: ruleId,
        description: 'A rule.',
        type: 'validation',
      }],
    },
  };
}

const validDok = {
  dok_id: 'AUTH-SIGNIN',
  name: 'Sign in',
  description: 'Users authenticate to enter the application.',
  business_rules: {
    rules: [{
      id: 'BR-AUTH-SIGNIN-01',
      description: 'The email must be valid.',
      type: 'validation',
    }],
  },
  acceptance_criteria: {
    criteria: [{
      id: 'AC-AUTH-SIGNIN-01',
      statement: 'A valid email is accepted.',
      related_rules: ['BR-AUTH-SIGNIN-01'],
    }],
  },
};

describe('Dok cross-reference invariants', () => {
  it('rejects a business rule whose ID belongs to another Dok', () => {
    expect(() => DokSchema.parse({
      ...validDok,
      business_rules: {
        rules: [{
          id: 'BR-OTHER-01',
          description: 'x',
          type: 'restriction',
        }],
      },
    })).toThrow(/RULE_ID_DOK_MISMATCH/);
  });

  it('rejects an acceptance criterion whose ID belongs to another Dok', () => {
    expect(() => DokSchema.parse({
      ...validDok,
      acceptance_criteria: {
        criteria: [{
          id: 'AC-OTHER-01',
          statement: 'x',
          related_rules: [],
        }],
      },
    })).toThrow(/AC_ID_DOK_MISMATCH/);
  });

  it('rejects duplicate rule IDs and unknown related rules', () => {
    expect(() => DokSchema.parse({
      ...validDok,
      business_rules: {
        rules: [
          { id: 'BR-AUTH-SIGNIN-01', description: 'x', type: 'restriction' },
          { id: 'BR-AUTH-SIGNIN-01', description: 'y', type: 'policy' },
        ],
      },
    })).toThrow(/DUPLICATE_RULE_ID/);

    expect(() => DokSchema.parse({
      ...validDok,
      acceptance_criteria: {
        criteria: [{
          id: 'AC-AUTH-SIGNIN-01',
          statement: 'x',
          related_rules: ['BR-AUTH-SIGNIN-99'],
        }],
      },
    })).toThrow(/UNKNOWN_RELATED_RULE/);
  });

  it('accepts valid Dok-local IDs and cross references', () => {
    expect(DokSchema.parse(validDok).dok_id).toBe('AUTH-SIGNIN');
  });
});

describe('semantic dok ids', () => {
  it('accepts 1-3 segment semantic ids with digits', () => {
    for (const id of ['HOME', 'AUTH-SIGNIN', 'AUTH-PASSWORD-RESET', 'OAUTH2-CALLBACK']) {
      expect(DokIdSchema.safeParse(id).success).toBe(true);
    }
  });
  it('rejects legacy serial ids and reserved first segments', () => {
    for (const id of ['AUTH-001', 'AUTH-SIGNIN-001', 'BR-SIGNIN', 'AC-CHECK', 'BR', 'A', 'auth-signin', 'AUTH-SIGNIN-OTP-MORE']) {
      expect(DokIdSchema.safeParse(id).success).toBe(false);
    }
  });
  it('rejects a BR id that belongs to a longer sibling dok id', () => {
    // Dok AUTH must NOT accept BR-AUTH-SIGNIN-01 (belongs to AUTH-SIGNIN)
    const dok = makeMinimalDok({ dok_id: 'AUTH', ruleId: 'BR-AUTH-SIGNIN-01' });
    expect(DokSchema.safeParse(dok).success).toBe(false);
  });
  it('accepts BR/AC ids exactly of form BR-{dok_id}-NN', () => {
    const dok = makeMinimalDok({ dok_id: 'AUTH-SIGNIN', ruleId: 'BR-AUTH-SIGNIN-01' });
    expect(DokSchema.safeParse(dok).success).toBe(true);
  });
});

describe('DokHistoryEntrySchema v2 (optional kind/from/to/category)', () => {
  it('parses a legacy hand-written entry without kind and keeps unknown keys', () => {
    const parsed = DokHistoryEntrySchema.parse({
      version: 1, date: '2026-05-10', change: 'Initial', author: 'PM-jin', future_key: 'keep',
    });
    expect(parsed.kind).toBeUndefined();
    expect((parsed as Record<string, unknown>)['future_key']).toBe('keep');
  });

  it('parses a v2 status entry and rejects unknown kinds/categories', () => {
    const entry = DokHistoryEntrySchema.parse({
      version: 3, date: '2026-08-16', change: 'Activated', kind: 'status', from: 'draft', to: 'active',
    });
    expect(entry).toMatchObject({ kind: 'status', from: 'draft', to: 'active' });
    expect(DokHistoryEntrySchema.safeParse({ version: 1, date: 'x', change: 'y', kind: 'nope' }).success).toBe(false);
    expect(DokHistoryEntrySchema.safeParse({ version: 1, date: 'x', change: 'y', category: 'nope' }).success).toBe(false);
    expect(DokHistoryKindSchema.options).toEqual(['edited', 'status', 'regenerated', 'baseline']);
    expect(DokHistoryCategorySchema.options).toEqual(['added', 'changed', 'deprecated', 'removed', 'fixed', 'security']);
  });
});

describe('DokPendingChangeSchema (_meta.pending_change)', () => {
  it('parses a staged proposal and rejects unknown sources or empty summaries', () => {
    const meta = DokMetaSchema.parse({
      version: 2,
      history: [],
      pending_change: {
        summary: 'Updated the description; added 1 step.',
        source: 'diff',
        base_version: 1,
        previous_status: 'active',
      },
    });
    expect(meta.pending_change).toMatchObject({ source: 'diff', base_version: 1, previous_status: 'active' });
    expect(DokPendingChangeSchema.safeParse({ summary: '', source: 'diff', base_version: 1, previous_status: 'active' }).success).toBe(false);
    expect(DokPendingChangeSchema.safeParse({ summary: 'x', source: 'oracle', base_version: 1, previous_status: 'active' }).success).toBe(false);
    expect(DokPendingChangeSchema.parse({
      summary: 'PR #7', source: 'human', base_version: 3, previous_status: 'draft', category: 'added',
    }).category).toBe('added');
  });

  it('stays optional: a meta without pending_change round-trips unchanged', () => {
    const meta = DokMetaSchema.parse({ version: 1, history: [] });
    expect('pending_change' in meta).toBe(false);
  });
});
