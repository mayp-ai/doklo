import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));

vi.mock('../src/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm-client.js')>();
  return { ...actual, callModel: callModelMock };
});

import { consolidateFeatures, type ConsolidateProgressEvent } from '../src/consolidator.js';
import type { ExistingDokIdentity } from '../src/id-reconciliation.js';
import type { ConsolidatedFeatureConfig, FeatureConfig } from '../src/legacy-types.js';

const EXISTING: ExistingDokIdentity[] = [{
  dok_id: 'AUTH-SIGNIN',
  service_id: 'web',
  canonical_feature_id: 'auth-signin',
  primary_route: '/auth/signin',
}];

function features(): FeatureConfig {
  return {
    projectName: 'demo',
    projectRoot: '/demo',
    generatedAt: '2026-01-01T00:00:00.000Z',
    totalFiles: 1,
    terminology: {},
    unmappedFiles: [],
    sharedInfrastructure: {
      sharedComponents: [],
      sharedUtils: [],
      sharedHooks: [],
      sharedTypes: [],
      sharedStores: [],
    },
    featureGroups: [{
      id: 'auth',
      label: 'Auth',
      routePrefix: '/auth',
      description: '',
      enabled: true,
      totalFileCount: 1,
      features: [{
        id: 'auth-signin',
        label: 'Sign in',
        routePath: '/auth/signin',
        entryPoint: 'app/auth/signin/page.tsx',
        files: [{
          path: 'app/auth/signin/page.tsx',
          role: 'entry',
          depth: 0,
          isShared: false,
        }],
        apiRoutes: [],
        components: [],
        stores: [],
        enabled: true,
      }],
    }],
  };
}

/** Canned LLM answer proposing `prefix` for the single `auth-signin` feature. */
function llmAnswers(prefix: string): void {
  callModelMock.mockResolvedValue({
    success: true,
    content: JSON.stringify({
      groups: [{
        group_id: 'auth',
        group_label: 'Auth',
        decisions: [{
          canonical_id: 'auth-signin',
          label: 'Sign in',
          decision: 'keep',
          members: ['auth-signin'],
          primary_route: '/auth/signin',
          reason: '',
          dok_id_prefix: prefix,
        }],
      }],
    }),
    usage: null,
    processingTime: 1,
    error: null,
  });
}

function prefixOf(config: ConsolidatedFeatureConfig | null): string | undefined {
  return config?.groups[0]?.features[0]?.dok_id_prefix;
}

describe('consolidateFeatures — id reconciliation', () => {
  beforeEach(() => {
    callModelMock.mockReset();
  });

  it('lists the workspace s existing Doks in the prompt', async () => {
    llmAnswers('AUTH-SIGNIN');

    const result = await consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: EXISTING,
    });

    expect(result.prompt).toContain('## Existing Doks (reuse these ids when the feature matches)');
    expect(result.prompt).toContain('- `AUTH-SIGNIN` — feature `auth-signin`, route `/auth/signin`');
  });

  it('omits the existing-Dok section on a first generation', async () => {
    llmAnswers('AUTH-SIGNIN');

    const result = await consolidateFeatures(features(), { serviceId: 'web' });

    expect(result.prompt).not.toContain('Existing Doks');
  });

  it('keeps the existing id when the model proposes a rename', async () => {
    llmAnswers('AUTH-LOGIN');

    const result = await consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: EXISTING,
    });

    expect(prefixOf(result.config)).toBe('AUTH-SIGNIN');
  });

  it('leaves the model s id alone when nothing matches it', async () => {
    llmAnswers('AUTH-LOGIN');

    const result = await consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: [{
        dok_id: 'BILLING',
        service_id: 'web',
        canonical_feature_id: 'billing',
        primary_route: '/billing',
      }],
    });

    expect(prefixOf(result.config)).toBe('AUTH-LOGIN');
  });

  it('refuses an id another service already owns', async () => {
    llmAnswers('AUTH');

    const result = await consolidateFeatures(features(), {
      serviceId: 'web',
      usedPrefixes: ['AUTH'],
    });

    // Falls back to the deterministic suggestion for this feature rather than
    // minting a duplicate of the admin service's AUTH.
    expect(prefixOf(result.config)).toBe('AUTH-SIGNIN');
  });

  it('fails closed when the model gives a deleted Dok s id to another feature', async () => {
    // AUTH-SIGNIN belongs to auth-legacy, a feature that no longer exists. The
    // model applied its id to a different feature; no ladder rung matches, so
    // the reuse is unproven — surface it instead of letting the new feature
    // inherit the old Dok's file, version and external ids.
    llmAnswers('AUTH-SIGNIN');

    await expect(consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: [{
        dok_id: 'AUTH-SIGNIN',
        service_id: 'web',
        canonical_feature_id: 'auth-legacy',
        primary_route: '/auth/legacy',
      }],
    })).rejects.toThrow(/AUTH-SIGNIN/);
  });

  it('announces a feature taking over a Dok that has no provenance', async () => {
    // Pre-origins Dok: nothing can match it, so the guard lets the reuse
    // through (see assertNoUnpinnedIdCapture). The run still has to say so —
    // AUTH-SIGNIN.json is about to describe whatever `auth-signin` is now.
    llmAnswers('AUTH-SIGNIN');
    const events: ConsolidateProgressEvent[] = [];

    const result = await consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: [{ dok_id: 'AUTH-SIGNIN', service_id: 'web' }],
      onProgress: (event) => events.push(event),
    });

    expect(events).toContainEqual({
      stage: 'unverified-id-reuse',
      dokId: 'AUTH-SIGNIN',
      canonicalId: 'auth-signin',
    });
    // Advisory only — the consolidation still succeeds and keeps the id.
    expect(result.success).toBe(true);
    expect(prefixOf(result.config)).toBe('AUTH-SIGNIN');
  });

  it('stays quiet when the reused id carries matching provenance', async () => {
    llmAnswers('AUTH-SIGNIN');
    const events: ConsolidateProgressEvent[] = [];

    await consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: EXISTING,
      onProgress: (event) => events.push(event),
    });

    expect(events.some((event) => event.stage === 'unverified-id-reuse')).toBe(false);
  });

  it('carries the member source files through the pinned config', async () => {
    llmAnswers('AUTH-LOGIN');

    const result = await consolidateFeatures(features(), {
      serviceId: 'web',
      existingIdentities: EXISTING,
    });

    // attachSourceFiles runs after pinning — provenance must survive the copy.
    expect(result.config?.groups[0]?.features[0]?.source_files)
      .toEqual(['app/auth/signin/page.tsx']);
  });
});
