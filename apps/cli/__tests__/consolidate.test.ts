import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  formatUnverifiedIdReuse,
  runConsolidate,
  ScanCacheMissingError,
  type ConsolidateDeps,
} from '../src/commands/consolidate.js';
import {
  registerLlmRun,
  reserveRegisteredLlmCall,
} from '../src/lib/llm-cost-cap.js';
import {
  authorizeLlmRun,
  buildLlmRunPlan,
} from '../src/lib/llm-preflight.js';
import { resolveContainedOutputPath } from '@doklo-beta/generator';

async function paidConsent(root: string) {
  const preview = await runConsolidate({ root, dryRun: true });
  const plan = buildLlmRunPlan({
    llm: {
      providerKind: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'keychain',
      apiKey: 'never-in-plan',
    },
    previews: preview.results.map((result) => result.preview),
    candidateFiles: [],
    workItems: preview.results.map((result) => ({
      phase: 'consolidate' as const,
      serviceId: result.serviceId,
      id: result.serviceId,
    })),
    calls: { consolidate: preview.results.length, lexicon: 0, generateMax: 0, judgeMax: 0 },
    reservedTokensMax: 1000,
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    plan,
    authorizedRun: await authorizeLlmRun(root, plan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false }),
  };
}

async function codexConsent(root: string, codexFetch: typeof fetch) {
  const preview = await runConsolidate({ root, dryRun: true });
  const llm = {
    providerKind: 'openai' as const,
    model: 'openai/gpt-5.6-terra',
    authSource: 'oauth' as const,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    fetch: codexFetch,
  };
  const plan = buildLlmRunPlan({
    llm,
    previews: preview.results.map((result) => result.preview),
    candidateFiles: [],
    workItems: preview.results.map((result) => ({
      phase: 'consolidate' as const,
      serviceId: result.serviceId,
      id: result.serviceId,
    })),
    calls: {
      consolidate: preview.results.length,
      lexicon: 0,
      generateMax: 0,
      judgeMax: 0,
    },
    reservedTokensMax: 1000,
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    plan,
    authorizedRun: await authorizeLlmRun(
      root,
      plan,
      llm,
      { yes: true, isTTY: false },
    ),
  };
}

async function tmpInitialized(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-cons-'));
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [
        { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
      ],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  return root;
}

async function writeScanCache(root: string, serviceId: string): Promise<void> {
  for (const source of [
    'app/auth/signin/page.tsx',
    'app/admin/users/page.tsx',
  ]) {
    const absolute = join(root, source);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, 'export default function Page() { return null; }\n');
  }
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.scan.json`),
    JSON.stringify({
      framework: 'nextjs',
      root: join(root, '.'),
      files: ['app/auth/signin/page.tsx', 'app/admin/users/page.tsx'],
      routes: [
        {
          path: '/auth/signin',
          kind: 'page',
          file: 'app/auth/signin/page.tsx',
          dynamic_params: [],
          layout_chain: [],
        },
        {
          path: '/admin/users',
          kind: 'page',
          file: 'app/admin/users/page.tsx',
          dynamic_params: [],
          layout_chain: [],
        },
      ],
      components: [],
      stores: [],
    }),
    'utf-8',
  );
}

async function writeHubDok(
  root: string,
  dokId: string,
  origins: Array<{ service_id: string; canonical_feature_id: string; primary_route?: string }>,
): Promise<void> {
  await mkdir(join(root, '.doklo/hub/doks'), { recursive: true });
  await writeFile(
    join(root, '.doklo/hub/doks', `${dokId}.json`),
    JSON.stringify({
      dok_id: dokId,
      name: dokId,
      description: 'An existing Dok from a previous run.',
      surfaces: origins.map((origin) => origin.service_id),
      _meta: { version: 1, history: [], origins },
    }),
    'utf-8',
  );
}

/** Minimal consolidation answer: one kept feature per requested prefix. */
function fakeConsolidation(_root: string, prefixes: string[]) {
  return vi.fn(async () => ({
    success: true,
    prompt: '<prompt>',
    estimatedInputTokens: 1,
    estimatedOutputTokens: 1,
    usage: null,
    config: {
      projectName: 'demo',
      basedOnFeaturesAt: 't',
      generatedAt: 't',
      model: 'm',
      originalFeatureIds: [],
      userReviewed: false,
      stats: { originalFeatures: 0, consolidatedFeatures: 0, merges: 0, excluded: 0 },
      groups: [{
        group_id: 'auth',
        label: 'auth',
        excluded: [],
        features: prefixes.map((prefix, index) => ({
          canonical_id: `feat-${index}`,
          label: `Feature ${index}`,
          decision: 'keep' as const,
          members: [`feat-${index}`],
          primary_route: `/x${index}`,
          reason: '',
          user_reviewed: false,
          dok_id_prefix: prefix,
        })),
      }],
    },
  }));
}

/** Consolidation that also reports an unverifiable id reuse on the progress channel. */
function fakeConsolidationReporting(
  root: string,
  prefixes: string[],
  notice: { dokId: string; canonicalId: string },
) {
  const base = fakeConsolidation(root, prefixes);
  return vi.fn(async (
    _features: Parameters<ConsolidateDeps['consolidateFeatures']>[0],
    options?: Parameters<ConsolidateDeps['consolidateFeatures']>[1],
  ) => {
    options?.onProgress?.({ stage: 'unverified-id-reuse', ...notice });
    return base();
  });
}

describe('runConsolidate', () => {
  it('throws ScanCacheMissingError when scan cache missing', async () => {
    const root = await tmpInitialized();
    await expect(runConsolidate({ root })).rejects.toThrowError(
      ScanCacheMissingError,
    );
  });

  it('dry-run skips the LLM and reports the would-be feature count', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');

    let llmCalled = false;
    const deps: ConsolidateDeps = {
      consolidateFeatures: async () => {
        llmCalled = true;
        throw new Error('should not call LLM in dry-run');
      },
    };

    const result = await runConsolidate({ root, dryRun: true }, deps);
    expect(llmCalled).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.featureGroupCount).toBe(2);
    expect(result.results[0]?.outputPath).toBeNull();
    expect(result.results[0]?.preview).toEqual({
      serviceId: 'web',
      sourceFeatureCount: 2,
      transmittedFiles: [
        'app/admin/users/page.tsx',
        'app/auth/signin/page.tsx',
      ],
      prompt: expect.any(String),
      estimatedInputTokens: expect.any(Number),
      estimatedOutputTokens: 32_768,
    });
  });

  it('rejects a direct paid call without matching plan consent before the worker runs', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('paid worker ran before consent');
    });

    await expect(runConsolidate({ root }, { consolidateFeatures })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        diagnostics: [expect.objectContaining({ code: 'LLM_CONSENT_REQUIRED' })],
      },
    });
    expect(consolidateFeatures).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/cache/web.consolidated.json'), 'utf-8')).rejects.toThrow();
  });

  it('rejects a valid receipt whose plan authorizes lexicon rather than consolidation', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const plan = buildLlmRunPlan({
      llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
      candidateFiles: [],
      workItems: [{ phase: 'lexicon', serviceId: 'workspace', id: 'code' }],
      calls: { consolidate: 0, lexicon: 1, generateMax: 0, judgeMax: 0 },
      preparedCalls: [{
        phase: 'lexicon',
        workItem: { phase: 'lexicon', serviceId: 'workspace', id: 'code' },
        prompt: 'unrelated',
        maxOutputTokens: 1,
      }],
      debugDir: join(root, '.doklo/debug'),
    });
    const authorizedRun = await authorizeLlmRun(root, plan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false });
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('unrelated plan reached consolidation worker');
    });

    await expect(runConsolidate(
      {
        root,
        authorizedRun,
      },
      { consolidateFeatures },
    )).rejects.toMatchObject({
      exitCode: 2,
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })] },
    });
    expect(consolidateFeatures).not.toHaveBeenCalled();
  });

  it('rejects an authorized run when a worker is invoked for another workspace root', async () => {
    const root = await tmpInitialized();
    const otherRoot = await tmpInitialized();
    await writeScanCache(root, 'web');
    await writeScanCache(otherRoot, 'web');
    const auth = await paidConsent(otherRoot);
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('cross-root capability reached provider');
    });

    await expect(runConsolidate({
      root,
      ...auth,
    }, { consolidateFeatures })).rejects.toMatchObject({
      exitCode: 2,
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_AUTHORIZED_RUN_ROOT_MISMATCH' })] },
    });
    expect(consolidateFeatures).not.toHaveBeenCalled();
  });

  it('rejects a forged authorized-run object before provider work', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('forged capability reached provider');
    });

    await expect(runConsolidate({
      root,
      authorizedRun: Object.freeze({ root }) as never,
    } as never, { consolidateFeatures })).rejects.toMatchObject({
      exitCode: 2,
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_AUTHORIZED_RUN_INVALID' })] },
    });
    expect(consolidateFeatures).not.toHaveBeenCalled();
  });

  it('checks the run cap before starting the paid consolidation worker', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    for (let index = 0; index < 5; index++) {
      const prior = await registerLlmRun(root, {
        receiptId: `prior-${index}`, planDigest: `prior-plan-${index}`, maxCalls: 1,
      });
      await reserveRegisteredLlmCall(prior, {
        callKey: `prior/${index}`,
        reservedTokens: 999_999,
      });
    }
    const auth = await paidConsent(root);
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('cost-capped worker must not run');
    });

    await expect(runConsolidate({ root, ...auth }, { consolidateFeatures })).rejects.toMatchObject({
      code: 'LLM_TOTAL_TOKEN_CAP',
    });
    expect(consolidateFeatures).not.toHaveBeenCalled();
  });

  it('writes <service>.consolidated.json on real run', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');

    const deps: ConsolidateDeps = {
      consolidateFeatures: async (features) => ({
        success: true,
        prompt: '<prompt>',
        estimatedInputTokens: 100,
        estimatedOutputTokens: 40,
        config: {
          projectName: features.projectName,
          basedOnFeaturesAt: features.generatedAt,
          generatedAt: new Date().toISOString(),
          model: 'claude-haiku-4-5',
          originalFeatureIds: features.featureGroups.flatMap((group) =>
            group.features.map((feature) => feature.id)),
          userReviewed: false,
          stats: {
            originalFeatures: 2,
            consolidatedFeatures: 2,
            excluded: 0,
            merges: 0,
          },
          groups: features.featureGroups.map((g) => ({
            group_id: g.id,
            label: g.label,
            features: g.features.map((f, index) => ({
              canonical_id: f.id,
              label: f.label,
              dok_id_prefix: index === 0 ? 'AUTH-SIGNIN' : 'ADMIN-USERS',
              decision: 'keep' as const,
              members: [f.id],
              primary_route: f.routePath,
              reason: 'Keep the route.',
              user_reviewed: false,
            })),
            excluded: [],
          })),
        },
      }),
    };

    const result = await runConsolidate({ root, ...await paidConsent(root) }, deps);
    expect(result.results).toHaveLength(1);
    const writtenPath = result.results[0]?.outputPath;
    expect(writtenPath).toBe(join(root, '.doklo/cache/web.consolidated.json'));
    const written = JSON.parse(await readFile(writtenPath!, 'utf-8'));
    expect(written.projectName).toBe('demo');
    expect(written.stats.consolidatedFeatures).toBe(2);
  });

  it('rejects invalid consolidator output before replacing the last valid cache', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const cachePath = join(root, '.doklo/cache/web.consolidated.json');
    const previous = {
      projectName: 'demo',
      basedOnFeaturesAt: '2026-01-01T00:00:00.000Z',
      generatedAt: '2026-01-01T00:01:00.000Z',
      model: 'anthropic/claude-sonnet-5',
      groups: [{
        group_id: 'auth',
        label: 'Auth',
        features: [{
          canonical_id: 'auth-signin',
          label: 'Sign in',
          decision: 'keep',
          members: ['auth-signin'],
          primary_route: '/auth/signin',
          reason: 'Keep the sign-in route.',
          user_reviewed: false,
          dok_id_prefix: 'AUTH-SIGNIN',
        }],
        excluded: [],
      }],
      originalFeatureIds: ['auth-signin'],
      userReviewed: false,
      stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
    };
    const previousText = `${JSON.stringify(previous, null, 2)}\n`;
    await writeFile(cachePath, previousText, 'utf-8');

    const consolidateFeatures = vi.fn(async () => ({
      success: true,
      prompt: '<prompt>',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      usage: null,
      config: {
        ...previous,
        groups: [{
          ...previous.groups[0],
          features: [{
            ...previous.groups[0]!.features[0],
            metadata: null,
          }],
        }],
      } as never,
    }));

    await expect(runConsolidate(
      { root, ...await paidConsent(root) },
      { consolidateFeatures },
    )).rejects.toThrow(/consolidat.*invalid|invalid.*consolidat/i);

    expect(await readFile(cachePath, 'utf-8')).toBe(previousText);
  });

  it('ignores environment backend overrides and passes the approved direct Anthropic route', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const previousBackend = process.env['DOKLO_LLM_BACKEND'];
    const previousModel = process.env['DOKLO_MODEL'];
    process.env['DOKLO_LLM_BACKEND'] = 'claude-code';
    process.env['DOKLO_MODEL'] = 'attacker/model';
    const consolidateFeatures = vi.fn(async (_features, options) => ({
      success: true,
      prompt: '<prompt>',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      usage: null,
      config: {
        projectName: 'demo', basedOnFeaturesAt: 't', generatedAt: 't', model: 'm',
        originalFeatureIds: [], userReviewed: false,
        stats: {
          originalFeatures: 0, consolidatedFeatures: 0, excluded: 0, merges: 0,
        },
        groups: [],
      },
    }));
    try {
      await runConsolidate({ root, ...await paidConsent(root) }, { consolidateFeatures });
      expect(consolidateFeatures).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          providerKind: 'anthropic',
          model: 'anthropic/claude-sonnet-5',
          preparedPrompt: expect.objectContaining({
            systemPrompt: expect.stringContaining('Feature Consolidation Task'),
            userPrompt: expect.stringContaining('Feature groups to analyze'),
          }),
        }),
      );
      expect(process.env['DOKLO_LLM_BACKEND']).toBe('claude-code');
      expect(process.env['DOKLO_MODEL']).toBe('attacker/model');
    } finally {
      if (previousBackend === undefined) delete process.env['DOKLO_LLM_BACKEND'];
      else process.env['DOKLO_LLM_BACKEND'] = previousBackend;
      if (previousModel === undefined) delete process.env['DOKLO_MODEL'];
      else process.env['DOKLO_MODEL'] = previousModel;
    }
  });

  it('forwards the exact approved Codex OAuth transport to consolidation', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const codexFetch = (async () => new Response()) as typeof fetch;
    const consolidateFeatures = vi.fn(async () => ({
      success: true,
      prompt: '<prompt>',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      usage: null,
      config: {
        projectName: 'demo', basedOnFeaturesAt: 't', generatedAt: 't', model: 'm',
        originalFeatureIds: [], userReviewed: false,
        stats: {
          originalFeatures: 0, consolidatedFeatures: 0, excluded: 0, merges: 0,
        },
        groups: [],
      },
    }));

    await runConsolidate(
      { root, ...await codexConsent(root, codexFetch) },
      { consolidateFeatures },
    );

    expect(consolidateFeatures).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerKind: 'openai',
        model: 'openai/gpt-5.6-terra',
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetch: codexFetch,
      }),
    );
  });

  it('hands the service its existing Doks so a re-run can reuse their ids', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    await writeHubDok(root, 'AUTH-SIGNIN', [
      { service_id: 'web', canonical_feature_id: 'auth-signin', primary_route: '/auth/signin' },
    ]);
    const consolidateFeatures = fakeConsolidation(root, ['AUTH-SIGNIN']);

    await runConsolidate({ root, ...await paidConsent(root) }, { consolidateFeatures });

    expect(consolidateFeatures).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceId: 'web',
        existingIdentities: [{
          dok_id: 'AUTH-SIGNIN',
          service_id: 'web',
          canonical_feature_id: 'auth-signin',
          primary_route: '/auth/signin',
        }],
        // The service's own ids stay mintable — they are what pinning reuses.
        usedPrefixes: [],
        // The consent-approved prompt is the one that names them. Existing
        // identities are per-workspace data, so they ride in the user part
        // (the system part stays a cacheable static prefix).
        preparedPrompt: expect.objectContaining({
          userPrompt: expect.stringContaining(
            '- `AUTH-SIGNIN` — feature `auth-signin`, route `/auth/signin`',
          ),
        }),
      }),
    );
  });

  it('reports a Dok takeover the consolidator could not verify', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    // A Dok from before origins existed: its id is known, its provenance is not.
    await writeHubDok(root, 'AUTH-SIGNIN', []);
    const consolidateFeatures = fakeConsolidationReporting(
      root,
      ['AUTH-SIGNIN'],
      { dokId: 'AUTH-SIGNIN', canonicalId: 'feat-0' },
    );

    const result = await runConsolidate(
      { root, ...await paidConsent(root) },
      { consolidateFeatures },
    );

    expect(result.unverifiedIdReuse).toEqual([
      { serviceId: 'web', dokId: 'AUTH-SIGNIN', canonicalId: 'feat-0' },
    ]);
    // Advisory only — the run still succeeds and the cache is still written.
    expect(result.results).toHaveLength(1);
  });

  it('reports nothing when no service raised an unverified reuse', async () => {
    const root = await tmpInitialized();
    await writeScanCache(root, 'web');
    const consolidateFeatures = fakeConsolidation(root, ['AUTH-SIGNIN']);

    const result = await runConsolidate(
      { root, ...await paidConsent(root) },
      { consolidateFeatures },
    );

    expect(result.unverifiedIdReuse).toEqual([]);
  });

  it('reserves ids owned by other services across the per-service calls', async () => {
    const root = await tmpInitialized();
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
          { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: '.' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeScanCache(root, 'web');
    await writeScanCache(root, 'admin');
    // Two Doks owned by web (one of which nothing will claim), one by admin.
    await writeHubDok(root, 'AUTH-SIGNIN', [
      { service_id: 'web', canonical_feature_id: 'auth-signin', primary_route: '/auth/signin' },
    ]);
    await writeHubDok(root, 'AUTH-INVITE', [
      { service_id: 'web', canonical_feature_id: 'auth-invite', primary_route: '/auth/invite' },
    ]);
    await writeHubDok(root, 'ADMIN-USERS', [
      { service_id: 'admin', canonical_feature_id: 'admin-users', primary_route: '/admin/users' },
    ]);
    const consolidateFeatures = fakeConsolidation(root, ['AUTH-SIGNIN']);

    await runConsolidate({ root, ...await paidConsent(root) }, { consolidateFeatures });

    const optionsFor = (serviceId: string) => consolidateFeatures.mock.calls.find(
      (call) => (call[1] as { serviceId?: string }).serviceId === serviceId,
    )?.[1] as { usedPrefixes?: string[]; existingIdentities?: Array<{ dok_id: string }> };

    // web may not mint admin's id, but its own two stay available to pinning.
    expect(optionsFor('web')?.usedPrefixes).toEqual(['ADMIN-USERS']);
    expect(optionsFor('web')?.existingIdentities?.map((i) => i.dok_id))
      .toEqual(['AUTH-INVITE', 'AUTH-SIGNIN']);

    // admin sees web's Doks as taken — the one web just re-assigned and the one
    // it left behind (whose file is still on disk) — but keeps its own.
    expect(optionsFor('admin')?.usedPrefixes?.sort())
      .toEqual(['AUTH-INVITE', 'AUTH-SIGNIN']);
    expect(optionsFor('admin')?.existingIdentities?.map((i) => i.dok_id))
      .toEqual(['ADMIN-USERS']);
  });

  it('skips services without a scan cache (warns + continues)', async () => {
    const root = await tmpInitialized();
    await mkdir(join(root, 'apps/admin'), { recursive: true });
    // Write workspace with two services but only scan cache for one.
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
          { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeScanCache(root, 'web');

    const result = await runConsolidate({ root, dryRun: true });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.serviceId).toBe('web');
    expect(result.skipped).toEqual([
      { serviceId: 'admin', reason: 'no scan cache (run `doklo scan` first)' },
    ]);
  });

  it('rejects symlink-escaping IR paths before invoking the consolidation LLM', async () => {
    const root = await tmpInitialized();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-cons-outside-'));
    await mkdir(join(root, 'service'), { recursive: true });
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n', 'utf-8');
    await symlink(outside, join(root, 'service', 'link'));
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'service' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeFile(
      join(root, '.doklo/cache/web.scan.json'),
      JSON.stringify({
        framework: 'nextjs',
        root: join(root, 'service'),
        files: ['link/secret.ts'],
        routes: [
          {
            path: '/',
            kind: 'page',
            file: 'link/secret.ts',
            dynamic_params: [],
            layout_chain: [],
          },
        ],
        components: [],
        stores: [],
      }),
      'utf-8',
    );
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('must not call paid consolidation');
    });

    await expect(
      runConsolidate({ root }, { consolidateFeatures }),
    ).rejects.toThrow(/outside|contain|root/i);

    expect(consolidateFeatures).not.toHaveBeenCalled();
  });

  it('preflights every selected service before the first paid consolidation', async () => {
    const root = await tmpInitialized();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-cons-outside-'));
    await mkdir(join(root, 'apps/web'), { recursive: true });
    await mkdir(join(root, 'apps/admin'), { recursive: true });
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n', 'utf-8');
    await symlink(outside, join(root, 'apps/admin/link'));
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
          { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeScanCache(root, 'web');
    for (const source of [
      'app/auth/signin/page.tsx',
      'app/admin/users/page.tsx',
    ]) {
      const absolute = join(root, 'apps/web', source);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, 'export default function Page() { return null; }\n');
    }
    await writeFile(
      join(root, '.doklo/cache/admin.scan.json'),
      JSON.stringify({
        framework: 'nextjs',
        root: join(root, 'apps/admin'),
        files: ['link/secret.ts'],
        routes: [],
        components: [],
        stores: [],
      }),
      'utf-8',
    );
    const consolidateFeatures = vi.fn(async () => {
      throw new Error('must not call paid consolidation');
    });

    await expect(
      runConsolidate({ root }, { consolidateFeatures }),
    ).rejects.toThrow(/outside|contain|root/i);

    expect(consolidateFeatures).not.toHaveBeenCalled();
    await expect(
      readFile(join(root, '.doklo/cache/web.consolidated.json'), 'utf-8'),
    ).rejects.toThrow();
  });
});

describe('formatUnverifiedIdReuse', () => {
  it('names the id, the feature and what the user has to check', () => {
    const line = formatUnverifiedIdReuse({
      serviceId: 'web',
      dokId: 'AUTH-SIGNIN',
      canonicalId: 'auth-signin',
    });

    expect(line).toContain('AUTH-SIGNIN');
    expect(line).toContain('auth-signin');
    expect(line).toContain('web');
    // The user has to be told what will happen to the file, not just that
    // something was unverifiable.
    expect(line).toMatch(/no recorded provenance/i);
    expect(line).toMatch(/overwrit/i);
  });
});
