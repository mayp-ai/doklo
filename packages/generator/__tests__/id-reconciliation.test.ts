import { describe, expect, it } from 'vitest';
import type { DokHistoryEntry, DokMeta, DokOrigin } from '@doklo-beta/core';
import {
  assertNoUnpinnedIdCapture,
  carryForwardMeta,
  ExistingDokIdConflictError,
  pinExistingDokIds,
  upsertOriginsByService,
  type ExistingDokIdentity,
  type UnverifiedIdReuse,
} from '../src/id-reconciliation.js';
import type {
  ConsolidatedFeature,
  ConsolidatedFeatureConfig,
} from '../src/legacy-types.js';

const T0 = '2026-01-01T00:00:00.000Z';

function feature(
  canonicalId: string,
  prefix: string,
  primaryRoute = `/${canonicalId}`,
  overrides: Partial<ConsolidatedFeature> = {},
): ConsolidatedFeature {
  return {
    canonical_id: canonicalId,
    label: canonicalId,
    decision: 'keep',
    members: [canonicalId],
    primary_route: primaryRoute,
    reason: '',
    user_reviewed: false,
    dok_id_prefix: prefix,
    ...overrides,
  };
}

function consolidatedWith(features: ConsolidatedFeature[]): ConsolidatedFeatureConfig {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: T0,
    generatedAt: T0,
    model: 'test',
    originalFeatureIds: features.flatMap((f) => f.members),
    groups: [{ group_id: 'auth', label: 'auth', features, excluded: [] }],
    userReviewed: false,
    stats: {
      originalFeatures: features.length,
      consolidatedFeatures: features.length,
      merges: 0,
      excluded: 0,
    },
  };
}

function featureById(
  config: ConsolidatedFeatureConfig,
  canonicalId: string,
): ConsolidatedFeature {
  const found = config.groups
    .flatMap((group) => group.features)
    .find((f) => f.canonical_id === canonicalId);
  if (!found) throw new Error(`no feature ${canonicalId}`);
  return found;
}

