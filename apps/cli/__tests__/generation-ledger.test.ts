import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveContainedOutputPath,
} from '@doklo-beta/generator';
import {
  authorizeLlmRun,
  buildLlmRunPlan,
  type LlmPlanInput,
} from '../src/lib/llm-preflight.js';
import {
  runGenerate,
  type GenerateDeps,
  type RunGenerateOptions,
} from '../src/commands/generate.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-generation-ledger-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await mkdir(join(root, '.doklo', 'debug'), { recursive: true });
  await writeFile(join(root, 'app', 'page.tsx'), 'export default function Page(){ return null; }');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.4.0' } }));
  await writeFile(join(root, 'workspace.json'), JSON.stringify({
    workspace_id: 'demo',
    name: 'Demo',
    services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
    default_locale: 'en',
    supported_locales: ['en'],
  }));
  await writeFile(join(root, '.doklo', 'hub', 'roles.json'), JSON.stringify({ roles: [], version: 1 }));
  await writeFile(join(root, '.doklo', 'cache', 'web.scan.json'), JSON.stringify({
    framework: 'nextjs', root, files: ['app/page.tsx'],
    routes: [{ path: '/', kind: 'page', file: 'app/page.tsx', dynamic_params: [], layout_chain: [] }],
    components: [], stores: [], role_signals: [],
  }));
  await writeFile(join(root, '.doklo', 'cache', 'web.consolidated.json'), JSON.stringify({
    projectName: 'demo', basedOnFeaturesAt: '2026-07-17T00:00:00.000Z',
    generatedAt: '2026-07-17T00:00:00.000Z', model: 'test', userReviewed: false,
    originalFeatureIds: ['F-main'],
    groups: [{ group_id: 'main', label: 'Main', excluded: [], features: [{
      canonical_id: 'main', label: 'Main', decision: 'keep', members: ['F-main'],
      primary_route: '/', reason: '', user_reviewed: false, dok_id_prefix: 'AUTH',
      source_files: ['app/page.tsx'], logic_files: ['app/page.tsx'],
    }] }],
    stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
  }));
  return root;
}

function dok() {
  return {
    dok_id: 'AUTH', name: 'Main', description: 'The main feature.',
    user_actions: { steps: [{ order: 1, actor: { kind: 'system' }, intent: 'Render', outcome: 'Rendered', variants: [{ platform: 'all', interaction: 'auto' }] }] },
    business_rules: { rules: [] }, acceptance_criteria: { criteria: [] },
  };
}

