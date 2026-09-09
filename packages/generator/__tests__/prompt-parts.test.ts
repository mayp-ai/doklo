// Prompt caching contract: consolidate/dok-generate prompts split into a
// shared, per-run-stable systemPrompt (cacheable prefix) and a per-item
// userPrompt. Every dok call in one generate run must share the exact same
// systemPrompt bytes, or no provider cache ever hits.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModelMock } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
}));

vi.mock('../src/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm-client.js')>();
  return { ...actual, callModel: callModelMock };
});

import { joinPromptParts } from '../src/llm-client.js';
import {
  buildDokPrompt,
  buildDokPromptParts,
  generateDokForFeature,
  type DokGenContext,
} from '../src/dok-generator.js';
import {
  buildConsolidationPromptForFeatures,
  buildConsolidationPromptParts,
  consolidateFeatures,
} from '../src/consolidator.js';
import type { FeatureConfig } from '../src/legacy-types.js';

const featureA = {
  canonical_id: 'auth-signin',
  label: 'Sign in',
  dok_id_prefix: 'AUTH',
  primary_route: '/auth/signin',
  files: ['app/auth/signin/page.tsx'],
  members: [{ id: 'auth-signin', label: 'Sign in', route: '/auth/signin' }],
};

const featureB = {
  canonical_id: 'cart-checkout',
  label: 'Checkout',
  dok_id_prefix: 'CART',
  primary_route: '/cart/checkout',
  files: ['app/cart/checkout/page.tsx'],
  members: [{ id: 'cart-checkout', label: 'Checkout', route: '/cart/checkout' }],
};

const runCtx: Omit<DokGenContext, 'dokId' | 'fileContext' | 'suggestedActorRole'> = {
  defaultLocale: 'ko',
  knownRoles: ['ROLE-USER', 'ROLE-ADMIN'],
  lexiconTerms: ['마일스톤', '사업진단'],
};

const ctxA: DokGenContext = {
  ...runCtx,
  dokId: 'AUTH-001',
  fileContext: { 'app/auth/signin/page.tsx': 'export default function SignIn(){}' },
  suggestedActorRole: 'ROLE-USER',
};

const ctxB: DokGenContext = {
  ...runCtx,
  dokId: 'CART-001',
  fileContext: { 'app/cart/checkout/page.tsx': 'export default function Checkout(){}' },
  suggestedActorRole: 'ROLE-ADMIN',
};

describe('buildDokPromptParts', () => {
  it('produces an identical systemPrompt for every dok call in the same run', () => {
    const a = buildDokPromptParts(featureA, ctxA);
    const b = buildDokPromptParts(featureB, ctxB);
    expect(a.systemPrompt).toBe(b.systemPrompt);
  });

  it('keeps per-item facts (dokId, feature, files, actor hint) out of the systemPrompt', () => {
    const a = buildDokPromptParts(featureA, ctxA);
    expect(a.systemPrompt).not.toContain('AUTH-001');
    expect(a.systemPrompt).not.toContain('/auth/signin');
    expect(a.systemPrompt).not.toContain('export default function SignIn');
    expect(a.systemPrompt).not.toContain('Suggested primary actor');
  });

  it('carries the shared run context (schema, roles, terminology, language) in the systemPrompt', () => {
    const a = buildDokPromptParts(featureA, ctxA);
    expect(a.systemPrompt).toContain('type Dok');
    expect(a.systemPrompt).toContain('ROLE-USER');
    expect(a.systemPrompt).toContain('ROLE-ADMIN');
    expect(a.systemPrompt).toContain('# Terminology');
    expect(a.systemPrompt).toContain('마일스톤');
    expect(a.systemPrompt).toMatch(/한국어/);
  });

  it('carries the per-item facts in the userPrompt', () => {
    const a = buildDokPromptParts(featureA, ctxA);
    expect(a.userPrompt).toContain('AUTH-001');
    expect(a.userPrompt).toContain('/auth/signin');
    expect(a.userPrompt).toContain('export default function SignIn');
    expect(a.userPrompt).toContain('Suggested primary actor');
  });

  it('joins back into buildDokPrompt exactly (trust-gate canonical serialization)', () => {
    const parts = buildDokPromptParts(featureA, ctxA);
    expect(joinPromptParts(parts)).toBe(buildDokPrompt(featureA, ctxA));
  });
});