describe('pinExistingDokIds', () => {
  it('pins by service+canonical_feature_id over LLM suggestion', () => {
    const { config, pinned } = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-LOGIN', '/auth/signin')]),
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' }],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-SIGNIN');
    expect(pinned).toEqual([{ canonical_id: 'auth-signin', dok_id: 'AUTH-SIGNIN' }]);
  });

  it('pins by primary_route when the canonical id changed', () => {
    const { config, pinned } = pinExistingDokIds(
      consolidatedWith([feature('auth-login-v2', 'AUTH-LOGIN', '/auth/signin')]),
      [{
        dok_id: 'AUTH-SIGNIN',
        service_id: 'web',
        canonical_feature_id: 'auth-signin',
        primary_route: '/auth/signin',
      }],
      'web',
    );

    expect(featureById(config, 'auth-login-v2').dok_id_prefix).toBe('AUTH-SIGNIN');
    expect(pinned).toEqual([{ canonical_id: 'auth-login-v2', dok_id: 'AUTH-SIGNIN' }]);
  });

  it('reports unmatched existing doks as orphans', () => {
    const { config, pinned, orphans } = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')]),
      [
        { dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' },
        { dok_id: 'AUTH-INVITE', service_id: 'web', canonical_feature_id: 'auth-invite' },
      ],
      'web',
    );

    expect(orphans).toEqual(['AUTH-INVITE']);
    // The already-correct id still counts as reused, not orphaned.
    expect(pinned).toEqual([{ canonical_id: 'auth-signin', dok_id: 'AUTH-SIGNIN' }]);
    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-SIGNIN');
  });

  it('never pins the same existing id onto two features', () => {
    const { config, pinned } = pinExistingDokIds(
      consolidatedWith([
        feature('auth-signin', 'AUTH-A', '/auth/signin'),
        feature('auth-signin-mobile', 'AUTH-B', '/auth/signin'),
      ]),
      [{
        dok_id: 'AUTH-SIGNIN',
        service_id: 'web',
        canonical_feature_id: 'auth-signin',
        primary_route: '/auth/signin',
      }],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-SIGNIN');
    expect(featureById(config, 'auth-signin-mobile').dok_id_prefix).toBe('AUTH-B');
    expect(pinned).toEqual([{ canonical_id: 'auth-signin', dok_id: 'AUTH-SIGNIN' }]);
  });

  it('ignores existing doks that belong to another service', () => {
    const { config, pinned, orphans } = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-LOGIN', '/auth/signin')]),
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'admin', canonical_feature_id: 'auth-signin' }],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-LOGIN');
    expect(pinned).toEqual([]);
    expect(orphans).toEqual([]);
  });

  it('does not mutate the input config', () => {
    const input = consolidatedWith([feature('auth-signin', 'AUTH-LOGIN', '/auth/signin')]);
    const { config } = pinExistingDokIds(
      input,
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' }],
      'web',
    );

    expect(input.groups[0]!.features[0]!.dok_id_prefix).toBe('AUTH-LOGIN');
    expect(config).not.toBe(input);
    expect(config.groups[0]!.features[0]).not.toBe(input.groups[0]!.features[0]);
  });

  it('skips a pin that would duplicate another feature s proposed id', () => {
    // The LLM moved AUTH-SIGNIN onto a different feature. Pinning it back would
    // produce two features with the same id, so the pin is dropped instead.
    const { config, pinned } = pinExistingDokIds(
      consolidatedWith([
        feature('auth-signin', 'AUTH-LOGIN', '/auth/signin'),
        feature('auth-signup', 'AUTH-SIGNIN', '/auth/signup'),
      ]),
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' }],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-LOGIN');
    expect(featureById(config, 'auth-signup').dok_id_prefix).toBe('AUTH-SIGNIN');
    expect(pinned).toEqual([]);
  });

  it('pins neither side when the model swaps two existing ids', () => {
    // Conservative by design: resolving a swap would mean deciding which pin
    // gets to displace the other, and a wrong order can cascade into a
    // duplicate. Pinning leaves both as proposed; assertNoUnpinnedIdCapture is
    // what then refuses the run rather than letting the two Doks trade content.
    const { config, pinned } = pinExistingDokIds(
      consolidatedWith([
        feature('auth-signin', 'AUTH-SIGNUP', '/auth/signin'),
        feature('auth-signup', 'AUTH-SIGNIN', '/auth/signup'),
      ]),
      [
        { dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' },
        { dok_id: 'AUTH-SIGNUP', service_id: 'web', canonical_feature_id: 'auth-signup' },
      ],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-SIGNUP');
    expect(featureById(config, 'auth-signup').dok_id_prefix).toBe('AUTH-SIGNIN');
    expect(pinned).toEqual([]);
  });

  it('degrades to a no-op when no existing doks are known', () => {
    const { config, pinned, orphans } = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-LOGIN', '/auth/signin')]),
      [],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-LOGIN');
    expect(pinned).toEqual([]);
    expect(orphans).toEqual([]);
  });

  it('never pins an excluded decision', () => {
    const { config, pinned, orphans } = pinExistingDokIds(
      consolidatedWith([
        feature('auth-signin', 'AUTH-LOGIN', '/auth/signin', { decision: 'exclude' }),
      ]),
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' }],
      'web',
    );

    expect(featureById(config, 'auth-signin').dok_id_prefix).toBe('AUTH-LOGIN');
    expect(pinned).toEqual([]);
    expect(orphans).toEqual(['AUTH-SIGNIN']);
  });

  it('does not call an id orphaned while a feature still holds it', () => {
    // Both pins are dropped by the swap guard, but each id is still assigned —
    // to the other feature. Reporting them as orphans would tell the user their
    // files are unclaimed at the exact moment two features are fighting over them.
    const { orphans } = pinExistingDokIds(
      consolidatedWith([
        feature('auth-signin', 'AUTH-SIGNUP', '/auth/signin'),
        feature('auth-signup', 'AUTH-SIGNIN', '/auth/signup'),
      ]),
      [
        { dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' },
        { dok_id: 'AUTH-SIGNUP', service_id: 'web', canonical_feature_id: 'auth-signup' },
      ],
      'web',
    );

    expect(orphans).toEqual([]);
  });

  it('does not orphan a provenance-less id a feature took over', () => {
    // Nothing can pin a Dok with no provenance, but the feature holding its id
    // will overwrite the file — that is a takeover, not an abandoned file.
    const { orphans } = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')]),
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }],
      'web',
    );

    expect(orphans).toEqual([]);
  });
});

