import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { createContext } from '../src/lib/context.js';
import { takeCommandResult, type CommandResult } from '../src/lib/command-result.js';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  runGenerate as runGenerateDirect,
  type GenerateDeps,
  type PreparedGenerationPayload,
  type RunGenerateOptions,
} from '../src/commands/generate.js';
import {
  buildSyncDiagnostics,
  registerSyncCommand,
  criticalDriftReason,
  runSync as runSyncDirect,
  type RunSyncDeps,
  type RunSyncOptions,
  type RunSyncResult,
} from '../src/commands/sync.js';
import { runScan } from '../src/commands/scan.js';
import { appendHistoryEntry, computeLogicHash, type Dok } from '@doklo-beta/core';
import { resolveContainedOutputPath } from '@doklo-beta/generator';
import { classifyDokHistory } from '@doklo-beta/livedoc-engine';
import {
  authorizeLlmRun,
  buildLlmRunPlan,
} from '../src/lib/llm-preflight.js';

async function generationConsent(
  root: string,
  preview: {
    plannedRegeneration?: string[];
    plan?: Array<{ serviceId: string; dokId: string }>;
    transmissions: Array<{ phase: 'generate'; serviceId: string; file: string; maxChars: number; dokId?: string }>;
    preparedGeneration?: PreparedGenerationPayload;
  },
) {
  const work = preview.plan ?? (preview.plannedRegeneration ?? []).map((dokId) => ({
    dokId,
    serviceId: preview.transmissions.find((item) => item.dokId === dokId)?.serviceId ?? 'web',
  }));
  const plan = buildLlmRunPlan({
    llm: {
      providerKind: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'keychain',
    },
    candidateFiles: preview.transmissions,
    workItems: work.map((item) => ({
      phase: 'generate' as const,
      serviceId: item.serviceId,
      id: item.dokId,
    })),
    calls: { consolidate: 0, lexicon: 0, generateMax: work.length, judgeMax: 0 },
    preparedCalls: (preview.preparedGeneration?.items ?? []).map((item) => ({
      phase: 'generate' as const,
      workItem: {
        phase: 'generate' as const,
        serviceId: item.serviceId,
        id: item.dokId,
      },
      prompt: item.prompt,
      maxOutputTokens: 8_192,
    })),
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    plan,
    authorizedRun: await authorizeLlmRun(root, plan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false }),
    preparedGeneration: preview.preparedGeneration,
  };
}

async function runGenerate(options: RunGenerateOptions, deps?: Partial<GenerateDeps>) {
  await runScan({ root: options.root });
  if (options.dryRun) return runGenerateDirect(options, deps);
  const preview = await runGenerateDirect({ ...options, dryRun: true }, deps);
  return runGenerateDirect({
    ...options,
    ...await generationConsent(options.root, preview),
  }, deps);
}

async function runSync(options: RunSyncOptions, deps?: RunSyncDeps) {
  if (options.check) return runSyncDirect(options, deps);
  const preview = await runSyncDirect({ ...options, previewOnly: true }, deps);
  if (preview.plannedRegeneration.length === 0) return runSyncDirect(options, deps);
  return runSyncDirect({
    ...options,
    ...await generationConsent(options.root, preview),
    prepared: preview,
  }, deps);
}

// ── Fixtures (mirrored from generate.test.ts; test files never import each
//    other, so the helpers are copied and trimmed to what sync needs). ──

async function tmpInit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-sync-'));
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
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
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
  return root;
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
  };
}

// One consolidated feature with explicit source files (single prefix).
async function writeConsolidatedWithFiles(
  root: string,
  serviceId: string,
  prefix: string,
  sourceFiles: string[],
): Promise<void> {
  await writeConsolidatedMulti(root, serviceId, [{ prefix, sourceFiles }]);
}

