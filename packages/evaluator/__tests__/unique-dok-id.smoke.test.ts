import { describe, it, expect } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { uniqueDokId } from '../src/criteria/unique-dok-id.js';
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

describe('unique-dok-id', () => {
  it('returns no violations when every dok_id is unique', () => {
    const input: EvalInput = {
      doks: [makeDok('AUTH-SIGNIN'), makeDok('AUTH-SIGNUP'), makeDok('BILL-INVOICE')],
    };
    expect(uniqueDokId.evaluate(input)).toEqual([]);
  });

  it('reports duplicate dok_ids as unfixable violations', () => {
    const input: EvalInput = {
      doks: [makeDok('AUTH-SIGNIN'), makeDok('AUTH-SIGNIN')],
    };
    const violations = uniqueDokId.evaluate(input) as Awaited<
      ReturnType<typeof uniqueDokId.evaluate>
    >;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.dokId).toBe('AUTH-SIGNIN');
    expect(violations[0]?.severity).toBe('error');
  });

  it('does not provide autoFix — duplicates must be resolved manually, never silently renumbered', () => {
    expect(uniqueDokId.autoFix).toBeUndefined();
    expect(uniqueDokId.manualOnly).toBe(true);
  });

  it('violation message names every colliding occurrence and points at the consolidated cache', () => {
    const input: EvalInput = {
      doks: [makeDok('AUTH-SIGNIN'), makeDok('AUTH-SIGNUP'), makeDok('AUTH-SIGNIN')],
    };
    const violations = uniqueDokId.evaluate(input) as Awaited<
      ReturnType<typeof uniqueDokId.evaluate>
    >;
    expect(violations).toHaveLength(1);
    const [violation] = violations;
    expect(violation?.message).toContain('AUTH-SIGNIN');
    expect(violation?.message).toContain('doks[0]');
    expect(violation?.message).toContain('doks[2]');
    expect(violation?.message).toContain('.doklo/hub/doks/AUTH-SIGNIN.json');
    expect(violation?.message).toContain("Studio's consolidation screen");
    expect(violation?.message).toContain('consolidated cache');
    expect(violation?.message).toContain('.doklo/cache/<service>.consolidated.json');
  });

  it('reports one violation per distinct duplicated dok_id, not per extra occurrence', () => {
    const input: EvalInput = {
      doks: [
        makeDok('AUTH-SIGNIN'),
        makeDok('AUTH-SIGNIN'),
        makeDok('BILL-INVOICE'),
        makeDok('BILL-INVOICE'),
        makeDok('BILL-INVOICE'),
      ],
    };
    const violations = uniqueDokId.evaluate(input) as Awaited<
      ReturnType<typeof uniqueDokId.evaluate>
    >;
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.dokId).sort()).toEqual(['AUTH-SIGNIN', 'BILL-INVOICE']);
  });

  it('does not mutate the input doks', () => {
    const dok = makeDok('AUTH-SIGNIN');
    const input: EvalInput = { doks: [dok, makeDok('AUTH-SIGNIN')] };
    uniqueDokId.evaluate(input);
    expect(dok.dok_id).toBe('AUTH-SIGNIN');
  });
});