describe('origins across regenerations', () => {
  /** The hub loader's projection: one identity per origin entry. */
  function identities(dokId: string, origins: readonly DokOrigin[]): ExistingDokIdentity[] {
    return origins.map((origin) => ({ dok_id: dokId, ...origin }));
  }

  it('stops a later feature from inheriting a renamed feature s old canonical id', () => {
    // Run 1 produced AUTH-SIGNIN from the feature `auth-signin`.
    const run1: DokOrigin[] = [{
      service_id: 'web',
      canonical_feature_id: 'auth-signin',
      primary_route: '/auth/signin',
    }];

    // Run 2 renamed that feature to `auth-login`; the route pins it to the same
    // Dok, and generate stamps this run's provenance.
    const pinnedRun2 = pinExistingDokIds(
      consolidatedWith([feature('auth-login', 'AUTH-LOGIN', '/auth/signin')]),
      identities('AUTH-SIGNIN', run1),
      'web',
    );
    expect(featureById(pinnedRun2.config, 'auth-login').dok_id_prefix).toBe('AUTH-SIGNIN');

    const run2 = upsertOriginsByService(run1, [{
      service_id: 'web',
      canonical_feature_id: 'auth-login',
      primary_route: '/auth/signin',
    }]);

    // Run 3: an unrelated new feature happens to be named `auth-signin` — the id
    // the renamed feature used to answer to. Keeping the stale origin would pin
    // it onto AUTH-SIGNIN and hand it another Dok's file, history and links.
    const run3 = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-INVITE', '/auth/invite')]),
      identities('AUTH-SIGNIN', run2),
      'web',
    );

    expect(featureById(run3.config, 'auth-signin').dok_id_prefix).toBe('AUTH-INVITE');
    expect(run3.pinned).toEqual([]);
  });
});