// Multiple consolidated features, each with its own prefix + source files.
async function writeConsolidatedMulti(
  root: string,
  serviceId: string,
  features: { prefix: string; sourceFiles: string[] }[],
): Promise<void> {
  // Real route imports let scan validate the source graph used by generation.
  for (const [index, feature] of features.entries()) {
    await writeSource(root, `app/x${index}/page.tsx`,
      feature.sourceFiles.map((file) => `import '../../${file}';`).join('\n')
      + '\nexport default function Page() { return null; }');
  }
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.consolidated.json`),
    JSON.stringify({
      projectName: 'demo',
      basedOnFeaturesAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      model: 'claude-haiku-4-5',
      originalFeatureIds: features.map((_, i) => `x${i}`),
      userReviewed: false,
      stats: {
        originalFeatures: features.length,
        consolidatedFeatures: features.length,
        merges: 0,
        excluded: 0,
      },
      groups: [
        {
          group_id: 'g',
          label: 'g',
          excluded: [],
          features: features.map((f, i) => ({
            canonical_id: `f${i}`,
            label: `F${i}`,
            dok_id_prefix: f.prefix,
            decision: 'keep',
            members: [`x${i}`],
            primary_route: `/x${i}`,
            reason: '',
            user_reviewed: false,
            source_files: f.sourceFiles,
          })),
        },
      ],
    }),
    'utf-8',
  );
}

// Re-date a consolidated plan without touching the plan itself. Offsets are
// explicit (±10s) so an mtime-vs-ISO comparison can never land inside the same
// millisecond as the source edit and flake.
async function setPlanGeneratedAt(
  root: string,
  serviceId: string,
  offsetMs: number,
): Promise<void> {
  const file = join(root, '.doklo/cache', `${serviceId}.consolidated.json`);
  const cache = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
  cache['generatedAt'] = new Date(Date.now() + offsetMs).toISOString();
  await writeFile(file, JSON.stringify(cache), 'utf-8');
}

async function writeSource(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

// Hermetic lexicon stub: runSync's internal runGenerate would otherwise invoke
// the real runLexiconSuggest (→ live LLM). Returning no suggestions keeps the
// pass a no-op while never touching the network.
const noLexiconSuggest: GenerateDeps['runLexiconSuggest'] = async () => ({
  written: false,
  cacheFile: '',
  suggestions: [],
});

// Non-spy stub for SETUP generation (its calls aren't asserted on).
const stubDeps: Partial<GenerateDeps> = {
  generateDokForFeature: async (_f, ctx) => ({
    success: true,
    dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
    prompt: '',
    rawResponse: '',
    usage: null,
  }),
  runLexiconSuggest: noLexiconSuggest,
};

// A vi.fn-backed spy recording each generated dok_id, for the runSync
// under test — lets us assert exactly which Doks reached the LLM.
function spyDeps(): { deps: Partial<GenerateDeps>; calls: string[] } {
  const calls: string[] = [];
  const impl: GenerateDeps['generateDokForFeature'] = async (_feature, ctx) => {
    calls.push(ctx.dokId);
    return {
      success: true,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: null,
    };
  };
  return { deps: { generateDokForFeature: vi.fn(impl), runLexiconSuggest: noLexiconSuggest }, calls };
}

const isolatedGenerateOptions = {
  noLexicon: true,
  noRoles: true,
  noIa: true,
  noCodeMapping: true,
} as const;

// Build a stale AUTH: generate it from content A, then mutate the source.
async function seedStaleAuth(root: string): Promise<void> {
  await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['src/auth.ts']);
  await writeSource(root, 'src/auth.ts', 'export const a = 1;');
  await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps); // stamps logic_hash of content A
  await writeSource(root, 'src/auth.ts', 'export const a = 2; // changed'); // drift
}

describe('runSync', () => {
  it('retains token cap failures and usage after a successful final regeneration', async () => {
    const root = await tmpInit();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await seedStaleAuth(root);
      const preview = await runSyncDirect({ root, previewOnly: true }, stubDeps);
      const result = await runSync({ root }, {
        ...stubDeps,
        generateDokForFeature: async (...args) => ({
          ...await stubDeps.generateDokForFeature!(...args),
          usage: { input_tokens: 6_000_000, output_tokens: 0 },
        }),
      });
      expect(result).toMatchObject({
        regenerated: ['AUTH'], failures: [],
        tokenCapFailure: { code: 'LLM_RUN_TOKEN_CAP' },
        tokenUsage: { attemptedCalls: 1, measuredCalls: 1, actual: { inputTokens: 6_000_000 } },
      });
      expect(buildSyncDiagnostics(result, false)).toContainEqual(expect.objectContaining({
        code: 'LLM_RUN_TOKEN_CAP', preserved: ['AUTH'],
      }));
      const program = new Command();
      registerSyncCommand(program, createContext('en'), {
        runSync: async options => options.previewOnly ? preview : result,
        resolveLlmForRole: async () => ({ providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key' }),
      });
      await program.parseAsync(['sync', '--root', root, '--yes', '--json'], { from: 'user' });
      expect(takeCommandResult(program)).toMatchObject({
        status: 'cancelled', data: { regenerated: ['AUTH'], tokenCapFailure: { code: 'LLM_RUN_TOKEN_CAP' } },
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'LLM_RUN_TOKEN_CAP' })]),
      });
    } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });

  it('--check lists stale Doks without regenerating (no LLM calls)', async () => {
    const root = await tmpInit();
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await writeSource(root, 'src/user.ts', 'export const u = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    // Drift AUTH only; USER stays fresh.
    await writeSource(root, 'src/auth.ts', 'export const a = 2; // changed');

    const { deps, calls } = spyDeps();
    const result = await runSync({ root, check: true }, deps);

    expect(result.stale).toEqual([
      { dokId: 'AUTH', reason: 'changed', humanEdited: false, tier: 'standard' },
    ]);
    expect(result.regenerated).toEqual([]);
    expect(calls).toEqual([]); // check mode must never touch the LLM
  });

  it('previews transmissions only for the stale Doks that can be regenerated', async () => {
    const root = await tmpInit();
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await writeSource(root, 'src/user.ts', 'export const u = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    await writeSource(root, 'src/auth.ts', 'export const a = 2;');

    const preview = await runSyncDirect({ root, previewOnly: true }, stubDeps);

    expect(preview.plannedRegeneration).toEqual(['AUTH']);
    expect(preview.transmissions.map((item) => item.file)).toEqual([
      '.doklo/cache/web.consolidated.json',
      'app/x0/page.tsx',
    ]);
    // A side-effect import of an unused literal export has no behavior to send;
    // its complete file remains in the conservative drift dependency set.
    expect(preview.preparedGeneration?.items[0]?.feature.logic_files).toContain('src/auth.ts');
    expect(Object.isFrozen(preview.preparedGeneration)).toBe(true);
    expect(Object.isFrozen(preview.preparedGeneration?.items)).toBe(true);
  });

  it('opts actual regeneration out of roles, IA, and code-mapping refresh', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);
    const generateCalls: Array<Record<string, unknown>> = [];
    const injectedRunGenerate = vi.fn(async (options: Record<string, unknown>) => {
      generateCalls.push(options);
      if (options['dryRun'] === true) {
        return {
          results: [],
          failures: [],
          skippedExisting: [],
          emptyAnchorDokIds: [],
          plan: [{ serviceId: 'web', dokId: 'AUTH', featureLabel: 'Auth', domain: 'g' }],
          transmissions: [],
          preparedGeneration: {
            items: [{ serviceId: 'web', dokId: 'AUTH', prompt: 'prepared prompt' }],
          },
          layers: { ia: [], codeMapping: [] },
          layerFailures: [],
        };
      }
      return {
        results: [{ serviceId: 'web', dokId: 'AUTH', outputPath: '' }],
        failures: [],
        skippedExisting: [],
        emptyAnchorDokIds: [],
        plan: [],
        layers: { ia: [], codeMapping: [] },
        layerFailures: [],
        transmissions: [],
      };
    });

    await runSync(
      { root },
      { ...stubDeps, runGenerate: injectedRunGenerate } as never,
    );

    expect(injectedRunGenerate).toHaveBeenCalledTimes(2);
    expect(generateCalls[0]).toMatchObject({
      dryRun: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    });
    expect(generateCalls[1]).toMatchObject({
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    });
  });

  it('rejects direct paid regeneration without consent after preview and before the worker', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);
    const calls: string[] = [];
    const injectedRunGenerate = vi.fn(async (options: RunGenerateOptions) => {
      if (options.dryRun) {
        calls.push('preview');
        return {
          results: [],
          failures: [],
          skippedExisting: [],
          emptyAnchorDokIds: [],
          plan: [{ serviceId: 'web', dokId: 'AUTH', featureLabel: 'Auth', domain: 'g' }],
          layers: { ia: [], codeMapping: [] },
          layerFailures: [],
          transmissions: [
            { phase: 'generate' as const, serviceId: 'web', file: 'src/auth.ts', maxChars: 2_000 },
          ],
        };
      }
      calls.push('paid');
      throw new Error('paid sync worker ran before consent');
    });

    await expect(runSyncDirect(
      { root },
      { ...stubDeps, runGenerate: injectedRunGenerate } as never,
    )).rejects.toMatchObject({
      exitCode: 2,
      result: {
        diagnostics: [expect.objectContaining({ code: 'LLM_CONSENT_REQUIRED' })],
      },
    });
    expect(calls).toEqual(['preview']);
  });

  it('does not accept a receipt for an unrelated lexicon plan', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);
    const unrelatedPlan = buildLlmRunPlan({
      llm: {
        providerKind: 'anthropic',
        model: 'anthropic/claude-sonnet-5',
        authSource: 'keychain',
      },
      candidateFiles: [
        { phase: 'lexicon', serviceId: 'workspace', file: 'messages/en.json', maxChars: 2_000 },
      ],
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
    const authorizedRun = await authorizeLlmRun(root, unrelatedPlan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false });
    const { deps, calls } = spyDeps();
    const prepared = await runSyncDirect({ root, previewOnly: true }, deps);

    await expect(runSyncDirect(
      {
        root,
        authorizedRun,
        prepared,
      },
      deps,
    )).rejects.toMatchObject({
      exitCode: 2,
      result: {
        diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })],
      },
    });
    expect(calls).toEqual([]);
  });

  it('regenerates only the stale Dok and restores it to fresh', async () => {
    const root = await tmpInit();
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await writeSource(root, 'src/user.ts', 'export const u = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    await writeSource(root, 'src/auth.ts', 'export const a = 2; // changed');

    const { deps, calls } = spyDeps();
    const result = await runSync({ root }, deps);

    expect(result.regenerated).toEqual(['AUTH']);
    expect(calls).toEqual(['AUTH']); // fresh USER was not regenerated

    // The regenerated Dok's logic_hash now matches content B on disk...
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written._meta.logic_hash).toBe(
      computeLogicHash([
        { file: 'app/x0/page.tsx', content: "import '../../src/auth.ts';\nexport default function Page() { return null; }" },
        { file: 'src/auth.ts', content: 'export const a = 2; // changed' },
      ]),
    );
    // ...so a re-judgment reports it fresh again.
    const recheck = await runSync({ root, check: true }, spyDeps().deps);
    expect(recheck.stale).toEqual([]);
  });

  it('attributes a deleted anchor file to reason "missing-file"', async () => {
    const root = await tmpInit();
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['src/auth.ts']);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    await rm(join(root, 'src/auth.ts'));

    const result = await runSync({ root, check: true }, spyDeps().deps);
    expect(result.stale).toEqual([
      { dokId: 'AUTH', reason: 'missing-file', humanEdited: false, tier: 'standard' },
    ]);
  });

  it('protects human-edited Doks unless --force (and clears the marker on force)', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);

    // Mark the Dok as human-edited.
    const dokPath = join(root, '.doklo/hub/doks/AUTH.json');
    const dok = JSON.parse(await readFile(dokPath, 'utf-8')) as Record<string, unknown>;
    dok._meta = { ...(dok._meta as object), edited_by_human: true };
    await writeFile(dokPath, JSON.stringify(dok, null, 2), 'utf-8');

    // Without --force: skipped, no LLM call.
    const { deps, calls } = spyDeps();
    const guarded = await runSync({ root }, deps);
    expect(guarded.skippedHumanEdit).toEqual(['AUTH']);
    expect(guarded.regenerated).toEqual([]);
    expect(calls).toEqual([]);
    expect(guarded.stale).toEqual([
      { dokId: 'AUTH', reason: 'changed', humanEdited: true, tier: 'standard' },
    ]);

    // With --force: regenerated, and the LLM output carries no human marker.
    const forced = await runSync({ root, force: true }, spyDeps().deps);
    expect(forced.regenerated).toEqual(['AUTH']);
    const after = JSON.parse(await readFile(dokPath, 'utf-8'));
    expect(after._meta.edited_by_human).toBeUndefined();
  });

  it('--dok limits judgment and regeneration to a single Dok', async () => {
    const root = await tmpInit();
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await writeSource(root, 'src/user.ts', 'export const u = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    // Drift BOTH.
    await writeSource(root, 'src/auth.ts', 'export const a = 2;');
    await writeSource(root, 'src/user.ts', 'export const u = 2;');

    const { deps, calls } = spyDeps();
    const result = await runSync({ root, dokId: 'AUTH' }, deps);
    expect(result.checked).toBe(1); // only AUTH was judged
    expect(result.regenerated).toEqual(['AUTH']);
    expect(calls).toEqual(['AUTH']); // USER left untouched

    // A non-existent id rejects with a clear error.
    await expect(runSync({ root, dokId: 'NOPE' }, spyDeps().deps)).rejects.toThrow(
      /NOPE/,
    );
  });

  it('classifies legacy hashed Doks as unknown', async () => {
    const root = await tmpInit();
    try {
      const legacy = { ...(makeDok('LEGACY') as object), _meta: {
        logic_hash: computeLogicHash([{ file: 'app/page.tsx', content: await readFile(join(root, 'app/page.tsx'), 'utf-8') }]),
        source_anchors: [{ file: 'app/page.tsx' }],
      } };
      await writeFile(join(root, '.doklo/hub/doks/LEGACY.json'), JSON.stringify(legacy));
      const result = await runSyncDirect({ root, check: true });
      expect(result.unknown).toEqual(['LEGACY']);
      expect(result.stale).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves human edits when repaired tracking requires review despite matching hash', async () => {
    const root = await tmpInit();
    try {
      const file = join(root, '.doklo/hub/doks/REPAIRED.json');
      const original = JSON.stringify({ ...(makeDok('REPAIRED', 'Human title') as object), _meta: {
        logic_hash: computeLogicHash([{ file: 'app/page.tsx', content: await readFile(join(root, 'app/page.tsx'), 'utf-8') }]),
        source_anchors: [{ file: 'app/page.tsx' }],
        tracking_version: 2, tracking_review_required: true, edited_by_human: true,
      } });
      await writeFile(file, original);
      const result = await runSyncDirect({ root });
      expect(result.stale).toEqual([expect.objectContaining({ dokId: 'REPAIRED', reason: 'tracking-expanded', humanEdited: true })]);
      expect(result.skippedHumanEdit).toEqual(['REPAIRED']);
      expect(result.regenerated).toEqual([]);
      expect(await readFile(file, 'utf-8')).toBe(original);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('classifies Doks without a logic hash as unknown (never regenerated)', async () => {
    const root = await tmpInit();
    // A Dok written directly with no _meta.logic_hash (predates drift tracking).
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );

    const { deps, calls } = spyDeps();
    const result = await runSync({ root }, deps);
    expect(result.unknown).toEqual(['AUTH']);
    expect(result.stale).toEqual([]);
    expect(result.regenerated).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('surfaces a stale Dok absent from the consolidated plan (notInPlan, no crash)', async () => {
    const root = await tmpInit();
    // The plan only knows AUTH; MANUAL is hand-authored with a real anchor.
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['src/auth.ts']);
    await writeSource(root, 'src/auth.ts', 'export const auth = true;');
    await writeSource(root, 'src/manual.ts', 'export const m = 1;');
    const manual = makeDok('MANUAL') as Record<string, unknown>;
    manual._meta = {
      source_anchors: [{ file: 'src/manual.ts' }],
      tracking_version: 2,
      logic_hash: computeLogicHash([{ file: 'src/manual.ts', content: 'export const m = 1;' }]),
    };
    await writeFile(
      join(root, '.doklo/hub/doks/MANUAL.json'),
      JSON.stringify(manual),
      'utf-8',
    );
    // Drift MANUAL's source.
    await writeSource(root, 'src/manual.ts', 'export const m = 2; // changed');

    const { deps, calls } = spyDeps();
    const result = await runSync({ root }, deps);
    expect(result.stale.map((s) => s.dokId)).toContain('MANUAL');
    expect(result.notInPlan).toEqual(['MANUAL']);
    expect(result.regenerated).toEqual([]);
    expect(calls).toEqual([]); // nothing regenerable → LLM never called
  });

  it('warns when the source changed after the consolidated plan was built', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root); // AUTH's source was edited after generate
    // The plan predates that edit → regeneration would run on an outdated plan.
    await setPlanGeneratedAt(root, 'web', -10_000);

    const result = await runSync({ root, check: true }, spyDeps().deps);

    expect(result.planOutdated).toEqual(['AUTH']);
    expect(buildSyncDiagnostics(result, true)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SYNC_PLAN_OUTDATED',
        preserved: ['AUTH'],
        nextCommand: 'doklo scan && doklo consolidate --yes',
      }),
    ]));
  });

  it('stays silent when the plan was re-consolidated after the source changed', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);
    // Same drift, but the user re-ran scan + consolidate afterwards.
    await setPlanGeneratedAt(root, 'web', 10_000);

    const result = await runSync({ root, check: true }, spyDeps().deps);

    expect(result.stale.map((s) => s.dokId)).toEqual(['AUTH']); // still drifted…
    expect(result.planOutdated).toEqual([]); // …but the plan is current
    expect(buildSyncDiagnostics(result, true).map((d) => d.code)).not.toContain(
      'SYNC_PLAN_OUTDATED',
    );
  });

  it('warns without blocking — an outdated-plan Dok is still regenerated', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);
    await setPlanGeneratedAt(root, 'web', -10_000);

    const { deps, calls } = spyDeps();
    const result = await runSync({ root }, deps);

    expect(result.planOutdated).toEqual(['AUTH']);
    expect(result.regenerated).toEqual(['AUTH']); // advisory, not a gate
    expect(calls).toEqual(['AUTH']);
  });
});

describe('buildSyncDiagnostics', () => {
  it('publishes actionable metadata for every partial-sync outcome', () => {
    const diagnostics = buildSyncDiagnostics(
      {
        checked: 4,
        stale: [
          { dokId: 'STALE', reason: 'changed', humanEdited: false, tier: 'standard' },
        ],
        unknown: ['LEGACY'],
        regenerated: [],
        skippedHumanEdit: ['EDITED'],
        notInPlan: ['MANUAL'],
        planOutdated: ['OUTDATED'],
        planOutdatedAt: { OUTDATED: '2026-07-01T00:00:00.000Z' },
        failures: [
          { serviceId: 'web', dokId: 'FAILED', reason: 'provider unavailable' },
        ],
      },
      false,
    );

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SYNC_DRIFT_UNKNOWN',
        preserved: ['LEGACY'],
        nextCommand: 'doklo generate --force --yes',
      }),
      expect.objectContaining({
        code: 'SYNC_HUMAN_EDIT_PRESERVED',
        preserved: ['EDITED'],
        nextCommand: 'doklo sync --force --yes',
      }),
      expect.objectContaining({
        code: 'SYNC_DOK_NOT_IN_PLAN',
        preserved: ['MANUAL'],
        nextCommand: 'doklo scan && doklo consolidate --yes',
      }),
      expect.objectContaining({
        code: 'SYNC_PLAN_OUTDATED',
        // Names the moment the outdated plan was built, so the user can tell
        // it apart from the edit that drifted the Dok.
        message: expect.stringContaining('2026-07-01T00:00:00.000Z'),
        preserved: ['OUTDATED'],
        nextCommand: 'doklo scan && doklo consolidate --yes',
      }),
      expect.objectContaining({
        code: 'SYNC_REGENERATION_FAILED',
        serviceId: 'web',
        nextCommand: 'doklo sync --dok FAILED --yes',
      }),
    ]));
  });
});

// The seven cases above each isolate one facet of drift. This chains the whole
// acceptance path (drift-spec §6 Day 3 · §8) through a single workspace where
// fresh, drifted, and human-edited Doks coexist: a one-character edit anchors to
// exactly one Dok, --check reports precisely, a plain sync regenerates only the
// unprotected stale Dok while leaving a fresh peer byte-identical and a
// human-edited peer untouched, and --force recovers the protected Dok.
describe('e2e: drift completion acceptance chain', () => {
  it('anchors a one-char edit, regenerates only the unprotected stale Dok, protects the human-edited peer, then recovers it via --force', async () => {
    const root = await tmpInit();

    // ── Setup: three features (AUTH / USER / PROF), one source file each, one
    //    consolidated plan. runGenerate stamps each Dok's logic_hash from the
    //    content on disk now, so all three Doks start fresh. ──
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
      { prefix: 'PROF', sourceFiles: ['src/prof.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await writeSource(root, 'src/user.ts', 'export const u = 1;');
    await writeSource(root, 'src/prof.ts', 'export const p = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps); // stamps logic_hash into all three Doks

    const userPath = join(root, '.doklo/hub/doks/USER.json');
    const profPath = join(root, '.doklo/hub/doks/PROF.json');

    // A single spy threaded through the whole chain: its `calls` array is a
    // cumulative ledger of every Dok that ever reached the (stubbed) LLM.
    const { deps: spy, calls } = spyDeps();

    // ── 1. Everything starts fresh. ──
    const r1 = await runSync({ root, check: true }, spy);
    expect(r1.checked).toBe(3);
    expect(r1.stale).toEqual([]);
    expect(r1.unknown).toEqual([]);

    // ── 2. Mark PROF as human-edited (the marker Studio writes). ──
    const profDok = JSON.parse(await readFile(profPath, 'utf-8')) as Record<string, unknown>;
    profDok._meta = { ...(profDok._meta as object), edited_by_human: true };
    await writeFile(profPath, JSON.stringify(profDok, null, 2), 'utf-8');

    // ── 3. A single-character edit to two anchors drifts AUTH + PROF; USER's
    //       source is left untouched and must stay fresh. ──
    await writeSource(root, 'src/auth.ts', 'export const a = 2;'); // 1 → 2
    await writeSource(root, 'src/prof.ts', 'export const p = 2;'); // 1 → 2

    // ── 4. --check names exactly the two drifted Doks (compared sorted), never
    //       USER, regenerates nothing, and never touches the LLM. ──
    const r4 = await runSync({ root, check: true }, spy);
    const staleSorted = [...r4.stale].sort((x, y) => x.dokId.localeCompare(y.dokId));
    expect(staleSorted).toEqual([
      { dokId: 'AUTH', reason: 'changed', humanEdited: false, tier: 'standard' },
      { dokId: 'PROF', reason: 'changed', humanEdited: true, tier: 'standard' },
    ]);
    expect(r4.regenerated).toEqual([]);
    expect(calls).toEqual([]); // check mode is a pure read

    // ── 5. A plain sync regenerates only the non-human-edited stale Dok (AUTH),
    //       skips the protected one (PROF), and never touches fresh USER —
    //       proven byte-for-byte. ──
    const userSnapshot = await readFile(userPath, 'utf-8');
    const r5 = await runSync({ root }, spy);
    expect(r5.regenerated).toEqual(['AUTH']);
    expect(r5.skippedHumanEdit).toEqual(['PROF']);
    expect(calls).toEqual(['AUTH']); // only AUTH reached the LLM
    expect(await readFile(userPath, 'utf-8')).toBe(userSnapshot); // fresh USER untouched
    const profStill = JSON.parse(await readFile(profPath, 'utf-8'));
    expect(profStill._meta.edited_by_human).toBe(true); // protected PROF not overwritten

    // ── 6. Re-judging shows AUTH restored to fresh; only PROF remains stale. ──
    const r6 = await runSync({ root, check: true }, spy);
    expect(r6.stale.map((s) => s.dokId)).toEqual(['PROF']);

    // ── 7. --force --dok recovers the human-edited Dok: PROF is judged alone
    //       (checked=1), regenerated, its human marker cleared, and its hash
    //       re-stamped to match the current source. ──
    const r7 = await runSync({ root, force: true, dokId: 'PROF' }, spy);
    expect(r7.regenerated).toEqual(['PROF']);
    expect(r7.checked).toBe(1);
    expect(calls).toEqual(['AUTH', 'PROF']); // PROF is the only new call
    const profAfter = JSON.parse(await readFile(profPath, 'utf-8'));
    expect(profAfter._meta.edited_by_human).toBeUndefined();
    expect(profAfter._meta.logic_hash).toBe(
      computeLogicHash([
        { file: 'app/x2/page.tsx', content: "import '../../src/prof.ts';\nexport default function Page() { return null; }" },
        { file: 'src/prof.ts', content: await readFile(join(root, 'src/prof.ts'), 'utf-8') },
      ]),
    );

    // ── 8. The whole workspace is fresh again. ──
    const r8 = await runSync({ root, check: true }, spy);
    expect(r8.stale).toEqual([]);
  });
});

// ── Priority drift gate ───────────────────────────────────────────────
//
// Severity ranks the diagnostics; it never drops any. A `--json` consumer must
// still receive every stale Dok, whatever tier it landed on.
describe('sync drift severity', () => {
  function resultWith(stale: RunSyncResult['stale']): RunSyncResult {
    return {
      checked: stale.length,
      stale,
      unknown: [],
      regenerated: [],
      returnedToDraft: [],
      skippedHumanEdit: [],
      notInPlan: [],
      planOutdated: [],
      planOutdatedAt: {},
      criticalReasons: {},
      failures: [],
      plannedRegeneration: [],
      plannedReturnToDraft: [],
      transmissions: [],
    };
  }

  it('tags each stale Dok diagnostic with a severity from its tier', () => {
    const diagnostics = buildSyncDiagnostics(resultWith([
      { dokId: 'PAYMENT', reason: 'changed', humanEdited: false, tier: 'critical' },
      { dokId: 'MYPAGE', reason: 'changed', humanEdited: false, tier: 'standard' },
      { dokId: 'ABOUT', reason: 'changed', humanEdited: false, tier: 'peripheral' },
    ]), true);

    const stale = diagnostics.filter((d) => d.code === 'SYNC_STALE_DOK');
    expect(stale.map((d) => d.dokId ?? d.message.split(' ')[0])).toEqual([
      'PAYMENT', 'MYPAGE', 'ABOUT',
    ]);
    expect(stale.map((d) => d.severity)).toEqual(['high', 'normal', 'low']);
  });

  it('derives standard for a Dok nobody has judged', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);

    const result = await runSync({ root, check: true }, spyDeps().deps);

    // The fixture Dok carries no `priority`, and an unjudged Dok must not go
    // quiet just because nobody got to it yet.
    expect(result.stale.map((s) => s.tier)).toEqual(['standard']);
  });
});

describe('criticalDriftReason', () => {
  function dokWith(impact?: string, blast?: string) {
    return {
      dok_id: 'X',
      name: 'X',
      description: 'x',
      status: 'active',
      tags: [],
      surfaces: [],
      ...(impact === undefined
        ? {}
        : { priority: { impact, blast_radius: blast, signals: [], curated: {} } }),
      _meta: { version: 1, history: [] },
    } as never;
  }

  it('names the qualifying impact when the value axis earned it', () => {
    expect(criticalDriftReason(dokWith('revenue', 'degrading'))).toBe('revenue');
    expect(criticalDriftReason(dokWith('core_value', 'degrading'))).toBe('core value');
    expect(criticalDriftReason(dokWith('compliance', 'degrading'))).toBe('compliance');
  });

  // Sign-in is `enabling`, so printing its impact would read as a
  // contradiction — the blast radius is what made it critical.
  it('names blocking when the blast axis earned it', () => {
    expect(criticalDriftReason(dokWith('enabling', 'blocking'))).toBe('blocking');
    expect(criticalDriftReason(dokWith('supporting', 'blocking'))).toBe('blocking');
  });

  it('returns null for a Dok that is not critical', () => {
    expect(criticalDriftReason(dokWith('enabling', 'degrading'))).toBeNull();
    expect(criticalDriftReason(dokWith('supporting', 'cosmetic'))).toBeNull();
    expect(criticalDriftReason(dokWith())).toBeNull();
  });
});

// ── §0b propose-and-approve: regeneration stages _meta.pending_change; the
//    entry itself is only written by a person's approval in Studio. ──
describe('runSync change proposals (pending_change)', () => {
  it('--note stages a human proposal on the regenerated Dok only, with a single version bump and no history entry', async () => {
    const root = await tmpInit();
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await writeSource(root, 'src/user.ts', 'export const u = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    // Simulate a reviewed legacy Dok: active on disk.
    const authPath = join(root, '.doklo/hub/doks/AUTH.json');
    const auth = JSON.parse(await readFile(authPath, 'utf-8')) as { status: string };
    auth.status = 'active';
    await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
    const userPath = join(root, '.doklo/hub/doks/USER.json');
    const userBefore = await readFile(userPath, 'utf-8');
    await writeSource(root, 'src/auth.ts', 'export const a = 2; // changed');

    const result = await runSync(
      { root, proposalNote: { change: 'Auth refactor (PR #7)', category: 'changed' } },
      spyDeps().deps,
    );

    expect(result.regenerated).toEqual(['AUTH']);
    const written = JSON.parse(await readFile(authPath, 'utf-8')) as {
      status: string;
      _meta: { version: number; history: unknown[]; pending_change?: Record<string, unknown> };
    };
    expect(written.status).toBe('draft');
    expect(written._meta.version).toBe(2); // one regeneration = one bump
    expect(written._meta.history).toEqual([]);
    expect(written._meta.pending_change).toEqual({
      summary: 'Auth refactor (PR #7)',
      source: 'human',
      base_version: 1,
      previous_status: 'active',
      category: 'changed',
    });
    expect(await readFile(userPath, 'utf-8')).toBe(userBefore); // fresh peer untouched
  });

  it('stages a deterministic diff proposal when the regenerated content differs and no note is given', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);
    const changedDeps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: {
          ...(makeDok(ctx.dokId) as Record<string, unknown>),
          description: 'Now supports passkeys.',
        } as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
      runLexiconSuggest: noLexiconSuggest,
    };

    await runSync({ root }, changedDeps);

    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    ) as { _meta: { version: number; history: unknown[]; pending_change?: Record<string, unknown> } };
    expect(written._meta.history).toEqual([]);
    expect(written._meta.pending_change).toEqual({
      summary: 'Updated the description.',
      source: 'diff',
      base_version: 1,
      previous_status: 'draft',
    });
  });

  it('stages nothing when the regenerated content is identical (code-only drift)', async () => {
    const root = await tmpInit();
    await seedStaleAuth(root);

    await runSync({ root }, spyDeps().deps);

    const raw = await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8');
    const written = JSON.parse(raw) as {
      _meta: { version: number; history: unknown[]; pending_change?: unknown };
    };
    expect(written._meta.version).toBe(2);
    expect(written._meta.history).toEqual([]);
    expect(raw).not.toContain('pending_change');
    expect(raw).not.toContain('"date"');
  });

  // A regeneration nobody has approved leaves a draft and its proposal on disk.
  // Regenerating that draft again must keep the approved state the proposal
  // remembers, because approval decides the lazy baseline from it.
  describe('a Dok regenerated again before anyone approves it', () => {
    type WrittenAuth = {
      status: string;
      _meta: { version: number; history: unknown[]; pending_change?: Record<string, unknown> };
    };

    const readAuth = async (authPath: string): Promise<WrittenAuth> =>
      JSON.parse(await readFile(authPath, 'utf-8')) as WrittenAuth;

    function regeneratedAs(content: Record<string, unknown>): Partial<GenerateDeps> {
      return {
        generateDokForFeature: async (_f, ctx) => ({
          success: true,
          dok: { ...(makeDok(ctx.dokId) as Record<string, unknown>), ...content } as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        }),
        runLexiconSuggest: noLexiconSuggest,
      };
    }

    // A Dok reviewed before history tracking began (active, version 1, empty
    // history, as in any workspace older than history tracking) is regenerated
    // once — annotated with `firstNote` when given — nobody approves the draft,
    // and the code drifts again.
    async function regenerateOnceUnapproved(
      root: string,
      firstNote?: RunSyncOptions['proposalNote'],
    ): Promise<{ authPath: string; first: WrittenAuth }> {
      await seedStaleAuth(root);
      const authPath = join(root, '.doklo/hub/doks/AUTH.json');
      const legacy = await readAuth(authPath);
      legacy.status = 'active';
      await writeFile(authPath, JSON.stringify(legacy, null, 2) + '\n', 'utf-8');

      await runSync(
        { root, ...(firstNote !== undefined ? { proposalNote: firstNote } : {}) },
        regeneratedAs({ description: 'Now supports passkeys.' }),
      );
      const first = await readAuth(authPath);
      expect(first.status).toBe('draft');
      expect(first._meta.pending_change).toEqual(
        firstNote === undefined
          ? { summary: 'Updated the description.', source: 'diff', base_version: 1, previous_status: 'active' }
          : {
              summary: firstNote.change,
              source: 'human',
              base_version: 1,
              previous_status: 'active',
              category: firstNote.category,
            },
      );

      await writeSource(root, 'src/auth.ts', 'export const a = 3; // changed again');
      return { authPath, first };
    }

    it('keeps the approved base and proposes the new comparison when the content changes further', async () => {
      const root = await tmpInit();
      const { authPath } = await regenerateOnceUnapproved(root);

      await runSync(
        { root },
        regeneratedAs({ description: 'Now supports passkeys.', name: 'Passkey sign-in' }),
      );

      const second = await readAuth(authPath);
      expect(second._meta.version).toBe(3);
      expect(second._meta.history).toEqual([]);
      expect(second._meta.pending_change).toEqual({
        // Describes this step only: the approved content is no longer on disk.
        summary: 'Renamed the feature.',
        source: 'diff',
        base_version: 1,
        previous_status: 'active',
      });
    });

    it('keeps the first proposal byte for byte when the content changes no further', async () => {
      const root = await tmpInit();
      const { authPath, first } = await regenerateOnceUnapproved(root);

      await runSync({ root }, regeneratedAs({ description: 'Now supports passkeys.' }));

      const second = await readAuth(authPath);
      expect(second._meta.version).toBe(3);
      expect(second._meta.history).toEqual([]);
      expect(JSON.stringify(second._meta.pending_change, null, 2))
        .toBe(JSON.stringify(first._meta.pending_change, null, 2));
    });

    it('takes a --note as the sentence and keeps the approved base', async () => {
      const root = await tmpInit();
      const { authPath } = await regenerateOnceUnapproved(root);

      await runSync(
        { root, proposalNote: { change: 'Passkeys replace passwords (PR #9)', category: 'changed' } },
        regeneratedAs({ description: 'Now supports passkeys.', name: 'Passkey sign-in' }),
      );

      const second = await readAuth(authPath);
      expect(second._meta.history).toEqual([]);
      expect(second._meta.pending_change).toEqual({
        summary: 'Passkeys replace passwords (PR #9)',
        source: 'human',
        base_version: 1,
        previous_status: 'active',
        category: 'changed',
      });
    });

    it("keeps a person's unapproved note over a later comparison until a new --note replaces it", async () => {
      const root = await tmpInit();
      const { authPath, first } = await regenerateOnceUnapproved(
        root,
        { change: 'Passkeys replace passwords (PR #9)', category: 'changed' },
      );

      // A plain sync that changes the content further leaves the note as it is.
      await runSync(
        { root },
        regeneratedAs({ description: 'Now supports passkeys.', name: 'Passkey sign-in' }),
      );
      const second = await readAuth(authPath);
      expect(second._meta.version).toBe(3);
      expect(second._meta.history).toEqual([]);
      expect(JSON.stringify(second._meta.pending_change, null, 2))
        .toBe(JSON.stringify(first._meta.pending_change, null, 2));

      // A new note replaces it — sentence and category — on the same approved base.
      await writeSource(root, 'src/auth.ts', 'export const a = 4; // and again');
      await runSync(
        { root, proposalNote: { change: 'Passkeys are now the only way to sign in (PR #12)' } },
        regeneratedAs({ description: 'Now supports passkeys.', name: 'Passkey sign-in' }),
      );
      const third = await readAuth(authPath);
      expect(third._meta.history).toEqual([]);
      expect(third._meta.pending_change).toEqual({
        summary: 'Passkeys are now the only way to sign in (PR #12)',
        source: 'human',
        base_version: 1,
        previous_status: 'active',
      });
    });

    it('lets approval record a baseline before the change, so the changelog reads Changed rather than Added', async () => {
      const root = await tmpInit();
      const { authPath } = await regenerateOnceUnapproved(root);
      await runSync(
        { root },
        regeneratedAs({ description: 'Now supports passkeys.', name: 'Passkey sign-in' }),
      );
      const draft = JSON.parse(await readFile(authPath, 'utf-8')) as Dok;
      const pending = draft._meta.pending_change!;

      // Approve the way Studio's activation does (apps/studio/lib/actions.ts
      // planDokHistory → applyHistoryPlan): the proposal's base tells the core
      // helper what the Dok was before the regenerations demoted it.
      const approved = appendHistoryEntry({
        meta: draft._meta,
        persisted: { status: draft.status, version: draft._meta.version },
        nextStatus: 'active',
        entry: { kind: 'regenerated', change: pending.summary, category: pending.category },
        versionPolicy: 'bump',
        now: () => new Date(2026, 9, 5, 12),
        baselineFrom: { status: pending.previous_status, version: pending.base_version },
      });

      expect(approved.meta.history).toEqual([
        { version: 1, date: '2026-10-05', change: 'Active before history tracking began', kind: 'baseline' },
        {
          version: 4, date: '2026-10-05', change: 'Renamed the feature.',
          kind: 'regenerated', from: 'draft', to: 'active',
        },
      ]);
      const items = classifyDokHistory({ ...draft, status: 'active', _meta: approved.meta });
      expect(items.map((item) => [item.category, item.note])).toEqual([
        ['changed', 'Renamed the feature.'],
      ]);
    });
  });

  it('rejects --note together with --check before touching the workspace', async () => {
    const root = await tmpInit();
    await expect(
      runSync({ root, check: true, proposalNote: { change: 'x' } }, spyDeps().deps),
    ).rejects.toMatchObject({ code: 'SYNC_NOTE_WITH_CHECK' });
  });
});

// ── The review loop after a Studio approval ──
//
// Studio's approval writes `status: active` plus a `status` history entry and
// leaves `_meta.edited_by_human` alone; only a prose or lifecycle edit sets it
// (pinned in apps/studio/__tests__/actions.test.ts). The two apps meet at the
// Dok file, so these fixtures write that file as Studio leaves it.
describe('runSync after a Studio approval', () => {
  const approval = {
    version: 2,
    date: '2026-10-05',
    change: 'Activated',
    author: 'tester',
    kind: 'status',
    from: 'draft',
    to: 'active',
  };

  // Generate AUTH from content A, apply the approval, then drift the source.
  async function seedApprovedStaleAuth(root: string, meta: Record<string, unknown> = {}): Promise<string> {
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['src/auth.ts']);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
    const authPath = join(root, '.doklo/hub/doks/AUTH.json');
    const auth = JSON.parse(await readFile(authPath, 'utf-8')) as Record<string, unknown> & {
      _meta: Record<string, unknown>;
    };
    auth.status = 'active';
    auth._meta = { ...auth._meta, version: 2, history: [approval], ...meta };
    await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
    await writeSource(root, 'src/auth.ts', 'export const a = 2; // changed');
    return authPath;
  }

  it('regenerates an approved Dok without --force and stages a proposal for the next approval', async () => {
    const root = await tmpInit();
    const authPath = await seedApprovedStaleAuth(root);
    const calls: string[] = [];
    const changedDeps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        calls.push(ctx.dokId);
        return {
          success: true,
          dok: {
            ...(makeDok(ctx.dokId) as Record<string, unknown>),
            description: 'Now supports passkeys.',
          } as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
      runLexiconSuggest: noLexiconSuggest,
    };

    const result = await runSync({ root }, changedDeps);

    expect(result.stale).toEqual([
      { dokId: 'AUTH', reason: 'changed', humanEdited: false, tier: 'standard' },
    ]);
    expect(result.skippedHumanEdit).toEqual([]);
    expect(result.regenerated).toEqual(['AUTH']);
    expect(calls).toEqual(['AUTH']);
    const written = JSON.parse(await readFile(authPath, 'utf-8')) as {
      status: string;
      description: string;
      _meta: {
        version: number;
        edited_by_human?: boolean;
        history: unknown[];
        pending_change?: Record<string, unknown>;
      };
    };
    expect(written.status).toBe('draft');
    expect(written.description).toBe('Now supports passkeys.');
    expect(written._meta.version).toBe(3);
    expect(written._meta.history).toEqual([approval]); // the approval survives regeneration
    expect(written._meta.pending_change).toEqual({
      summary: 'Updated the description.',
      source: 'diff',
      base_version: 2,
      previous_status: 'active',
    });
    expect(written._meta.edited_by_human).toBeUndefined();
  });

  it('still skips an approved Dok whose prose a person edited', async () => {
    const root = await tmpInit();
    const authPath = await seedApprovedStaleAuth(root, { edited_by_human: true });
    const before = await readFile(authPath, 'utf-8');
    const { deps, calls } = spyDeps();

    const result = await runSync({ root }, deps);

    expect(result.stale).toEqual([
      { dokId: 'AUTH', reason: 'changed', humanEdited: true, tier: 'standard' },
    ]);
    expect(result.skippedHumanEdit).toEqual(['AUTH']);
    expect(result.regenerated).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readFile(authPath, 'utf-8')).toBe(before);
  });

  // Regeneration always writes `draft`, so an approved Dok a plain sync
  // regenerates drops out of stable Live Docs (and fails a saved Publication
  // that names it) until someone approves it again. The person hears it before
  // consent and in the summary; `--json` consumers read it from the result.
  describe('naming the approved Doks a sync returns to draft', () => {
    // AUTH is approved the way Studio leaves it; USER was generated and never
    // approved. Both drift, so one plain sync regenerates both.
    async function seedApprovedAndDraftStale(root: string): Promise<void> {
      await writeConsolidatedMulti(root, 'web', [
        { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
        { prefix: 'USER', sourceFiles: ['src/user.ts'] },
      ]);
      await writeSource(root, 'src/auth.ts', 'export const a = 1;');
      await writeSource(root, 'src/user.ts', 'export const u = 1;');
      await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
      const authPath = join(root, '.doklo/hub/doks/AUTH.json');
      const auth = JSON.parse(await readFile(authPath, 'utf-8')) as Record<string, unknown> & {
        _meta: Record<string, unknown>;
      };
      auth.status = 'active';
      auth._meta = { ...auth._meta, version: 2, history: [approval] };
      await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
      await writeSource(root, 'src/auth.ts', 'export const a = 2; // changed');
      await writeSource(root, 'src/user.ts', 'export const u = 2; // changed');
    }

    const readStatus = async (root: string, dokId: string): Promise<string> =>
      (JSON.parse(
        await readFile(join(root, `.doklo/hub/doks/${dokId}.json`), 'utf-8'),
      ) as { status: string }).status;

    // The real command, with the stubbed generator and a stubbed credential
    // lookup. Consent is the real gate (approved by --yes), wrapped only to
    // mark the moment it is asked for in the captured output.
    async function syncThroughCommander(root: string, args: string[]): Promise<{
      lines: string[];
      result: CommandResult<RunSyncResult> | undefined;
    }> {
      const output: string[] = [];
      const program = new Command();
      registerSyncCommand(program, createContext('en'), {
        runSync: (options) => runSyncDirect(options, stubDeps),
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'anthropic',
          authSource: 'keychain',
          apiKey: 'test-key',
        }),
        authorizeLlmRun: async (...consent: Parameters<typeof authorizeLlmRun>) => {
          output.push('<consent>');
          return authorizeLlmRun(...consent);
        },
      });
      const capture = (...parts: unknown[]): void => {
        output.push(parts.map(String).join(' '));
      };
      const log = vi.spyOn(console, 'log').mockImplementation(capture);
      const error = vi.spyOn(console, 'error').mockImplementation(capture);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      }) as never);
      try {
        await program.parseAsync(['sync', '--root', root, ...args], { from: 'user' });
      } finally {
        stdout.mockRestore();
        error.mockRestore();
        log.mockRestore();
      }
      return {
        // eslint-disable-next-line no-control-regex
        lines: output.join('\n').replace(/\u001b\[[0-9;]*m/g, '').split('\n'),
        result: takeCommandResult(program) as CommandResult<RunSyncResult> | undefined,
      };
    }

    const lineWith = (lines: string[], text: string): number =>
      lines.findIndex((line) => line.includes(text));

    const FORECAST = '1 approved Dok(s) in this plan will return to draft until re-approved.';
    const SUMMARY = '1 approved Dok(s) returned to draft — approve them in the web app to publish them again.';

    it('lists only the approved Dok a plain sync regenerated, not the never-approved draft beside it', async () => {
      const root = await tmpInit();
      await seedApprovedAndDraftStale(root);

      // The preview behind the consent step forecasts it; nothing has run yet.
      const preview = await runSyncDirect({ root, previewOnly: true }, stubDeps);
      expect([...preview.plannedRegeneration].sort()).toEqual(['AUTH', 'USER']);
      expect(preview.plannedReturnToDraft).toEqual(['AUTH']);
      expect(preview.returnedToDraft).toEqual([]);

      const { deps, calls } = spyDeps();
      const result = await runSync({ root }, deps);

      expect([...calls].sort()).toEqual(['AUTH', 'USER']);
      expect([...result.regenerated].sort()).toEqual(['AUTH', 'USER']);
      expect(result.plannedReturnToDraft).toEqual(['AUTH']);
      expect(result.returnedToDraft).toEqual(['AUTH']); // USER was a draft before the run
      expect(await readStatus(root, 'AUTH')).toBe('draft');
      expect(await readStatus(root, 'USER')).toBe('draft');
    });

    it('scopes the list to the one Dok --dok judged', async () => {
      const root = await tmpInit();
      await seedApprovedAndDraftStale(root);

      const user = await runSync({ root, dokId: 'USER' }, spyDeps().deps);
      expect(user.regenerated).toEqual(['USER']);
      expect(user.returnedToDraft).toEqual([]);
      expect(await readStatus(root, 'AUTH')).toBe('active'); // not judged, not touched

      const auth = await runSync({ root, dokId: 'auth' }, spyDeps().deps);
      expect(auth.regenerated).toEqual(['AUTH']);
      expect(auth.returnedToDraft).toEqual(['AUTH']);
    });

    it('says so before consent and in the summary, counting only the approved Dok', async () => {
      const root = await tmpInit();
      await seedApprovedAndDraftStale(root);

      const { lines, result } = await syncThroughCommander(root, ['--yes']);

      const plan = lineWith(lines, 'LLM consent plan');
      const forecast = lineWith(lines, FORECAST);
      const consent = lines.indexOf('<consent>');
      expect(plan).toBeGreaterThanOrEqual(0);
      expect(forecast).toBeGreaterThan(plan);
      expect(consent).toBeGreaterThan(forecast);
      expect(lineWith(lines, 'Regenerated 2 Dok(s).')).toBeGreaterThan(consent);
      expect(lineWith(lines, SUMMARY)).toBeGreaterThan(lineWith(lines, 'Regenerated 2 Dok(s).'));
      expect(result?.status).toBe('success');
      expect(result?.data?.returnedToDraft).toEqual(['AUTH']);
      expect(await readStatus(root, 'AUTH')).toBe('draft');
    });

    it('--check prints the stale list but neither line, and its result lists nothing', async () => {
      const root = await tmpInit();
      await seedApprovedAndDraftStale(root);

      const { lines, result } = await syncThroughCommander(root, ['--check']);

      expect(lineWith(lines, '2 stale Dok(s):')).toBeGreaterThanOrEqual(0);
      expect(lines.join('\n')).not.toMatch(/to draft/);
      expect(lines).not.toContain('<consent>');
      expect(result?.status).toBe('partial');
      expect(result?.data).toMatchObject({ plannedReturnToDraft: [], returnedToDraft: [] });
      expect(await readStatus(root, 'AUTH')).toBe('active');
    });

    it('--json keeps stdout machine-readable and carries the lists in the result envelope', async () => {
      const root = await tmpInit();
      await seedApprovedAndDraftStale(root);

      const { lines, result } = await syncThroughCommander(root, ['--yes', '--json']);

      const printed = lines.filter((line) => line !== '' && line !== '<consent>');
      expect(printed.map((line) => (JSON.parse(line) as { stage: string }).stage))
        .toEqual(['consent-plan']);
      expect(result?.data).toMatchObject({
        plannedReturnToDraft: ['AUTH'],
        returnedToDraft: ['AUTH'],
      });
    });
  });
});

// ── Format-only edits (judge-gated sync design §4.2, layer 1) ─────────────
//
// generate stamps `_meta.logic_hash_normalized`; a later edit that only touches
// comments, whitespace or line endings leaves it equal, so the Dok is not stale
// — sync never regenerates it, and --check says how many there were.
describe('sync — format-only edits', () => {
  async function seedTwoFresh(root: string): Promise<void> {
    await writeConsolidatedMulti(root, 'web', [
      { prefix: 'AUTH', sourceFiles: ['src/auth.ts'] },
      { prefix: 'USER', sourceFiles: ['src/user.ts'] },
    ]);
    await writeSource(root, 'src/auth.ts', 'export const a = 1;\n');
    await writeSource(root, 'src/user.ts', 'export const u = 1;\n');
    await runGenerate({ root, ...isolatedGenerateOptions }, stubDeps);
  }

  async function syncLines(root: string, args: string[], locale: 'en' | 'ko' = 'en'): Promise<{
    lines: string[];
    result: CommandResult<RunSyncResult> | undefined;
  }> {
    const output: string[] = [];
    const program = new Command();
    registerSyncCommand(program, createContext(locale), {
      runSync: (options) => runSyncDirect(options, stubDeps),
    });
    const capture = (...parts: unknown[]): void => { output.push(parts.map(String).join(' ')); };
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    try {
      await program.parseAsync(['sync', '--root', root, ...args], { from: 'user' });
    } finally {
      log.mockRestore();
    }
    return {
      // eslint-disable-next-line no-control-regex
      lines: output.join('\n').replace(/\u001b\[[0-9;]*m/g, '').split('\n'),
      result: takeCommandResult(program) as CommandResult<RunSyncResult> | undefined,
    };
  }

  it('--check: a comments-only edit is fresh (format-only); a real edit is stale', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      await writeSource(root, 'src/auth.ts', '// Auth flag.\nexport const a = 1; // one\n');
      await writeSource(root, 'src/user.ts', 'export const u = 2;\n');

      const { deps, calls } = spyDeps();
      const result = await runSync({ root, check: true }, deps);

      expect(result.formatOnly).toEqual(['AUTH']);
      expect(result.stale).toEqual([
        { dokId: 'USER', reason: 'changed', humanEdited: false, tier: 'standard' },
      ]);
      expect(result.unknown).toEqual([]);
      expect(calls).toEqual([]);
      expect(buildSyncDiagnostics(result, true).map((d) => d.message).join('\n')).not.toContain('AUTH');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never regenerates a format-only Dok and leaves its file untouched', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      const authPath = join(root, '.doklo/hub/doks/AUTH.json');
      const before = await readFile(authPath, 'utf-8');
      await writeSource(root, 'src/auth.ts', 'export   const a = 1;\r\n/* trailing note */\n');

      const { deps, calls } = spyDeps();
      const result = await runSync({ root }, deps);

      expect(result.stale).toEqual([]);
      expect(result.formatOnly).toEqual(['AUTH']);
      expect(result.regenerated).toEqual([]);
      expect(calls).toEqual([]);
      expect(await readFile(authPath, 'utf-8')).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a Dok without logic_hash_normalized (generated before layer 1) keeps the raw comparison', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      const authPath = join(root, '.doklo/hub/doks/AUTH.json');
      const auth = JSON.parse(await readFile(authPath, 'utf-8')) as { _meta: Record<string, unknown> };
      delete auth._meta['logic_hash_normalized'];
      await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
      await writeSource(root, 'src/auth.ts', '// Auth flag.\nexport const a = 1;\n');

      const result = await runSync({ root, check: true }, spyDeps().deps);

      expect(result.formatOnly).toEqual([]);
      expect(result.stale).toEqual([
        { dokId: 'AUTH', reason: 'changed', humanEdited: false, tier: 'standard' },
      ]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a hash stamped by another normaliser version is never compared', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      const authPath = join(root, '.doklo/hub/doks/AUTH.json');
      const auth = JSON.parse(await readFile(authPath, 'utf-8')) as { _meta: Record<string, string> };
      auth._meta['logic_hash_normalized'] = auth._meta['logic_hash_normalized']!.replace(/^[^:]+:/, 'ts-tree-v0+ts0.0.0:');
      await writeFile(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8');
      await writeSource(root, 'src/auth.ts', '// Auth flag.\nexport const a = 1;\n');

      const result = await runSync({ root, check: true }, spyDeps().deps);

      expect(result.formatOnly).toEqual([]);
      expect(result.stale.map((s) => [s.dokId, s.reason])).toEqual([['AUTH', 'changed']]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('--check prints the form-only count beside the stale list', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      await writeSource(root, 'src/auth.ts', '// Auth flag.\nexport const a = 1;\n');
      await writeSource(root, 'src/user.ts', 'export const u = 2;\n');

      const { lines, result } = await syncLines(root, ['--check']);

      expect(lines).toContain('  1 stale Dok(s):');
      expect(lines).toContain('  1 Dok(s) changed in form only (comments, whitespace) — still fresh.');
      expect(result?.status).toBe('partial');
      expect(result?.data?.formatOnly).toEqual(['AUTH']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('when nothing is stale, the all-fresh line is followed by the form-only count (en and ko)', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      await writeSource(root, 'src/auth.ts', '// Auth flag.\nexport const a = 1;\n');

      const en = await syncLines(root, ['--check']);
      const fresh = en.lines.indexOf('  All 2 Dok(s) are fresh — nothing to sync.');
      expect(fresh).toBeGreaterThanOrEqual(0);
      expect(en.lines[fresh + 1]).toBe('  1 Dok(s) changed in form only (comments, whitespace) — still fresh.');
      expect(en.result?.status).toBe('success');

      const ko = await syncLines(root, ['--check'], 'ko');
      expect(ko.lines).toContain('  1개 Dok은 형태만 바뀌었습니다 (주석, 공백) — 여전히 최신 상태입니다.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prints no form-only line when there is none', async () => {
    const root = await tmpInit();
    try {
      await seedTwoFresh(root);
      const { lines, result } = await syncLines(root, ['--check']);
      expect(lines.join('\n')).not.toContain('form only');
      expect(result?.data?.formatOnly).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
