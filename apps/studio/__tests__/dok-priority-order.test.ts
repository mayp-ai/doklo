import { describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { comparePriority, tierRowTokens } from '../lib/dok-priority-order';

function dok(dok_id: string, impact?: string, blast?: string): Dok {
  return {
    dok_id,
    name: dok_id,
    status: 'active',
    tags: [],
    surfaces: [],
    description: 'x',
    ...(impact === undefined
      ? {}
      : {
          priority: {
            impact,
            blast_radius: blast ?? 'degrading',
            signals: [],
            curated: {},
          },
        }),
    _meta: { version: 1, history: [] },
  } as unknown as Dok;
}

function order(doks: Dok[]): string[] {
  return [...doks].sort(comparePriority).map((d) => d.dok_id);
}

describe('comparePriority', () => {
  it('ranks impact ahead of blast radius', () => {
    expect(order([
      dok('B', 'core_value', 'blocking'),
      dok('A', 'revenue', 'cosmetic'),
    ])).toEqual(['A', 'B']);
  });

  // revenue/core_value/compliance are all `critical`, so the tier cannot
  // separate them — the comparator must read the impact enum itself.
  it('separates the three critical impacts', () => {
    expect(order([
      dok('C', 'compliance'),
      dok('A', 'revenue'),
      dok('B', 'core_value'),
    ])).toEqual(['A', 'B', 'C']);
  });

  it('breaks an impact tie on blast radius', () => {
    expect(order([
      dok('C', 'enabling', 'cosmetic'),
      dok('A', 'enabling', 'blocking'),
      dok('B', 'enabling', 'degrading'),
    ])).toEqual(['A', 'B', 'C']);
  });

  it('breaks a full tie on dok_id so the order is stable', () => {
    expect(order([
      dok('B', 'enabling', 'degrading'),
      dok('A', 'enabling', 'degrading'),
    ])).toEqual(['A', 'B']);
  });

  // Unjudged sits mid-pack: pushing it to the top makes unjudged look
  // important, pushing it to the bottom makes it disappear quietly.
  it('places an unjudged Dok as enabling/degrading', () => {
    expect(order([
      dok('LOW', 'supporting', 'cosmetic'),
      dok('NONE'),
      dok('HIGH', 'revenue'),
      dok('BLOCK', 'enabling', 'blocking'),
    ])).toEqual(['HIGH', 'BLOCK', 'NONE', 'LOW']);
  });
});

describe('tierRowTokens', () => {
  it('marks critical and leaves its text at default weight', () => {
    const tokens = tierRowTokens(dok('A', 'revenue'));
    expect(tokens.marker).not.toBe('');
    expect(tokens.text).toBe('');
  });

  it('gives standard no marker and no dim', () => {
    const tokens = tierRowTokens(dok('A', 'enabling', 'degrading'));
    expect(tokens.marker).toBe('');
    expect(tokens.text).toBe('');
  });

  it('dims peripheral without marking it', () => {
    const tokens = tierRowTokens(dok('A', 'supporting', 'cosmetic'));
    expect(tokens.marker).toBe('');
    expect(tokens.text).not.toBe('');
  });

  it('treats an unjudged Dok as standard', () => {
    expect(tierRowTokens(dok('A'))).toEqual({ marker: '', text: '' });
  });
});