describe('assertNoUnpinnedIdCapture', () => {
  function check(
    features: ConsolidatedFeature[],
    existing: ExistingDokIdentity[],
  ): UnverifiedIdReuse[] {
    const { config, pinned } = pinExistingDokIds(consolidatedWith(features), existing, 'web');
    return assertNoUnpinnedIdCapture(config, existing, 'web', pinned);
  }

  it('rejects an id that belongs to a different existing Dok', () => {
    // auth-legacy was deleted from the code this run. The model saw AUTH-SIGNIN
    // in the prompt's existing-id list and applied it to an unrelated feature:
    // nothing pins it, so without this gate the new feature would silently
    // inherit the deleted feature's file, history and external ids.
    expect(() => check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{
        dok_id: 'AUTH-SIGNIN',
        service_id: 'web',
        canonical_feature_id: 'auth-legacy',
        primary_route: '/auth/legacy',
      }],
    )).toThrow(ExistingDokIdConflictError);
  });

  it('names the id, the feature and the Dok s own feature in the error', () => {
    expect(() => check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{
        dok_id: 'AUTH-SIGNIN',
        service_id: 'web',
        canonical_feature_id: 'auth-legacy',
        primary_route: '/auth/legacy',
      }],
    )).toThrow(/AUTH-SIGNIN.*auth-signin.*auth-legacy/s);
  });

  it('accepts an id the ladder pinned to that very feature', () => {
    expect(() => check(
      [feature('auth-signin', 'AUTH-LOGIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' }],
    )).not.toThrow();
  });

  it('accepts an existing Dok that carries no provenance to contradict', () => {
    // A Dok generated before origins existed. The ladder cannot match it, so
    // reuse cannot be verified — but neither can it be disproved, and failing
    // here would block the first regeneration of every pre-origins workspace.
    expect(() => check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }],
    )).not.toThrow();
  });

  it('reports the exempted reuse instead of passing it over in silence', () => {
    // The exemption is a decision not to block, not a decision to hide: the
    // existing file keeps its id but is about to describe a feature nobody
    // proved is the same one.
    expect(check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }],
    )).toEqual([{ dok_id: 'AUTH-SIGNIN', canonical_id: 'auth-signin' }]);
  });

  it('reports a provenance-less id that is not scoped to any service', () => {
    expect(check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN' }],
    )).toEqual([{ dok_id: 'AUTH-SIGNIN', canonical_id: 'auth-signin' }]);
  });

  it('reports nothing when the provenance-less Dok keeps its id to itself', () => {
    expect(check(
      [feature('auth-signin', 'AUTH-LOGIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }],
    )).toEqual([]);
  });

  it('reports nothing when the reused id carries provenance that matches', () => {
    expect(check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' }],
    )).toEqual([]);
  });

  it('reports nothing for a provenance-less Dok owned by another service', () => {
    expect(check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'admin' }],
    )).toEqual([]);
  });

  it('never reports a claim the ladder pinned — a pin is the evidence', () => {
    // No rung matches a provenance-less identity today, so this states the rule
    // for whatever rung gets added next: reported means unproven, nothing else.
    const existing: ExistingDokIdentity[] = [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }];
    const { config } = pinExistingDokIds(
      consolidatedWith([feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')]),
      existing,
      'web',
    );

    expect(assertNoUnpinnedIdCapture(config, existing, 'web', [
      { canonical_id: 'auth-signin', dok_id: 'AUTH-SIGNIN' },
    ])).toEqual([]);
  });

  it('never reports an excluded feature', () => {
    expect(check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin', { decision: 'exclude' })],
      [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }],
    )).toEqual([]);
  });

  it('ignores ids owned by another service', () => {
    expect(() => check(
      [feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')],
      [{
        dok_id: 'AUTH-SIGNIN',
        service_id: 'admin',
        canonical_feature_id: 'auth-legacy',
        primary_route: '/auth/legacy',
      }],
    )).not.toThrow();
  });

  it('rejects a swap, where each feature takes the other s existing id', () => {
    expect(() => check(
      [
        feature('auth-signin', 'AUTH-SIGNUP', '/auth/signin'),
        feature('auth-signup', 'AUTH-SIGNIN', '/auth/signup'),
      ],
      [
        { dok_id: 'AUTH-SIGNIN', service_id: 'web', canonical_feature_id: 'auth-signin' },
        { dok_id: 'AUTH-SIGNUP', service_id: 'web', canonical_feature_id: 'auth-signup' },
      ],
    )).toThrow(ExistingDokIdConflictError);
  });

  it('passes a first generation with nothing on disk', () => {
    expect(() => check([feature('auth-signin', 'AUTH-SIGNIN', '/auth/signin')], []))
      .not.toThrow();
  });
});

