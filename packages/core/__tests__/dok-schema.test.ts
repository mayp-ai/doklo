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
import { SourceAnchorSchema } from '../src/schemas/code-anchor.js';

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

// Judge-gated sync design §6: three optional facts, stamped at generation. Old
// files carry none of them and must keep parsing exactly as before.
describe('drift baseline facts (_meta.logic_hash_normalized, _meta.source_commit, logic_files[].sha256)', () => {
  const sha = 'a'.repeat(64);

  it('parses the three facts and keeps them typed', () => {
    const meta = DokMetaSchema.parse({
      version: 1,
      history: [],
      logic_hash: 'b'.repeat(64),
      logic_hash_normalized: `ts-tree-v1+ts5.4.2:${'c'.repeat(64)}`,
      source_commit: 'd'.repeat(40),
      logic_files: [{ file: 'app/page.tsx', sha256: sha }, { file: 'lib/a.ts' }],
    });
    expect(meta.logic_hash_normalized).toBe(`ts-tree-v1+ts5.4.2:${'c'.repeat(64)}`);
    expect(meta.source_commit).toBe('d'.repeat(40));
    expect(meta.logic_files).toEqual([{ file: 'app/page.tsx', sha256: sha }, { file: 'lib/a.ts' }]);
    expect(SourceAnchorSchema.parse({ file: 'x.ts', sha256: sha }).sha256).toBe(sha);
  });

  it('stays optional: a legacy meta without them round-trips unchanged', () => {
    const legacy = { version: 1, history: [], logic_hash: 'b'.repeat(64), logic_files: [{ file: 'a.ts' }] };
    const meta = DokMetaSchema.parse(legacy);
    expect(meta).toEqual(legacy);
    expect('logic_hash_normalized' in meta).toBe(false);
    expect('source_commit' in meta).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(DokMetaSchema.safeParse({ logic_hash_normalized: 1 }).success).toBe(false);
    expect(DokMetaSchema.safeParse({ source_commit: true }).success).toBe(false);
    expect(SourceAnchorSchema.safeParse({ file: 'a.ts', sha256: 7 }).success).toBe(false);
  });
});