const featuresConfigA: FeatureConfig = {
  projectName: 'demo-a',
  generatedAt: '2026-01-01T00:00:00.000Z',
  featureGroups: [{
    id: 'auth',
    label: 'Auth',
    totalFileCount: 1,
    features: [{
      id: 'auth-signin',
      label: 'Sign in',
      routePath: '/auth/signin',
      entryPoint: 'app/auth/signin/page.tsx',
      files: [],
      apiRoutes: [],
      components: [],
      stores: [],
      enabled: true,
    }],
  }],
  unmappedFiles: [],
} as unknown as FeatureConfig;

const featuresConfigB: FeatureConfig = {
  ...featuresConfigA,
  projectName: 'demo-b',
  featureGroups: [{
    ...featuresConfigA.featureGroups[0]!,
    id: 'cart',
    label: 'Cart',
  }],
} as unknown as FeatureConfig;

describe('buildConsolidationPromptParts', () => {
  it('produces an identical systemPrompt across projects (static instructions only)', () => {
    const a = buildConsolidationPromptParts(featuresConfigA);
    const b = buildConsolidationPromptParts(featuresConfigB);
    expect(a.systemPrompt).toBe(b.systemPrompt);
  });

  it('keeps project name and feature groups in the userPrompt', () => {
    const a = buildConsolidationPromptParts(featuresConfigA);
    expect(a.systemPrompt).not.toContain('demo-a');
    expect(a.userPrompt).toContain('demo-a');
    expect(a.userPrompt).toContain('auth-signin');
  });

  it('joins back into buildConsolidationPromptForFeatures exactly', () => {
    const parts = buildConsolidationPromptParts(featuresConfigA);
    expect(joinPromptParts(parts)).toBe(buildConsolidationPromptForFeatures(featuresConfigA));
  });
});

describe('cacheable system prompt threading', () => {
  beforeEach(() => {
    callModelMock.mockReset();
    callModelMock.mockResolvedValue({
      success: false,
      content: null,
      usage: null,
      processingTime: 0,
      error: { type: 'ai_sdk_error', message: 'stop after prompt capture' },
    });
  });

  it('generateDokForFeature sends split prompts with cacheableSystemPrompt on', async () => {
    const parts = buildDokPromptParts(featureA, ctxA);
    await generateDokForFeature(featureA, ctxA, {});
    expect(callModelMock.mock.calls[0]![0]).toMatchObject({
      systemPrompt: parts.systemPrompt,
      userPrompt: parts.userPrompt,
      cacheableSystemPrompt: true,
    });
  });

  it('generateDokForFeature uses caller-authorized prompt parts verbatim', async () => {
    const prepared = { systemPrompt: 'AUTHORIZED_SYSTEM', userPrompt: 'AUTHORIZED_USER' };
    const result = await generateDokForFeature(featureA, ctxA, { preparedPrompt: prepared });
    expect(callModelMock.mock.calls[0]![0]).toMatchObject({
      systemPrompt: 'AUTHORIZED_SYSTEM',
      userPrompt: 'AUTHORIZED_USER',
      cacheableSystemPrompt: true,
    });
    expect(result.prompt).toBe(joinPromptParts(prepared));
  });

  it('consolidateFeatures sends split prompts with cacheableSystemPrompt on', async () => {
    const parts = buildConsolidationPromptParts(featuresConfigA);
    await consolidateFeatures(featuresConfigA, {});
    expect(callModelMock.mock.calls[0]![0]).toMatchObject({
      systemPrompt: parts.systemPrompt,
      userPrompt: parts.userPrompt,
      cacheableSystemPrompt: true,
    });
  });

  it('consolidateFeatures uses caller-authorized prompt parts verbatim', async () => {
    const prepared = { systemPrompt: 'AUTHORIZED_SYSTEM', userPrompt: 'AUTHORIZED_USER' };
    const result = await consolidateFeatures(featuresConfigA, { preparedPrompt: prepared });
    expect(callModelMock.mock.calls[0]![0]).toMatchObject({
      systemPrompt: 'AUTHORIZED_SYSTEM',
      userPrompt: 'AUTHORIZED_USER',
      cacheableSystemPrompt: true,
    });
    expect(result.prompt).toBe(joinPromptParts(prepared));
  });
});
