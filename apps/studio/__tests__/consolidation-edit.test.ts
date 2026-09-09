import { describe, it, expect } from 'vitest';
import type { ConsolidatedFeatureConfig } from '../lib/consolidation';
import {
  renameGroup, mergeGroups, splitGroup, moveFeature, newGroupId,
  toggleExcludeFeature, excludeGroup, recomputeStats, setDokIdPrefix,
  countDoks, countExcluded, countDomains,
} from '../lib/consolidation-edit';

function cfg(): ConsolidatedFeatureConfig {
  return {
    projectName: 'demo', basedOnFeaturesAt: 't', generatedAt: 't',
    model: 'm', userReviewed: false,
    originalFeatureIds: ['f1', 'f2', 'f3', 'x'],
    stats: { originalFeatures: 3, consolidatedFeatures: 3, merges: 0, excluded: 0 },
    groups: [
      { group_id: 'a', label: 'A', excluded: [], features: [
        { canonical_id: 'f1', label: 'F1', decision: 'keep', members: ['f1'], primary_route: '/1', reason: '', user_reviewed: false, dok_id_prefix: 'F1' },
        { canonical_id: 'f2', label: 'F2', decision: 'keep', members: ['f2'], primary_route: '/2', reason: '', user_reviewed: false, dok_id_prefix: 'F2' },
      ]},
      { group_id: 'b', label: 'B', excluded: [{ id: 'x', reason: 'r' }], features: [
        { canonical_id: 'f3', label: 'F3', decision: 'keep', members: ['f3'], primary_route: '/3', reason: '', user_reviewed: false, dok_id_prefix: 'F3' },
      ]},
    ],
  };
}

describe('renameGroup', () => {
  it('renames and does not mutate input', () => {
    const input = cfg();
    const out = renameGroup(input, 'a', 'Alpha');
    expect(out.groups.find((g) => g.group_id === 'a')?.label).toBe('Alpha');
    expect(input.groups.find((g) => g.group_id === 'a')?.label).toBe('A');
  });
});

describe('mergeGroups', () => {
  it('merges b into a: features + excluded concatenated, b removed', () => {
    const out = mergeGroups(cfg(), ['a', 'b'], 'Merged');
    expect(out.groups).toHaveLength(1);
    const g = out.groups[0];
    expect(g.group_id).toBe('a');
    expect(g.label).toBe('Merged');
    expect(g.features.map((f) => f.canonical_id)).toEqual(['f1', 'f2', 'f3']);
    expect(g.excluded).toHaveLength(1);
  });
});

describe('splitGroup', () => {
  it('moves selected features to a new group; empties stay in place', () => {
    const out = splitGroup(cfg(), 'a', ['f2'], { group_id: 'a2', label: 'A2' });
    expect(out.groups.find((g) => g.group_id === 'a')?.features.map((f) => f.canonical_id)).toEqual(['f1']);
    expect(out.groups.find((g) => g.group_id === 'a2')?.features.map((f) => f.canonical_id)).toEqual(['f2']);
  });
  it('removes the origin group when all features are split out', () => {
    const out = splitGroup(cfg(), 'b', ['f3'], { group_id: 'b2', label: 'B2' });
    expect(out.groups.find((g) => g.group_id === 'b')).toBeUndefined();
    expect(out.groups.find((g) => g.group_id === 'b2')?.features).toHaveLength(1);
  });
});

describe('moveFeature', () => {
  it('moves f1 from a to b', () => {
    const out = moveFeature(cfg(), 'f1', 'b');
    expect(out.groups.find((g) => g.group_id === 'a')?.features.map((f) => f.canonical_id)).toEqual(['f2']);
    expect(out.groups.find((g) => g.group_id === 'b')?.features.map((f) => f.canonical_id)).toEqual(['f3', 'f1']);
  });
  it('is a no-op (never drops the feature) when target is its home group', () => {
    const out = moveFeature(cfg(), 'f1', 'a');
    expect(out.groups.find((g) => g.group_id === 'a')?.features.map((f) => f.canonical_id)).toEqual(['f1', 'f2']);
  });
  it('is a no-op for an unknown feature id', () => {
    expect(moveFeature(cfg(), 'nope', 'b')).toEqual(cfg());
  });
});

