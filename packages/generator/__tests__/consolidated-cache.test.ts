import { describe, expect, it } from 'vitest';
import * as consolidatedCache from '../src/consolidated-cache.js';

type Parser = (value: unknown) => {
  originalFeatureIds: string[];
  groups: Array<{
    features: Array<{
      canonical_id: string;
      members: string[];
      primary_route: string;
      source_files?: string[];
      logic_files?: string[];
    }>;
  }>;
};

function parser(): Parser | undefined {
  return Reflect.get(consolidatedCache, 'parseConsolidatedFeatureConfig') as Parser | undefined;
}

function legacyCollision() {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: '2026-09-08T00:00:00.000Z',
    generatedAt: '2026-09-08T00:01:00.000Z',
    model: 'test',
    groups: [
      {
        group_id: 'create-template',
        label: 'Direct',
        features: [{
          canonical_id: 'create-template',
          label: 'Direct template',
          decision: 'keep',
          members: ['create-template'],
          primary_route: '/create-template',
          reason: '',
          user_reviewed: false,
          dok_id_prefix: 'TEMPLATE',
          source_files: ['app/create/template/page.tsx'],
          logic_files: ['app/create/template/page.tsx'],
        }],
        excluded: [],
      },
      {
        group_id: 'create',
        label: 'Nested',
        features: [{
          canonical_id: 'create-template',
          label: 'Nested template',
          decision: 'keep',
          members: ['create-template'],
          primary_route: '/create/template',
          reason: '',
          user_reviewed: false,
          dok_id_prefix: 'CREATE-TPL',
          source_files: ['app/create/template/page.tsx'],
          logic_files: ['app/create/template/page.tsx'],
        }],
        excluded: [],
      },
    ],
    originalFeatureIds: ['create-template', 'create-template'],
    userReviewed: false,
    stats: {
      originalFeatures: 2,
      consolidatedFeatures: 2,
      merges: 0,
      excluded: 0,
    },
  };
}

describe('parseConsolidatedFeatureConfig', () => {
  it('repairs the legacy route-slug collision before applying the strict cache schema', () => {
    const parse = parser();
    expect(parse).toBeDefined();
    if (!parse) return;
    const raw = legacyCollision();
    const before = JSON.stringify(raw);

    const parsed = parse(raw);
    const idByRoute = Object.fromEntries(
      parsed.groups.flatMap((group) => group.features)
        .map((feature) => [feature.primary_route, feature.canonical_id]),
    );

    expect(idByRoute).toEqual({
      '/create-template': 'create-template',
      '/create/template': 'create-template-path2',
    });
    expect(parsed.groups.flatMap((group) => group.features)
      .map((feature) => feature.members)).toEqual([
      ['create-template'],
      ['create-template-path2'],
    ]);
    expect(parsed.originalFeatureIds).toEqual(['create-template', 'create-template-path2']);
    for (const feature of parsed.groups.flatMap((group) => group.features)) {
      expect(feature).not.toHaveProperty('source_files');
      expect(feature).not.toHaveProperty('logic_files');
    }
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('rejects an ambiguous duplicate instead of treating it as a legacy route collision', () => {
    const parse = parser();
    expect(parse).toBeDefined();
    if (!parse) return;
    const raw = legacyCollision();
    raw.groups[1]!.features[0]!.members = ['different-source-feature'];

    expect(() => parse(raw)).toThrow(/duplicate consolidated canonical_id/i);
  });
});
