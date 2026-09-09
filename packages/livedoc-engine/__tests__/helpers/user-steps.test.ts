import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/handlebars-setup.js';
import type { UserActionStep } from '@doklo-beta/core';

function render(tpl: string, ctx: unknown): string {
  const hb = createEngine();
  return hb.compile(tpl)(ctx);
}

function step(actor: UserActionStep['actor']): UserActionStep {
  return {
    order: 0,
    actor,
    intent: '',
    outcome: '',
    variants: [],
  };
}

describe('user_steps helper', () => {
  it('filters out system steps, keeping role and external actors', () => {
    const steps = [
      step({ kind: 'role', role_ref: 'ROLE-USER' }),
      step({ kind: 'system' }),
      step({ kind: 'external', label: 'Stripe' }),
      step({ kind: 'system' }),
    ];
    const out = render('{{len (user_steps steps)}}', { steps });
    expect(out).toBe('2');
  });

  it('preserves original order of remaining steps', () => {
    const steps = [
      step({ kind: 'role', role_ref: 'ROLE-B' }),
      step({ kind: 'system' }),
      step({ kind: 'role', role_ref: 'ROLE-A' }),
    ];
    const out = render(
      '{{#each (user_steps steps)}}{{this.actor.role_ref}},{{/each}}',
      { steps },
    );
    expect(out).toBe('ROLE-B,ROLE-A,');
  });

  it('returns empty array for non-array input', () => {
    expect(render('{{len (user_steps steps)}}', { steps: null })).toBe('0');
    expect(render('{{len (user_steps steps)}}', {})).toBe('0');
  });
});
