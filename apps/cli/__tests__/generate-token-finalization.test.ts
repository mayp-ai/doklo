import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectIR } from '@doklo-beta/core';
import { resolveContainedOutputPath, type ConsolidatedFeatureConfig } from '@doklo-beta/generator';
import { runGenerate, type GenerateDeps } from '../src/commands/generate.js';
import { authorizeLlmRun, buildLlmRunPlan } from '../src/lib/llm-preflight.js';

async function writeScanIr(
  root: string,
  serviceId: string,
  overrides: Partial<ProjectIR> = {},
): Promise<void> {
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.scan.json`),
    JSON.stringify({
      framework: 'nextjs',
      root,
      files: [],
      routes: [],
      components: [],
      stores: [],
      role_signals: [],
      ...overrides,
    }),
    'utf-8',
  );
}

async function tmpInit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-gen-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await mkdir(join(root, '.doklo', 'debug'), { recursive: true });
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { next: '15.4.0' } }),
    'utf-8',
  );
  await writeFile(
    join(root, 'app/page.tsx'),
    'export default function Page(){ return null }',
    'utf-8',
  );
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  await writeFile(
    join(root, '.doklo/hub/roles.json'),
    JSON.stringify({ roles: [], version: 1 }),
    'utf-8',
  );
  await writeScanIr(root, 'web', {
    files: ['app/page.tsx'],
    routes: [{ path: '/', kind: 'page', file: 'app/page.tsx', dynamic_params: [], layout_chain: [] }],
  });
  return root;
}

function makeConsolidatedConfig(prefixes: string[]): ConsolidatedFeatureConfig {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    model: 'claude-haiku-4-5',
    originalFeatureIds: prefixes.map((_, i) => `feat-${i}`),
    userReviewed: false,
    stats: {
      originalFeatures: prefixes.length,
      consolidatedFeatures: prefixes.length,
      merges: 0,
      excluded: 0,
    },
    groups: [
      {
        group_id: 'auth',
        label: 'auth',
        excluded: [],
    features: prefixes.map((prefix, i) => ({
          canonical_id: `feat-${i}`,
          label: `Feature ${i}`,
          dok_id_prefix: prefix,
          decision: 'keep',
          members: [`feat-${i}`],
          primary_route: `/x${i}`,
          reason: '',
          user_reviewed: false,
          // Default fixtures have a real App Router page so Task 5's trust
          // gate can prove the generated Dok's source anchor before writing.
          source_files: ['app/page.tsx'],
          logic_files: ['app/page.tsx'],
        })),
      },
    ],
  };
}

async function writeConsolidated(root: string, serviceId: string, prefixes: string[]): Promise<void> {
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.consolidated.json`),
    JSON.stringify(makeConsolidatedConfig(prefixes)),
    'utf-8',
  );
}

function makeDok(dokId: string, name = 'Stub'): unknown {
  return {
    dok_id: dokId,
    name,
    status: 'active',
    tags: ['demo'],
    surfaces: ['web'],
    description: 'A stub dok produced by the test fake LLM.',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'system' },
          intent: 'Render',
          outcome: 'Rendered',
          variants: [{ platform: 'all', interaction: 'auto' }],
        },
      ],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
    _meta: {
      version: 1,
      history: [],
      source_anchors: [{ file: 'app/page.tsx' }],
    },
  };
}


describe('generation token cap finalization', () => {
  it.each(['reservation', 'success-overrun', 'failure-overrun'] as const)(
    'preserves outcomes and completes layers and ledger after %s', async (mode) => {
      const root = await tmpInit();
      try {
        await writeConsolidated(root, 'web', ['AUTH', 'PROFILE']);
        const options = { root, noLexicon: true, noRoles: true };
        const preview = await runGenerate({ ...options, dryRun: true });
        const llm = { providerKind: 'anthropic' as const, model: 'anthropic/claude-sonnet-5', apiKey: 'test-key' };
        const planInput = {
          llm, candidateFiles: preview.transmissions,
          workItems: preview.plan.map(item => ({ phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId })),
          calls: { consolidate: 0, lexicon: 0, generateMax: 2, judgeMax: 0 },
          preparedCalls: preview.preparedGeneration!.items.map(item => ({
            phase: 'generate' as const, workItem: { phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId },
            prompt: item.prompt, maxOutputTokens: 8192,
          })),
          debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
        };
        const cap = buildLlmRunPlan(planInput).reservedTokensMax;
        const plan = buildLlmRunPlan({ ...planInput, maxTokensPerRun: cap * 2, maxTokensTotal: cap });
        const authorizedRun = await authorizeLlmRun(root, plan, llm, { yes: true, isTTY: false });
        const measuredTokens = mode === 'reservation' ? cap - 1 : cap + 1;
        const generate = vi.fn<GenerateDeps['generateDokForFeature']>(async (_feature, ctx) => ({
          success: mode !== 'failure-overrun',
          dok: mode === 'failure-overrun' ? null : makeDok(ctx.dokId) as never,
          prompt: '', rawResponse: '', usage: { input_tokens: measuredTokens, output_tokens: 0 },
          ...(mode === 'failure-overrun' ? { error: 'Invalid provider response' } : {}),
        }));
        const result = await runGenerate({ ...options, authorizedRun, preparedGeneration: preview.preparedGeneration }, {
          generateDokForFeature: generate,
        });
        expect(generate).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ tokenCapFailure: { code: 'LLM_TOTAL_TOKEN_CAP' },
          tokenUsage: { attemptedCalls: 1, measuredCalls: 1, actual: { inputTokens: measuredTokens } } });
        expect(result.results).toHaveLength(mode === 'failure-overrun' ? 0 : 1);
        expect(result.failures).toHaveLength(mode === 'failure-overrun' ? 1 : 0);
        expect(result.layers.ia).toHaveLength(1);
        expect(result.layers.codeMapping).toHaveLength(1);
        const ledger = JSON.parse(await readFile(join(root, '.doklo/cache/generation-ledger.json'), 'utf8'));
        expect(ledger.entries).toEqual([
          expect.objectContaining({ dokId: 'AUTH', reasonCode: mode === 'failure-overrun' ? 'GENERATION_FAILED' : 'GENERATED' }),
          expect.objectContaining({ dokId: 'PROFILE', reasonCode: 'INTERRUPTED' }),
        ]);
        const tokenLedger = JSON.parse(await readFile(join(root, '.doklo/cache/llm-token-ledger.json'), 'utf8'));
        expect(tokenLedger.calls).toEqual([expect.objectContaining({ actualTokens: measuredTokens, state: 'overrun' })]);
        expect(result.generationLedger).toBeDefined();
        if (mode !== 'failure-overrun') {
          expect(JSON.parse(await readFile(result.results[0]!.outputPath, 'utf8')).dok_id).toBe('AUTH');
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
});
