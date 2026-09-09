import { describe, expect, it } from 'vitest';
import {
  DokPrioritySchema,
  derivePriorityTier,
  lockedPriorityFields,
  type DokPriority,
} from '../src/schemas/priority.js';
import { DokSchema } from '../src/schemas/dok.js';

function priority(over: Partial<DokPriority> = {}): DokPriority {
  return DokPrioritySchema.parse({
    impact: 'enabling',
    blast_radius: 'degrading',
    ...over,
  });
}

describe('derivePriorityTier', () => {
  it('treats an absent priority as standard, not as low', () => {
    expect(derivePriorityTier(undefined)).toBe('standard');
  });

  it.each(['revenue', 'core_value', 'compliance'] as const)(
    'makes %s critical regardless of blast radius',
    (impact) => {
      expect(derivePriorityTier(priority({ impact, blast_radius: 'cosmetic' })))
        .toBe('critical');
    },
  );

  // The ordering guarantee: enabling+blocking matches both the critical rule
  // and the standard rule. Critical must win, or sign-in lands in standard.
  it('makes a blocking enabling Dok critical, not standard', () => {
    expect(derivePriorityTier(priority({ impact: 'enabling', blast_radius: 'blocking' })))
      .toBe('critical');
  });

  it('makes a blocking supporting Dok critical, not peripheral', () => {
    expect(derivePriorityTier(priority({ impact: 'supporting', blast_radius: 'blocking' })))
      .toBe('critical');
  });

  it('makes a non-blocking supporting Dok peripheral', () => {
    expect(derivePriorityTier(priority({ impact: 'supporting', blast_radius: 'cosmetic' })))
      .toBe('peripheral');
    expect(derivePriorityTier(priority({ impact: 'supporting', blast_radius: 'degrading' })))
      .toBe('peripheral');
  });

  it('makes a non-blocking enabling Dok standard', () => {
    expect(derivePriorityTier(priority({ impact: 'enabling', blast_radius: 'degrading' })))
      .toBe('standard');
  });
});

describe('DokPrioritySchema', () => {
  it('defaults signals and curated so a minimal judgment parses', () => {
    const parsed = DokPrioritySchema.parse({ impact: 'revenue', blast_radius: 'degrading' });
    expect(parsed.signals).toEqual([]);
    expect(parsed.curated).toEqual({});
  });

  it('accepts a signal carrying its detector and source anchor', () => {
    const parsed = DokPrioritySchema.parse({
      impact: 'revenue',
      blast_radius: 'degrading',
      signals: [{ file: 'models/order.model.ts', start_line: 44, detector: 'money-model' }],
    });
    expect(parsed.signals[0]?.detector).toBe('money-model');
  });

  it('rejects a signal with no detector — evidence must name what produced it', () => {
    expect(() => DokPrioritySchema.parse({
      impact: 'revenue',
      blast_radius: 'degrading',
      signals: [{ file: 'models/order.model.ts' }],
    })).toThrow();
  });

  it('requires a reason on every curation — an unexplained lock is a fossil', () => {
    expect(() => DokPrioritySchema.parse({
      impact: 'revenue',
      blast_radius: 'degrading',
      curated: { impact: { by: 'pumpa' } },
    })).toThrow();
  });

  it('cannot curate signals — evidence is structurally unlockable', () => {
    expect(() => DokPrioritySchema.parse({
      impact: 'revenue',
      blast_radius: 'degrading',
      curated: { signals: { reason: 'nice try' } },
    })).toThrow();
  });
});

describe('lockedPriorityFields', () => {
  it('is empty for an unjudged Dok', () => {
    expect(lockedPriorityFields(undefined)).toEqual([]);
  });

  it('is empty when nothing was pinned', () => {
    expect(lockedPriorityFields(priority())).toEqual([]);
  });

  it('lists pinned axes in a stable order', () => {
    const pinned = priority({
      curated: {
        blast_radius: { reason: 'every user goes through here' },
        impact: { reason: 'settlement API is called here' },
      },
    });
    expect(lockedPriorityFields(pinned)).toEqual(['impact', 'blast_radius']);
  });
});

describe('Dok.priority', () => {
  const base = {
    dok_id: 'AUTH-SIGNIN',
    name: 'Sign in',
    description: 'Users authenticate to enter the application.',
  };

  it('is optional — an unjudged Dok is valid', () => {
    expect(DokSchema.parse(base).priority).toBeUndefined();
  });

  it('round-trips a judged Dok', () => {
    const parsed = DokSchema.parse({
      ...base,
      priority: { impact: 'enabling', blast_radius: 'blocking' },
    });
    expect(derivePriorityTier(parsed.priority)).toBe('critical');
  });
});
