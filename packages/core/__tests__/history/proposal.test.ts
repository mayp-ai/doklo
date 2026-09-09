import { describe, expect, it } from 'vitest';
import { computeChangeProposal, type Dok } from '../../src/index.js';

function baseDok(over: Partial<Dok> = {}): Dok {
  return {
    dok_id: 'AUTH-SIGNIN',
    name: 'Email sign-in',
    description: 'Users sign in with email and password.',
    status: 'active',
    surfaces: ['web'],
    tags: [],
    user_actions: {
      steps: [
        { order: 1, actor: { kind: 'system' }, intent: 'Open form', outcome: 'Form shown', variants: [] },
        { order: 2, actor: { kind: 'system' }, intent: 'Submit', outcome: 'Signed in', variants: [] },
      ],
    },
    business_rules: {
      rules: [
        { id: 'BR-AUTH-SIGNIN-01', description: 'Lock after 5 failures', type: 'restriction' },
      ],
    },
    acceptance_criteria: {
      criteria: [
        { id: 'AC-AUTH-SIGNIN-01', statement: 'Valid login succeeds', related_rules: [] },
      ],
    },
    _meta: { version: 3, history: [], logic_hash: 'aaa' },
    ...over,
  } as unknown as Dok;
}

describe('computeChangeProposal', () => {
  it('returns null when the regenerated content is identical (meta/status/priority noise ignored)', () => {
    const prev = baseDok();
    const next = baseDok({ status: 'draft', _meta: { version: 4, history: [], logic_hash: 'bbb' } } as Partial<Dok>);
    expect(computeChangeProposal(prev, next)).toBeNull();
  });

  it('describes description and step changes in fixed clause order', () => {
    const next = baseDok({
      description: 'Users sign in with email, password, or passkey.',
      user_actions: {
        steps: [
          { order: 1, actor: { kind: 'system' }, intent: 'Open form', outcome: 'Form shown', variants: [] },
          { order: 2, actor: { kind: 'system' }, intent: 'Choose passkey', outcome: 'Prompt shown', variants: [] },
          { order: 3, actor: { kind: 'system' }, intent: 'Submit', outcome: 'Signed in', variants: [] },
        ],
      },
    } as Partial<Dok>);
    const proposal = computeChangeProposal(baseDok(), next);
    expect(proposal).toEqual({ summary: 'Updated the description; added 1 step; revised 1 step.' });
  });

  it('accounts rules and criteria by id and reports renames', () => {
    const next = baseDok({
      name: 'Sign in',
      business_rules: {
        rules: [
          { id: 'BR-AUTH-SIGNIN-01', description: 'Lock after 3 failures', type: 'restriction' },
          { id: 'BR-AUTH-SIGNIN-02', description: 'Rate limit per IP', type: 'restriction' },
        ],
      },
      acceptance_criteria: { criteria: [] },
    } as Partial<Dok>);
    const proposal = computeChangeProposal(baseDok(), next);
    expect(proposal).toEqual({
      summary: 'Renamed the feature; added 1 rule; revised 1 rule; removed 1 acceptance criterion.',
    });
  });

  it('falls back to a generic clause when only untracked content changed, and is deterministic', () => {
    const next = baseDok({ tags: ['auth'] } as Partial<Dok>);
    const first = computeChangeProposal(baseDok(), next);
    expect(first).toEqual({ summary: 'Updated feature details.' });
    expect(computeChangeProposal(baseDok(), next)).toEqual(first);
  });
});
