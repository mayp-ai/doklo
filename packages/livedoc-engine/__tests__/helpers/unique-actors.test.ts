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

describe('unique_actors helper', () => {
  it('dedupes same role across multiple steps', () => {
    const steps = [
      step({ kind: 'role', role_ref: 'ROLE-ADMIN' }),
      step({ kind: 'role', role_ref: 'ROLE-ADMIN' }),
      step({ kind: 'role', role_ref: 'ROLE-USER' }),
    ];
    const out = render('{{#each (unique_actors steps)}}-{{this.role_ref}}\n{{/each}}', { steps });
    expect(out).toBe('-ROLE-ADMIN\n-ROLE-USER\n');
  });

  it('treats role / system / external as distinct keys', () => {
    const steps = [
      step({ kind: 'role', role_ref: 'ROLE-ADMIN' }),
      step({ kind: 'system' }),
      step({ kind: 'external', label: 'Stripe' }),
      step({ kind: 'external', label: 'Stripe' }),
      step({ kind: 'system' }),
    ];
    const out = render('{{len (unique_actors steps)}}', { steps });
    expect(out).toBe('3');
  });

  it('returns empty array for non-array input', () => {
    expect(render('{{len (unique_actors steps)}}', { steps: null })).toBe('0');
  });

  it('preserves first-appearance order', () => {
    const steps = [
      step({ kind: 'role', role_ref: 'ROLE-B' }),
      step({ kind: 'role', role_ref: 'ROLE-A' }),
      step({ kind: 'role', role_ref: 'ROLE-B' }),
    ];
    const out = render('{{#each (unique_actors steps)}}{{this.role_ref}},{{/each}}', { steps });
    expect(out).toBe('ROLE-B,ROLE-A,');
  });
});
