import { describe, it, expect } from 'vitest';
import { ConsolidatedFeatureConfigSchema } from '../lib/consolidation';

const valid = {
  projectName: 'demo',
  basedOnFeaturesAt: '2026-07-07T00:00:00.000Z',
  generatedAt: '2026-07-07T00:00:00.000Z',
  model: 'claude-haiku-4-5',
  originalFeatureIds: ['a'],
  userReviewed: false,
  stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
  groups: [{
    group_id: 'auth', label: 'Auth', excluded: [],
    features: [{
      canonical_id: 'a', label: 'Sign in', decision: 'keep',
      members: ['a'], primary_route: '/signin', reason: '', user_reviewed: false,
      dok_id_prefix: 'AUTH',
    }],
  }],
};

describe('ConsolidatedFeatureConfigSchema', () => {
  it('accepts a well-formed config', () => {
    expect(ConsolidatedFeatureConfigSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects an invalid decision', () => {
    const bad = structuredClone(valid);
    (bad.groups[0].features[0] as { decision: string }).decision = 'nope';
    expect(ConsolidatedFeatureConfigSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects a missing stats block', () => {
    const bad = structuredClone(valid) as Record<string, unknown>;
    delete bad.stats;
    expect(ConsolidatedFeatureConfigSchema.safeParse(bad).success).toBe(false);
  });
  it('preserves source and logic provenance plus Studio decision state', () => {
    const withProvenance = structuredClone(valid);
    Object.assign(withProvenance.groups[0].features[0], {
      prev_decision: 'merge',
      source_files: [],
      logic_files: ['app/page.tsx', 'lib/shared.ts'],
    });

    const parsed = ConsolidatedFeatureConfigSchema.parse(withProvenance);
    expect(parsed.groups[0]?.features[0]).toMatchObject({
      prev_decision: 'merge',
      source_files: [],
      logic_files: ['app/page.tsx', 'lib/shared.ts'],
    });
  });
  it('accepts the persisted original feature inventory', () => {
    expect(ConsolidatedFeatureConfigSchema.safeParse({
      ...valid,
      originalFeatureIds: ['a', 'b'],
    }).success).toBe(true);
  });
  it('fails closed on unknown keys instead of stripping them on save', () => {
    const bad = structuredClone(valid) as Record<string, unknown>;
    bad['futureUnsafeField'] = true;
    expect(ConsolidatedFeatureConfigSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects duplicate group and canonical feature ids', () => {
    const duplicateGroup = structuredClone(valid);
    duplicateGroup.groups.push(structuredClone(duplicateGroup.groups[0]));
    expect(ConsolidatedFeatureConfigSchema.safeParse(duplicateGroup).success).toBe(false);

    const duplicateFeature = structuredClone(valid);
    duplicateFeature.groups[0].features.push(
      structuredClone(duplicateFeature.groups[0].features[0]),
    );
    expect(ConsolidatedFeatureConfigSchema.safeParse(duplicateFeature).success).toBe(false);
  });
  it('rejects a Dok ID prefix that could escape the Hub doks directory', () => {
    const bad = structuredClone(valid);
    bad.groups[0].features[0].dok_id_prefix = '../../../../tmp/escape';
    expect(ConsolidatedFeatureConfigSchema.safeParse(bad).success).toBe(false);
  });
  it('accepts a 3-segment dok_id_prefix with a digit after the first letter of a segment', () => {
    const threeSegments = structuredClone(valid);
    threeSegments.groups[0].features[0].dok_id_prefix = 'OAUTH2-SIGNIN-CALLBACK';
    expect(ConsolidatedFeatureConfigSchema.safeParse(threeSegments).success).toBe(true);
  });
  it('rejects a dok_id_prefix starting with the reserved BR/AC segment', () => {
    const reserved = structuredClone(valid);
    reserved.groups[0].features[0].dok_id_prefix = 'BR-CHECKOUT';
    expect(ConsolidatedFeatureConfigSchema.safeParse(reserved).success).toBe(false);
  });
});
