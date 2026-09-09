import { describe, expect, it } from 'vitest';
import {
  finalizeGenerationLedger,
  reconcileSourceFeatures,
  type FeatureAccountingInput,
} from '../src/feature-accounting.js';

const input: FeatureAccountingInput = {
  sourceFeatures: ['F-a', 'F-b', 'F-c'],
  consolidated: [
    {
      canonicalFeatureId: 'CF-ab',
      sourceFeatureIds: ['F-a', 'F-b'],
      excluded: false,
    },
    {
      canonicalFeatureId: 'CF-c',
      sourceFeatureIds: ['F-c'],
      excluded: true,
    },
  ],
};

describe('source feature accounting', () => {
  it('accounts for merged and excluded source features exactly once', () => {
    expect(reconcileSourceFeatures(input).map(({ sourceFeatureId, canonicalFeatureId, status }) => ({
      sourceFeatureId,
      canonicalFeatureId,
      status,
    }))).toEqual([
      { sourceFeatureId: 'F-a', canonicalFeatureId: 'CF-ab', status: 'success' },
      { sourceFeatureId: 'F-b', canonicalFeatureId: 'CF-ab', status: 'success' },
      { sourceFeatureId: 'F-c', canonicalFeatureId: 'CF-c', status: 'skipped' },
    ]);
  });

  it('preserves existing Doks and records failures in explicit transitions', () => {
    const entries = reconcileSourceFeatures({
      sourceFeatures: ['F-existing', 'F-failed'],
      consolidated: [
        {
          canonicalFeatureId: 'CF-existing',
          sourceFeatureIds: ['F-existing'],
          excluded: false,
          dokId: 'AUTH',
          existing: true,
        },
        {
          canonicalFeatureId: 'CF-failed',
          sourceFeatureIds: ['F-failed'],
          excluded: false,
          failed: 'LLM timeout',
        },
      ],
    });
    expect(entries.map((entry) => entry.status)).toEqual(['skipped', 'failed']);
    expect(entries[0]?.reasonCode).toBe('EXISTING_PRESERVED');
    expect(entries[1]?.reasonCode).toBe('GENERATION_FAILED');
  });

  it('records interrupted work without changing generated or failure meanings', () => {
    const entries = reconcileSourceFeatures({
      sourceFeatures: ['F-complete', 'F-interrupted', 'F-failed'],
      consolidated: [
        {
          canonicalFeatureId: 'CF-complete',
          sourceFeatureIds: ['F-complete'],
          excluded: false,
          dokId: 'AUTH',
        },
        {
          canonicalFeatureId: 'CF-interrupted',
          sourceFeatureIds: ['F-interrupted'],
          excluded: false,
          dokId: 'USER',
          interrupted: true,
        },
        {
          canonicalFeatureId: 'CF-failed',
          sourceFeatureIds: ['F-failed'],
          excluded: false,
          dokId: 'BILL',
          failed: 'provider failed',
        },
      ],
    });

    expect(entries.map(({ sourceFeatureId, status, reasonCode }) => ({
      sourceFeatureId,
      status,
      reasonCode,
    }))).toEqual([
      { sourceFeatureId: 'F-complete', status: 'success', reasonCode: 'GENERATED' },
      { sourceFeatureId: 'F-failed', status: 'failed', reasonCode: 'GENERATION_FAILED' },
      { sourceFeatureId: 'F-interrupted', status: 'failed', reasonCode: 'INTERRUPTED' },
    ]);
  });

  it('rejects duplicate or missing source feature accounting', () => {
    expect(() => reconcileSourceFeatures({
      sourceFeatures: ['F-a'],
      consolidated: [{ canonicalFeatureId: 'CF-a', sourceFeatureIds: ['F-a', 'F-a'], excluded: false }],
    })).toThrow(/DUPLICATE_SOURCE_FEATURE/);
    expect(() => reconcileSourceFeatures({
      sourceFeatures: ['F-a', 'F-missing'],
      consolidated: [{ canonicalFeatureId: 'CF-a', sourceFeatureIds: ['F-a'], excluded: false }],
    })).toThrow(/MISSING_SOURCE_FEATURE/);
  });

  it('finalizes a generation ledger with summary counts', () => {
    const entries = reconcileSourceFeatures(input);
    const ledger = finalizeGenerationLedger(entries, {
      workspaceId: 'demo',
      model: 'anthropic/claude-sonnet-5',
      planDigest: 'sha256:test',
      startedAt: '2026-07-17T00:00:00.000Z',
      completedAt: '2026-07-17T00:00:01.000Z',
    });
    expect(ledger.schema_version).toBe(1);
    expect(ledger.summary).toEqual({ sourceFeatures: 3, success: 2, skipped: 1, failed: 0 });
  });

  it('preserves the exact approved Codex runtime model in the ledger', () => {
    const ledger = finalizeGenerationLedger([], {
      workspaceId: 'demo',
      model: 'openai/gpt-5.6-terra',
      planDigest: 'sha256:codex',
      startedAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:00:01.000Z',
    });

    expect(ledger.model).toBe('openai/gpt-5.6-terra');
  });
});