describe('carryForwardMeta', () => {
  const h1: DokHistoryEntry = { version: 3, date: '2026-01-02', change: 'reviewed' };
  const o1: DokOrigin = {
    service_id: 'web',
    canonical_feature_id: 'auth-signin',
    primary_route: '/auth/signin',
  };

  it('carries forward version/history/external_ids/created_at/origins/previous_ids', () => {
    const merged = carryForwardMeta(
      {
        version: 3,
        history: [h1],
        external_ids: { notion: 'x' },
        created_at: T0,
        origins: [o1],
        previous_ids: ['AUTH-LOGIN'],
      },
      { version: 1, history: [] },
    );

    expect(merged.version).toBe(4);
    expect(merged.history).toEqual([h1]);
    expect(merged.external_ids).toEqual({ notion: 'x' });
    expect(merged.created_at).toBe(T0);
    expect(merged.origins).toEqual([o1]);
    expect(merged.previous_ids).toEqual(['AUTH-LOGIN']);
  });

  it('returns fresh meta untouched when no existing file', () => {
    const fresh: DokMeta = {
      version: 1,
      history: [],
      logic_hash: 'abc',
      source_anchors: [{ file: 'app/page.tsx' }],
    };

    expect(carryForwardMeta(undefined, fresh)).toEqual(fresh);
  });

  it('keeps the freshly generated evidence fields', () => {
    const merged = carryForwardMeta(
      {
        version: 1,
        history: [],
        logic_hash: 'stale',
        source_anchors: [{ file: 'old.tsx' }],
        anchor_service_id: 'admin',
        generation_confidence: 0.1,
      },
      {
        version: 1,
        history: [],
        logic_hash: 'fresh',
        source_anchors: [{ file: 'new.tsx' }],
        anchor_service_id: 'web',
        generation_confidence: 0.9,
      },
    );

    expect(merged.logic_hash).toBe('fresh');
    expect(merged.source_anchors).toEqual([{ file: 'new.tsx' }]);
    expect(merged.anchor_service_id).toBe('web');
    expect(merged.generation_confidence).toBe(0.9);
  });

  it('drops the human-edit marker — regeneration replaces human prose', () => {
    const merged = carryForwardMeta(
      { version: 1, history: [], edited_by_human: true },
      { version: 1, history: [] },
    );

    expect(merged.edited_by_human).toBeUndefined();
  });
});

describe('upsertOriginsByService', () => {
  const web: DokOrigin = { service_id: 'web', canonical_feature_id: 'auth-signin' };
  const admin: DokOrigin = { service_id: 'admin', canonical_feature_id: 'auth-signin' };

  it('keys on service_id alone — one entry per service, never two', () => {
    expect(upsertOriginsByService([web, admin], [web])).toEqual([web, admin]);
  });

  it('replaces this service s entry when the feature was renamed', () => {
    // The whole point of the per-service key: a renamed feature must not leave
    // its old canonical id behind as a live matching key for the next run.
    expect(
      upsertOriginsByService([web], [{ ...web, canonical_feature_id: 'auth-login' }]),
    ).toEqual([{ service_id: 'web', canonical_feature_id: 'auth-login' }]);
  });

  it('refreshes the route of an existing origin in place', () => {
    expect(
      upsertOriginsByService(
        [{ ...web, primary_route: '/old' }, admin],
        [{ ...web, primary_route: '/new' }],
      ),
    ).toEqual([{ ...web, primary_route: '/new' }, admin]);
  });

  it('leaves other services entries untouched', () => {
    expect(
      upsertOriginsByService(
        [web, admin],
        [{ service_id: 'web', canonical_feature_id: 'auth-login', primary_route: '/login' }],
      ),
    ).toEqual([
      { service_id: 'web', canonical_feature_id: 'auth-login', primary_route: '/login' },
      admin,
    ]);
  });

  it('appends origins from a new service', () => {
    expect(upsertOriginsByService([web], [admin])).toEqual([web, admin]);
  });

  it('stays bounded to the number of services across repeated renames', () => {
    let origins: DokOrigin[] = [web];
    for (const canonical of ['auth-login', 'auth-sign-in', 'auth-entry']) {
      origins = upsertOriginsByService(origins, [
        { service_id: 'web', canonical_feature_id: canonical },
      ]);
    }

    expect(origins).toEqual([{ service_id: 'web', canonical_feature_id: 'auth-entry' }]);
  });

  it('tolerates undefined inputs', () => {
    expect(upsertOriginsByService(undefined, [web])).toEqual([web]);
    expect(upsertOriginsByService([web], undefined)).toEqual([web]);
    expect(upsertOriginsByService(undefined, undefined)).toEqual([]);
  });
});
