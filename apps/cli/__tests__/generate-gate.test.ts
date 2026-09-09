import { describe, it, expect } from 'vitest';
import {
  formatGeneratePlan,
  estimateGenerateTokens,
  formatGateSummary,
  shouldPromptGate,
  runGateInteraction,
  type GatePlanItem,
  type GateChoice,
} from '../src/lib/generate-gate.js';

const plan: GatePlanItem[] = [
  { serviceId: 'web', dokId: 'AUTH', featureLabel: 'Sign in', domain: 'Auth' },
  { serviceId: 'web', dokId: 'AUTH-SIGNUP', featureLabel: 'Sign up', domain: 'Auth' },
  { serviceId: 'web', dokId: 'HOME', featureLabel: 'Dashboard', domain: 'Dashboard' },
];

describe('formatGeneratePlan', () => {
  it('groups Dok ids by domain in first-seen order', () => {
    const out = formatGeneratePlan(plan);
    expect(out).toContain('Auth (2)');
    expect(out).toContain('Sign in');
    expect(out).toContain('Sign up');
    expect(out).toContain('Dashboard (1)');
    expect(out).toContain('Dashboard');
    // Auth block precedes Dashboard block (first-seen order).
    expect(out.indexOf('Auth (2)')).toBeLessThan(out.indexOf('Dashboard (1)'));
  });
});

describe('token preview', () => {
  it('estimates prepared input and keeps the output allowance separate', () => {
    const tokens = estimateGenerateTokens([{ prompt: 'a'.repeat(400) }, { prompt: '한글' }]);
    expect(tokens).toEqual({ inputTokens: 102, outputTokens: 3000, maxOutputTokens: 16384 });
    const summary = formatGateSummary(2, tokens);
    expect(summary).toContain('102');
    expect(summary).toContain('3,000');
    expect(summary).not.toContain('$');
  });
  it('shows readable examples, caps domain samples, and supports full detail', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      serviceId: 'web', domain: 'Auth', dokId: `AUTH-${i}`, featureLabel: `Action ${i}`,
    }));
    expect(formatGeneratePlan(many)).toContain('Action 0');
    expect(formatGeneratePlan(many)).not.toContain('Action 9');
    expect(formatGeneratePlan(many, true)).toContain('AUTH-9');
  });
});

describe('shouldPromptGate', () => {
  it('prompts on an interactive TTY without --yes', () => {
    expect(shouldPromptGate({ yes: false, isTTY: true })).toBe(true);
  });
  it('skips when --yes', () => {
    expect(shouldPromptGate({ yes: true, isTTY: true })).toBe(false);
  });
  it('skips on a non-TTY (pipe / CI)', () => {
    expect(shouldPromptGate({ yes: false, isTTY: false })).toBe(false);
  });
});

describe('runGateInteraction', () => {
  const labels = { generate: 'Generate', studio: 'Adjust in Studio', cancel: 'Cancel' };
  const fakeIsCancel = (v: unknown) => typeof v === 'symbol';

  it('returns "generate" and does not launch Studio', async () => {
    let launched = false;
    const choice = await runGateInteraction('go?', labels, {
      select: async () => 'generate',
      isCancel: fakeIsCancel,
      launchStudio: async () => { launched = true; },
    });
    expect(choice).toBe<GateChoice>('generate');
    expect(launched).toBe(false);
  });

  it('launches Studio on "studio"', async () => {
    let launched = false;
    const choice = await runGateInteraction('go?', labels, {
      select: async () => 'studio',
      isCancel: fakeIsCancel,
      launchStudio: async () => { launched = true; },
    });
    expect(choice).toBe('studio');
    expect(launched).toBe(true);
  });

  it('maps an ESC cancel symbol to "cancel"', async () => {
    const choice = await runGateInteraction('go?', labels, {
      select: async () => Symbol('cancel'),
      isCancel: fakeIsCancel,
      launchStudio: async () => { throw new Error('should not launch'); },
    });
    expect(choice).toBe('cancel');
  });
});