async function paidOptions(
  root: string,
  deps: Partial<GenerateDeps>,
  options: Omit<RunGenerateOptions, 'root' | 'dryRun' | 'authorizedRun' | 'preparedGeneration'>,
  llm: LlmPlanInput['llm'] = {
    providerKind: 'anthropic',
    model: 'anthropic/claude-sonnet-5',
    authSource: 'keychain',
    apiKey: 'test-key',
  },
) {
  const preview = await runGenerate({ root, ...options, dryRun: true }, deps);
  const plan = buildLlmRunPlan({
    llm,
    candidateFiles: preview.transmissions,
    workItems: preview.plan.map((item) => ({ phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId })),
    calls: { consolidate: 0, lexicon: 0, generateMax: preview.plan.length, judgeMax: 0 },
    preparedCalls: (preview.preparedGeneration?.items ?? []).map((item) => ({
      phase: 'generate' as const,
      workItem: { phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId },
      prompt: item.prompt, maxOutputTokens: 8192,
    })),
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    ...options,
    root,
    planDigest: plan.digest,
    authorizedRun: await authorizeLlmRun(root, plan, llm, { yes: true, isTTY: false }),
    preparedGeneration: preview.preparedGeneration,
  } satisfies RunGenerateOptions;
}

describe('generation ledger integration', () => {
  it('forwards the exact Codex OAuth transport and records Terra in the ledger', async () => {
    const root = await fixture();
    const codexFetch = (async () => new Response()) as typeof fetch;
    let receivedOptions: Parameters<GenerateDeps['generateDokForFeature']>[2] | undefined;
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_feature, _context, options) => {
        receivedOptions = options;
        return { success: true, dok: dok(), prompt: '', rawResponse: '{}', usage: null };
      },
    };
    const options = await paidOptions(
      root,
      deps,
      { noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true },
      {
        providerKind: 'openai',
        model: 'openai/gpt-5.6-terra',
        authSource: 'oauth',
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetch: codexFetch,
      },
    );

    const result = await runGenerate(options, deps);

    expect(receivedOptions).toMatchObject({
      providerKind: 'openai',
      model: 'openai/gpt-5.6-terra',
      baseURL: 'https://chatgpt.com/backend-api/codex',
    });
    expect(receivedOptions?.fetch).toBe(codexFetch);
    expect(receivedOptions?.apiKey).toBeUndefined();
    expect(result.generationLedger?.model).toBe('openai/gpt-5.6-terra');
    const persisted = JSON.parse(await readFile(
      join(root, '.doklo', 'cache', 'generation-ledger.json'),
      'utf8',
    )) as { model: string };
    expect(persisted.model).toBe('openai/gpt-5.6-terra');
  });

  it('writes a failed source-feature ledger after a partial generation', async () => {
    const root = await fixture();
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async () => ({ success: false, dok: null, error: 'LLM timeout', usage: null }),
    };
    const options = await paidOptions(root, deps, { noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true });
    const result = await runGenerate(options, deps);
    expect(result.failures).toHaveLength(1);
    const ledger = JSON.parse(await readFile(join(root, '.doklo', 'cache', 'generation-ledger.json'), 'utf8')) as {
      summary: { failed: number; sourceFeatures: number };
      entries: { sourceFeatureId: string; status: string }[];
    };
    expect(ledger.summary).toMatchObject({ sourceFeatures: 1, failed: 1 });
    expect(ledger.entries).toEqual([{ sourceFeatureId: 'F-main', serviceId: 'web', canonicalFeatureId: 'main', dokId: 'AUTH', status: 'failed', reasonCode: 'GENERATION_FAILED', message: 'LLM timeout' }]);
  });

  it('preflights an existing unrelated Dok before an all-existing run', async () => {
    const root = await fixture();
    await writeFile(join(root, '.doklo', 'hub', 'doks', 'AUTH.json'), JSON.stringify({ ...dok(), _meta: { version: 1, history: [], source_anchors: [{ service_id: 'web', file: 'app/page.tsx' }] } }));
    const deps: Partial<GenerateDeps> = { generateDokForFeature: async () => { throw new Error('must not call'); } };
    const result = await runGenerate({ root, dryRun: true, noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true }, deps);
    expect(result.plan).toEqual([]);
    expect(result.skippedExisting).toEqual(['AUTH']);
  });

  it('uses the canonical no-plan digest for an all-existing non-paid run', async () => {
    const root = await fixture();
    await writeFile(join(root, '.doklo', 'hub', 'doks', 'AUTH.json'), JSON.stringify({
      ...dok(),
      _meta: { version: 1, history: [], source_anchors: [{ service_id: 'web', file: 'app/page.tsx' }] },
    }));
    const result = await runGenerate({
      root,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    });
    expect(result.generationLedger?.planDigest).toBe('none');
  });

  it('does not mark an onlyDokIds-excluded source feature as generated', async () => {
    const root = await fixture();
    const consolidatedPath = join(root, '.doklo', 'cache', 'web.consolidated.json');
    const consolidated = JSON.parse(await readFile(consolidatedPath, 'utf8')) as {
      groups: { features: unknown[] }[];
    };
    consolidated.groups[0]!.features.push({
      canonical_id: 'profile', label: 'Profile', decision: 'keep', members: ['F-profile'],
      primary_route: '/profile', reason: '', user_reviewed: false, dok_id_prefix: 'USER',
      source_files: ['app/page.tsx'], logic_files: ['app/page.tsx'],
    });
    (consolidated as { originalFeatureIds?: string[] }).originalFeatureIds = ['F-main', 'F-profile'];
    await writeFile(consolidatedPath, JSON.stringify(consolidated));
    await writeFile(join(root, '.doklo', 'hub', 'doks', 'USER.json'), JSON.stringify({
      ...dok(), dok_id: 'USER', _meta: {
        version: 1, history: [], source_anchors: [{ service_id: 'web', file: 'app/page.tsx' }],
      },
    }));
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async () => ({ success: true, dok: dok(), usage: null }),
    };
    const options = await paidOptions(root, deps, {
      force: true, onlyDokIds: ['AUTH'], noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true,
    });
    const result = await runGenerate(options, deps);
    const profile = result.generationLedger?.entries.find((entry) => entry.sourceFeatureId === 'F-profile');
    expect(profile?.status).toBe('skipped');
    expect(profile?.reasonCode).toBe('EXISTING_PRESERVED');
  });

  it('marks an onlyDokIds-excluded feature without a target as not selected', async () => {
    const root = await fixture();
    const consolidatedPath = join(root, '.doklo', 'cache', 'web.consolidated.json');
    const consolidated = JSON.parse(await readFile(consolidatedPath, 'utf8')) as {
      groups: { features: unknown[] }[];
    };
    consolidated.groups[0]!.features.push({
      canonical_id: 'profile', label: 'Profile', decision: 'keep', members: ['F-profile'],
      primary_route: '/profile', reason: '', user_reviewed: false, dok_id_prefix: 'USER',
      source_files: ['app/page.tsx'], logic_files: ['app/page.tsx'],
    });
    (consolidated as { originalFeatureIds?: string[] }).originalFeatureIds = ['F-main', 'F-profile'];
    await writeFile(consolidatedPath, JSON.stringify(consolidated));
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async () => ({ success: true, dok: dok(), usage: null }),
    };
    const options = await paidOptions(root, deps, {
      force: true, onlyDokIds: ['AUTH'], noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true,
    });
    const result = await runGenerate(options, deps);
    const profile = result.generationLedger?.entries.find((entry) => entry.sourceFeatureId === 'F-profile');
    expect(profile?.status).toBe('skipped');
    expect(profile?.reasonCode).toBe('NOT_SELECTED');
  });

  it('rejects an unknown onlyDokIds target before any generation', async () => {
    const root = await fixture();
    await expect(runGenerate({
      root,
      dryRun: true,
      onlyDokIds: ['DOES-NOT-EXIST'],
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    })).rejects.toThrow('Unknown Dok ID');
  });

  it('fails closed when an independently persisted source feature is omitted from consolidation', async () => {
    const root = await fixture();
    const consolidatedPath = join(root, '.doklo', 'cache', 'web.consolidated.json');
    const consolidated = JSON.parse(await readFile(consolidatedPath, 'utf8')) as Record<string, unknown>;
    consolidated.originalFeatureIds = ['F-main', 'F-omitted'];
    await writeFile(consolidatedPath, JSON.stringify(consolidated));
    await expect(runGenerate({
      root,
      dryRun: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    })).rejects.toThrow('MISSING_SOURCE_FEATURE');
  });

  it('fails closed when a legacy cache has no independent inventory and scan finds an omitted feature', async () => {
    const root = await fixture();
    await mkdir(join(root, 'app', 'profile'), { recursive: true });
    await writeFile(join(root, 'app', 'profile', 'page.tsx'), 'export default function Profile(){ return null; }');
    const scanPath = join(root, '.doklo', 'cache', 'web.scan.json');
    const scan = JSON.parse(await readFile(scanPath, 'utf8')) as {
      files: string[];
      routes: unknown[];
    };
    scan.files.push('app/profile/page.tsx');
    scan.routes.push({
      path: '/profile', kind: 'page', file: 'app/profile/page.tsx', dynamic_params: [], layout_chain: [],
    });
    await writeFile(scanPath, JSON.stringify(scan));
    const consolidatedPath = join(root, '.doklo', 'cache', 'web.consolidated.json');
    const consolidated = JSON.parse(await readFile(consolidatedPath, 'utf8')) as {
      groups: { features: { members: string[] }[] }[];
      originalFeatureIds?: string[];
    };
    consolidated.groups[0]!.features[0]!.members = ['home'];
    delete consolidated.originalFeatureIds;
    await writeFile(consolidatedPath, JSON.stringify(consolidated));
    await expect(runGenerate({
      root,
      dryRun: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    })).rejects.toThrow('Consolidated cache is invalid');
  });

  it('binds the generation ledger to the approved LLM plan digest', async () => {
    const root = await fixture();
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async () => ({ success: false, dok: null, error: 'LLM timeout', usage: null }),
    };
    const options = await paidOptions(root, deps, { noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true });
    const result = await runGenerate(options, deps);
    const ledger = result.generationLedger!;
    expect(ledger.planDigest).toBe((options as RunGenerateOptions & { planDigest: string }).planDigest);
    expect(ledger.planDigest).not.toBe('sha256:' + JSON.stringify(ledger.entries));
    const alternateRoot = await fixture();
    const alternate = await paidOptions(alternateRoot, deps, {
      noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true,
    });
    expect((alternate as RunGenerateOptions & { planDigest: string }).planDigest)
      .not.toBe((options as RunGenerateOptions & { planDigest: string }).planDigest);
  });

  it('captures startedAt at the beginning of the paid run', async () => {
    const root = await fixture();
    let ticks = 0;
    const deps: Partial<GenerateDeps> = {
      now: () => `tick-${++ticks}`,
      generateDokForFeature: async () => ({ success: false, dok: null, error: 'LLM timeout', usage: null }),
    };
    const options = await paidOptions(root, deps, { noRoles: true, noIa: true, noCodeMapping: true, noLexicon: true });
    const firstPaidTick = ticks + 1;
    const result = await runGenerate(options, deps);
    expect(result.generationLedger?.startedAt).toBe(`tick-${firstPaidTick}`);
  });

  it('atomically records completed and interrupted work and retains unknown usage cost', async () => {
    const root = await fixture();
    const consolidatedPath = join(root, '.doklo', 'cache', 'web.consolidated.json');
    const consolidated = JSON.parse(await readFile(consolidatedPath, 'utf8')) as {
      originalFeatureIds: string[];
      stats: { originalFeatures: number; consolidatedFeatures: number };
      groups: { features: unknown[] }[];
    };
    consolidated.originalFeatureIds.push('F-profile');
    consolidated.stats.originalFeatures = 2;
    consolidated.stats.consolidatedFeatures = 2;
    consolidated.groups[0]!.features.push({
      canonical_id: 'profile', label: 'Profile', decision: 'keep', members: ['F-profile'],
      primary_route: '/profile', reason: '', user_reviewed: false, dok_id_prefix: 'USER',
      source_files: ['app/page.tsx'], logic_files: ['app/page.tsx'],
    });
    await writeFile(consolidatedPath, JSON.stringify(consolidated));

    const controller = new AbortController();
    let calls = 0;
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_feature, ctx, options) => {
        calls += 1;
        expect(options.signal).toBe(controller.signal);
        if (calls === 2) {
          controller.abort(new Error('SIGINT'));
          return {
            success: false,
            dok: null,
            usage: null,
            interrupted: true,
            error: 'Generation interrupted.',
          };
        }
        return {
          success: true,
          dok: { ...dok(), dok_id: ctx.dokId },
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    };
    const options = await paidOptions(root, deps, {
      signal: controller.signal,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    });
    const result = await runGenerate(options, deps);

    expect(result.interrupted).toBe(true);
    expect(result.results.map((entry) => entry.dokId)).toEqual(['AUTH']);
    const ledger = JSON.parse(await readFile(
      join(root, '.doklo', 'cache', 'generation-ledger.json'),
      'utf8',
    )) as {
      entries: { dokId: string; status: string; reasonCode: string }[];
      summary: { success: number; failed: number };
    };
    expect(ledger.entries.map(({ dokId, status, reasonCode }) => ({
      dokId,
      status,
      reasonCode,
    }))).toEqual([
      { dokId: 'AUTH', status: 'success', reasonCode: 'GENERATED' },
      { dokId: 'USER', status: 'failed', reasonCode: 'INTERRUPTED' },
    ]);
    expect(ledger.summary).toMatchObject({ success: 1, failed: 1 });
    expect((await readdir(join(root, '.doklo', 'cache')))
      .filter((name) => name.includes('generation-ledger.json.'))).toEqual([]);

    const costLedger = JSON.parse(await readFile(
      join(root, '.doklo', 'cache', 'llm-token-ledger.json'),
      'utf8',
    )) as { calls: { state: string }[] };
    expect(costLedger.calls.map((call) => call.state)).toEqual(['settled', 'retained']);
  });
});
