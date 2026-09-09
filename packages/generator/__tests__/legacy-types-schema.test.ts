import { describe, expect, it } from 'vitest';
import * as legacyTypes from '../src/legacy-types.js';

type RuntimeSchema = {
  parse(value: unknown): Record<string, unknown>;
  safeParse(value: unknown): { success: boolean };
};

function schema(): RuntimeSchema | undefined {
  return Reflect.get(legacyTypes, 'ConsolidatedFeatureConfigSchema') as RuntimeSchema | undefined;
}

function config() {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: '2026-07-15T00:00:00.000Z',
    generatedAt: '2026-07-15T00:00:00.000Z',
    model: 'test',
    originalFeatureIds: ['auth-sign-in'],
    groups: [{
      group_id: 'auth',
      label: 'Auth',
      features: [{
        canonical_id: 'auth-sign-in',
        label: 'Sign in',
        decision: 'keep',
        members: ['auth-sign-in'],
        primary_route: '/auth/sign-in',
        reason: '',
        user_reviewed: false,
        dok_id_prefix: 'AUTH',
      }],
      excluded: [],
    }],
    userReviewed: false,
    stats: {
      originalFeatures: 1,
      consolidatedFeatures: 1,
      merges: 0,
      excluded: 0,
    },
  };
}

describe('ConsolidatedFeatureConfigSchema', () => {
  it('is exported as a runtime boundary schema', () => {
    expect(schema()).toBeDefined();
  });

  it('preserves the distinction between omitted and explicitly empty file sets', () => {
    const runtimeSchema = schema();
    expect(runtimeSchema).toBeDefined();
    if (!runtimeSchema) return;
    const raw = config();
    raw.groups[0]!.features.push({
      ...raw.groups[0]!.features[0]!,
      canonical_id: 'auth-empty',
      members: ['auth-empty'],
      source_files: [],
      logic_files: [],
    } as typeof raw.groups[0]['features'][number]);

    const parsed = runtimeSchema.parse(raw) as typeof raw;

    expect(parsed.groups[0]!.features[0]).not.toHaveProperty('source_files');
    expect(parsed.groups[0]!.features[1]).toMatchObject({
      source_files: [],
      logic_files: [],
    });
  });

  it('rejects unknown keys at nested persisted boundaries', () => {
    const runtimeSchema = schema();
    expect(runtimeSchema).toBeDefined();
    if (!runtimeSchema) return;
    const raw = config();
    Object.assign(raw.groups[0]!.features[0]!, { unexpected: true });

    expect(runtimeSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects duplicate group IDs', () => {
    const runtimeSchema = schema();
    expect(runtimeSchema).toBeDefined();
    if (!runtimeSchema) return;
    const raw = config();
    raw.groups.push({ ...raw.groups[0]!, features: [] });

    expect(runtimeSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects duplicate canonical IDs across groups', () => {
    const runtimeSchema = schema();
    expect(runtimeSchema).toBeDefined();
    if (!runtimeSchema) return;
    const raw = config();
    raw.groups.push({
      ...raw.groups[0]!,
      group_id: 'second',
      features: [{ ...raw.groups[0]!.features[0]! }],
    });

    expect(runtimeSchema.safeParse(raw).success).toBe(false);
  });

  it('accepts and preserves Studio-authored prev_decision', () => {
    const runtimeSchema = schema();
    expect(runtimeSchema).toBeDefined();
    if (!runtimeSchema) return;
    const raw = config();
    Object.assign(raw.groups[0]!.features[0]!, {
      decision: 'exclude',
      prev_decision: 'keep',
    });

    const parsed = runtimeSchema.parse(raw) as typeof raw & {
      groups: Array<{ features: Array<{ prev_decision?: string }> }>;
    };
    expect(parsed.groups[0]!.features[0]!.prev_decision).toBe('keep');
  });

  it.each([
    '../../../../tmp/escape',
    '/ABSOLUTE',
    'auth',
    'A',
    // Four segments — one past the shared grammar's 3-segment ceiling.
    'AB-CD-EF-GH',
    // Reserved first segment (BR is reserved for business-rule child ids).
    'BR-SOMETHING',
  ])('rejects unsafe or invalid Dok ID prefix %j', (prefix) => {
    const runtimeSchema = schema();
    expect(runtimeSchema).toBeDefined();
    if (!runtimeSchema) return;
    const raw = config();
    raw.groups[0]!.features[0]!.dok_id_prefix = prefix;

    expect(runtimeSchema.safeParse(raw).success).toBe(false);
  });
});