describe('newGroupId', () => {
  it('produces an id not already used', () => {
    const id = newGroupId(cfg());
    expect(['a', 'b']).not.toContain(id);
  });
});

describe('toggleExcludeFeature', () => {
  it('excludes a kept feature, then restores it to keep', () => {
    const excluded = toggleExcludeFeature(cfg(), 'f1');
    const f = excluded.groups.flatMap((g) => g.features).find((x) => x.canonical_id === 'f1');
    expect(f?.decision).toBe('exclude');
    const back = toggleExcludeFeature(excluded, 'f1');
    expect(back.groups.flatMap((g) => g.features).find((x) => x.canonical_id === 'f1')?.decision).toBe('keep');
  });
  it('restores a merge feature back to merge (members > 1)', () => {
    const base = cfg();
    base.groups[0].features[0].members = ['f1', 'f1b'];
    base.groups[0].features[0].decision = 'merge';
    const back = toggleExcludeFeature(toggleExcludeFeature(base, 'f1'), 'f1');
    expect(back.groups[0].features[0].decision).toBe('merge');
  });
  it('preserves a keep decision even when members.length > 1 (no keep→merge corruption)', () => {
    const base = cfg();
    base.groups[0].features[0].members = ['f1', 'f1b']; // keep with 2 members (invariant violated)
    base.groups[0].features[0].decision = 'keep';
    const back = toggleExcludeFeature(toggleExcludeFeature(base, 'f1'), 'f1');
    expect(back.groups[0].features[0].decision).toBe('keep');
    expect(back.groups[0].features[0].prev_decision).toBeUndefined();
  });
});

describe('setDokIdPrefix', () => {
  it('sets the prefix for the matching feature only, without mutating the input', () => {
    const input = cfg();
    const out = setDokIdPrefix(input, 'f1', 'F1-RENAMED');
    expect(out.groups[0].features[0].dok_id_prefix).toBe('F1-RENAMED');
    expect(out.groups[0].features[1].dok_id_prefix).toBe('F2');
    expect(input.groups[0].features[0].dok_id_prefix).toBe('F1');
  });

  it('accepts a value that does not (yet) satisfy the Dok id grammar — validation is the caller’s job', () => {
    const out = setDokIdPrefix(cfg(), 'f1', 'auth-signin');
    expect(out.groups[0].features[0].dok_id_prefix).toBe('auth-signin');
  });

  it('is a no-op for an unknown canonical id', () => {
    expect(setDokIdPrefix(cfg(), 'nope', 'X')).toEqual(cfg());
  });
});

describe('excludeGroup', () => {
  it('excludes every feature in a group, and re-includes them', () => {
    const off = excludeGroup(cfg(), 'a', true);
    expect(off.groups.find((g) => g.group_id === 'a')?.features.every((f) => f.decision === 'exclude')).toBe(true);
    const on = excludeGroup(off, 'a', false);
    expect(on.groups.find((g) => g.group_id === 'a')?.features.every((f) => f.decision === 'keep')).toBe(true);
  });
});

describe('counts + recomputeStats', () => {
  it('counts doks/excluded/domains from live state', () => {
    const off = toggleExcludeFeature(cfg(), 'f1');
    expect(countDoks(off)).toBe(2);      // f2, f3 remain
    expect(countExcluded(off)).toBe(1);  // f1
    expect(countDomains(off)).toBe(2);
  });
  it('recomputeStats reflects exclusions and merges', () => {
    const base = cfg();
    base.groups[0].features[0].decision = 'merge';
    base.groups[0].features[0].members = ['f1', 'f1b'];
    const out = recomputeStats(toggleExcludeFeature(base, 'f2'));
    expect(out.stats.consolidatedFeatures).toBe(2); // f1(merge)+f3, f2 excluded
    expect(out.stats.excluded).toBe(1);
    expect(out.stats.merges).toBe(1);
  });
});
