import { describe, it, expect, vi } from 'vitest';
import { chmod, link, mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
const { commandConsolidateMock, commandGenerateDokMock, resolveLlmForRoleMock } = vi.hoisted(() => ({
  commandConsolidateMock: vi.fn(),
  commandGenerateDokMock: vi.fn(),
  resolveLlmForRoleMock: vi.fn(async () => ({
    model: 'anthropic/claude-sonnet-5',
    providerKind: 'anthropic' as const,
    apiKey: 'test-key',
  })),
}));
vi.mock('@doklo-beta/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/generator')>();
  return {
    ...actual,
    consolidateFeatures: commandConsolidateMock,
    generateDokForFeature: commandGenerateDokMock,
  };
});
vi.mock('../src/lib/llm-options.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/llm-options.js')>();
  return { ...actual, resolveLlmForRole: resolveLlmForRoleMock };
});
import {
  runGenerate as runGenerateDirect,
  registerGenerateCommand,
  ConsolidatedCacheMissingError,
  GenerateScanCacheMissingError,
  type GenerateCommandDeps,
  type GenerateDeps,
  type GenerateProgressEvent,
  type RunGenerateOptions,
} from '../src/commands/generate.js';
import {
  computeLogicHash,
  IaFileV2Schema,
  isDokStale,
  ServiceCodeMappingFileSchema,
  writeFileAtomicContained,
  type IaNodeV2,
  type ProjectIR,
} from '@doklo-beta/core';
import type { ConsolidatedFeatureConfig } from '@doklo-beta/generator';
import { resolveContainedOutputPath, ROUTE_HIERARCHY_PRODUCER } from '@doklo-beta/generator';
import { createContext } from '../src/lib/context.js';
import * as generationGate from '../src/lib/generate-gate.js';
import { runConsolidate } from '../src/commands/consolidate.js';
import {
  emitCommandResult,
  takeCommandResult,
  CommandContractError,
  toCommandContractError,
  type CommandResult,
} from '../src/lib/command-result.js';
import {
  LlmTokenCapError,
  registerLlmRun,
  reserveRegisteredLlmCall,
} from '../src/lib/llm-cost-cap.js';
import {
  authorizeLlmRun,
  buildLlmRunPlan,
} from '../src/lib/llm-preflight.js';

async function paidConsent(
  options: RunGenerateOptions,
  deps?: Partial<GenerateDeps>,
  llm: Parameters<typeof buildLlmRunPlan>[0]['llm'] = {
    providerKind: 'anthropic',
    model: 'anthropic/claude-sonnet-5',
    authSource: 'keychain',
    apiKey: 'test-key',
  },
) {
  const preview = await runGenerateDirect({ ...options, dryRun: true }, deps);
  if (preview.plan.length === 0) return {};
  const debugDir = await resolveContainedOutputPath(options.root, '.doklo/debug');
  const plan = buildLlmRunPlan({
    llm,
    candidateFiles: preview.transmissions,
    workItems: preview.plan.map((item) => ({
      phase: 'generate' as const,
      serviceId: item.serviceId,
      id: item.dokId,
    })),
    calls: {
      consolidate: 0,
      lexicon: 0,
      generateMax: preview.plan.length,
      judgeMax: 0,
    },
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
    debugDir,
  });
  return {
    plan,
    authorizedRun: await authorizeLlmRun(options.root, plan, llm, { yes: true, isTTY: false }),
    preparedGeneration: preview.preparedGeneration,
  };
}

async function runGenerate(
  options: RunGenerateOptions,
  deps?: Partial<GenerateDeps>,
) {
  return runGenerateDirect(
    options.dryRun ? options : { ...options, ...await paidConsent(options, deps) },
    deps,
  );
}

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

async function writeFixtureFiles(root: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, 'export default function Fixture() { return null; }\n');
  }
}

async function writeSupportedNextProject(root: string): Promise<void> {
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

async function runGenerateThroughCommander(
  root: string,
  args: string[],
  deps: Partial<GenerateCommandDeps> = {},
): Promise<{
  result: CommandResult<unknown> | undefined;
  exitCode: typeof process.exitCode;
}> {
  const program = new Command();
  registerGenerateCommand(program, createContext('en'), deps);
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await program.parseAsync(
      ['generate', '--root', root, '--yes', '--no-lexicon', ...args],
      { from: 'user' },
    );
    return {
      result: takeCommandResult(program),
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExitCode;
    stdoutSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleSpy.mockRestore();
  }
}

type JsonProgressEvent = { stage: string; status?: string; phase?: string; serviceId?: string };

async function captureGenerateProgress(
  root: string,
  args: string[],
  deps: Partial<GenerateCommandDeps> = {},
): Promise<JsonProgressEvent[]> {
  const program = new Command();
  registerGenerateCommand(program, createContext('en'), deps);
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await program.parseAsync([
      'generate', '--root', root, '--progress-json', '--yes', '--no-lexicon',
      '--no-roles', '--no-ia', '--no-code-mapping', ...args,
    ], { from: 'user' });
    return chunks.join('').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as JsonProgressEvent);
  } finally {
    process.exitCode = previousExitCode;
    consoleErrorSpy.mockRestore();
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
}

async function captureGenerateProgressFailure(
  root: string,
  args: string[],
  deps: Partial<GenerateCommandDeps> = {},
): Promise<{ events: JsonProgressEvent[]; error: unknown }> {
  const program = new Command();
  registerGenerateCommand(program, createContext('en'), deps);
  const chunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    let error: unknown;
    try {
      await program.parseAsync([
        'generate', '--root', root, '--progress-json', '--yes', '--no-lexicon',
        '--no-roles', '--no-ia', '--no-code-mapping', ...args,
      ], { from: 'user' });
    } catch (caught) {
      error = caught;
    }
    return {
      events: chunks.join('').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as JsonProgressEvent),
      error,
    };
  } finally {
    process.exitCode = previousExitCode;
    consoleErrorSpy.mockRestore();
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  }
}

async function addNextService(root: string, serviceId: string): Promise<void> {
  const serviceRoot = join(root, 'services', serviceId);
  await writeSupportedNextProject(serviceRoot);
  const workspace = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf-8')) as {
    services: Array<{ service_id: string; type: string; framework: string; code_root: string }>;
  };
  workspace.services.push({
    service_id: serviceId,
    type: 'frontend',
    framework: 'nextjs',
    code_root: `services/${serviceId}`,
  });
  await writeFile(join(root, 'workspace.json'), JSON.stringify(workspace), 'utf-8');
}

// A success-returning stub LLM (Dok mirrors the requested id). The drift tests
// below only care about deterministic _meta injection, not the LLM body.
const stubDeps: Partial<GenerateDeps> = {
  generateDokForFeature: async (_f, ctx) => ({
    success: true,
    dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
    prompt: '',
    rawResponse: '',
    usage: null,
  }),
};

// Consolidated cache carrying explicit member source files for a single feature.
async function writeConsolidatedWithFiles(
  root: string,
  serviceId: string,
  prefix: string,
  sourceFiles: string[],
): Promise<void> {
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.consolidated.json`),
    JSON.stringify({
      projectName: 'demo',
      basedOnFeaturesAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      model: 'claude-haiku-4-5',
      originalFeatureIds: ['f'],
      userReviewed: false,
      stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
      groups: [
        {
          group_id: 'g',
          label: 'g',
          excluded: [],
          features: [
            {
              canonical_id: 'f',
              label: 'F',
              dok_id_prefix: prefix,
              decision: 'keep',
              members: ['f'],
              primary_route: '/x',
              reason: '',
              user_reviewed: false,
              source_files: sourceFiles,
            },
          ],
        },
      ],
    }),
    'utf-8',
  );
}

// B1: consolidated cache carrying, per feature, BOTH the display set
// (source_files — shared infra excluded) and the drift set (logic_files — the
// full reachable closure, shared infra included). Mirrors the exact B1 shape:
// a shared util lives in logic_files but NOT source_files.
async function writeConsolidatedWithLogicFiles(
  root: string,
  serviceId: string,
  features: { prefix: string; route: string; source_files: string[]; logic_files: string[] }[],
): Promise<void> {
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.consolidated.json`),
    JSON.stringify({
      projectName: 'demo',
      basedOnFeaturesAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      model: 'claude-haiku-4-5',
      originalFeatureIds: features.map((_, i) => `f${i}`),
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
            members: [`f${i}`],
            primary_route: f.route,
            reason: '',
            user_reviewed: false,
            source_files: f.source_files,
            logic_files: f.logic_files,
          })),
        },
      ],
    }),
    'utf-8',
  );
}

async function writeMentorFixture(root: string, serviceId = 'web'): Promise<void> {
  const source = 'app/mentor/profile/page.tsx';
  await mkdir(join(root, 'app/mentor/profile'), { recursive: true });
  await writeFile(join(root, source), 'export default function MentorProfile() {}', 'utf-8');
  await writeScanIr(root, serviceId, {
    files: [source],
    routes: [
      {
        path: '/mentor/profile',
        kind: 'page',
        file: source,
        dynamic_params: [],
        layout_chain: [],
      },
    ],
    role_signals: [
      {
        value: 'mentor',
        kind: 'actor_type',
        source: 'explicit',
        file: source,
        line: 1,
        detector: 'identity-role-union',
      },
    ],
  });
  await writeFile(
    join(root, '.doklo/cache', `${serviceId}.consolidated.json`),
    JSON.stringify({
      projectName: 'demo',
      basedOnFeaturesAt: '2026-07-15T00:00:00.000Z',
      generatedAt: '2026-07-15T00:00:00.000Z',
      model: 'test',
      originalFeatureIds: ['mentor-profile'],
      userReviewed: false,
      stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
      groups: [
        {
          group_id: 'mentor',
          label: 'Mentoring',
          excluded: [],
          features: [
            {
              canonical_id: 'mentor-profile',
              label: 'Mentor profile',
              dok_id_prefix: 'MENTOR',
              decision: 'keep',
              members: ['mentor-profile'],
              primary_route: '/mentor/profile',
              reason: '',
              user_reviewed: false,
              source_files: [source],
            },
          ],
        },
      ],
    }),
    'utf-8',
  );
}

function findIaNode(nodes: readonly IaNodeV2[], path: string): IaNodeV2 | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findIaNode(node.children, path);
    if (child !== undefined) return child;
  }
  return undefined;
}

/** A pre-v2 ia.json: a producer-owned flat nav plus a hand-curated navigation. */
function legacyIaFile() {
  return {
    service_id: 'web',
    trees: [
      {
        tree_id: 'web-nav',
        type: 'navigation',
        platform: 'all',
        source: 'auto',
        nodes: [
          {
            path: '/mentor/profile',
            label: 'mentor profile',
            dok_ref: 'MENTOR',
            children: [],
          },
        ],
      },
      {
        tree_id: 'web-main-nav',
        type: 'navigation',
        platform: 'all',
        source: 'manual',
        nodes: [{
          label: 'Account',
          children: [{
            path: '/mentor/profile',
            label: 'My profile',
            dok_ref: 'MENTOR',
            children: [],
          }],
        }],
      },
    ],
    edges: [],
    version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function emptyDerivedRouteHierarchy(serviceId: string) {
  return IaFileV2Schema.parse({
    service_id: serviceId,
    version: 2,
    trees: [
      {
        tree_id: `${serviceId}-routes`,
        type: 'route_hierarchy',
        source: 'auto',
        producer: ROUTE_HIERARCHY_PRODUCER,
        platform: 'all',
        nodes: [],
      },
    ],
  });
}

describe('generation planning readiness', () => {
  it('offers a valid backend correction before reading a workspace', async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerGenerateCommand(program, createContext('en'));
    await expect(program.parseAsync(['generate', '--llm-backend', 'anthropic'], { from: 'user' }))
      .rejects.toThrow(/doklo generate --llm-backend anthropic-api/);
  });

  it.each([{ serviceId: undefined, onlyDokIds: undefined }, { serviceId: 'web', onlyDokIds: undefined },
    { serviceId: 'web', onlyDokIds: ['AUTH'] }])('keeps a cached plan without scan evidence unexecutable (%j)', async ({ serviceId, onlyDokIds }) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await rm(join(root, '.doklo/cache/web.scan.json'));
    const result = await runGenerateDirect({ root, dryRun: true, serviceId, onlyDokIds });
    expect(result.planning).toMatchObject({ complete: false, services: [{
      serviceId: 'web', status: 'needs-scan', dokCount: null,
      nextStep: { command: 'doklo scan --service web', paid: false },
    }] });
    expect(result.plan).toEqual([]);
    expect(result.preparedGeneration?.items).toEqual([]);
    expect(await readdir(join(root, '.doklo/cache'))).toEqual(['web.consolidated.json']);
  });

  it('reports an unconsolidated service as unknown, with free source candidates and its next paid step', async () => {
    const root = await tmpInit();
    const before = await readdir(join(root, '.doklo/cache'));
    const result = await runGenerateDirect({ root, dryRun: true, serviceId: 'web' });
    expect(result.plan).toEqual([]);
    expect(result.planning).toMatchObject({
      complete: false,
      services: [{ serviceId: 'web', status: 'needs-consolidation', dokCount: null,
        nextStep: { command: 'doklo consolidate --service web', paid: true },
        candidates: { preview: { sourceFeatureCount: 1, transmittedFiles: ['app/page.tsx'] } } }],
    });
    expect(await readdir(join(root, '.doklo/cache'))).toEqual(before);
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual([]);
  });

  it('previews sources before the first scan without creating caches', async () => {
    const root = await tmpInit();
    await rm(join(root, '.doklo/cache/web.scan.json'));
    const result = await runGenerateDirect({ root, dryRun: true });
    expect(result.planning).toMatchObject({ complete: false, services: [{
      status: 'needs-scan', dokCount: null,
      nextStep: { command: 'doklo scan --service web', paid: false },
      nextPaidStep: 'doklo consolidate --service web',
      candidates: { preview: { sourceFeatureCount: 1 } },
    }] });
    expect(await readdir(join(root, '.doklo/cache'))).toEqual([]);
  });

  it('distinguishes an actual empty plan from a mixed-service incomplete plan', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', []);
    const empty = await runGenerateDirect({ root, dryRun: true });
    expect(empty.planning).toMatchObject({ complete: true, services: [{ status: 'ready', dokCount: 0 }] });
    await writeConsolidated(root, 'web', ['AUTH']);
    await addNextService(root, 'admin');
    const mixed = await runGenerateDirect({ root, dryRun: true });
    expect(mixed.plan.map(item => item.dokId)).toEqual(['AUTH']);
    expect(mixed.planning).toMatchObject({ complete: false, services: [
      { serviceId: 'web', status: 'ready', dokCount: 1 },
      { serviceId: 'admin', status: 'needs-scan', dokCount: null },
    ] });
  });
});

describe('paid consolidation usage across generation exits', () => {
  it.each([
    ['consent', true], ['consent', false], ['cap', true], ['cap', false],
    ['preflight', true], ['preflight', false], ['cancel', false], ['studio', false],
  ] as const)('retains and emits usage after %s (machine=%s)', async (exit, machine) => {
    const root = await tmpInit();
    const program = new Command();
    const output: string[] = [];
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const oldCap = process.env.DOKLO_MAX_TOKENS_PER_RUN;
    const log = vi.spyOn(console, 'log').mockImplementation((value) => { output.push(String(value)); });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output.push(String(value)); return true; });
    const gate = vi.spyOn(generationGate, 'runGateInteraction').mockResolvedValue(exit === 'studio' ? 'studio' : 'cancel');
    let generated = false;
    registerGenerateCommand(program, createContext('en'), {
      resolveLlmForRole: async () => ({ model: 'anthropic/claude-sonnet-5', providerKind: 'anthropic', apiKey: 'test-key' }),
      runConsolidate: async (opts) => {
        const result = await runConsolidate(opts, { consolidateFeatures: async () => ({
          success: true, config: makeConsolidatedConfig(['AUTH']), prompt: '',
          estimatedInputTokens: 1, estimatedOutputTokens: null,
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
        }) });
        if (!opts.dryRun && exit === 'cap') process.env.DOKLO_MAX_TOKENS_PER_RUN = '1';
        if (!opts.dryRun && exit === 'preflight') await writeFile(join(root, '.doklo/hub/roles.json'), '{invalid');
        return result;
      },
      authorizeLlmRun: async (workspace, plan, llm) => authorizeLlmRun(workspace, plan, llm,
        exit === 'consent' && plan.calls.generateMax > 0
          ? { yes: false, isTTY: true, confirm: async () => false }
          : { yes: true, isTTY: false }),
      runGenerateDeps: { generateDokForFeature: async () => { generated = true; throw new Error('Unexpected generation'); } },
    });
    try {
      let failure: unknown;
      try {
        await program.parseAsync(['generate', '--root', root, '--no-lexicon', '--no-roles', '--no-ia', '--no-code-mapping',
          ...(machine ? ['--json', '--yes'] : [])], { from: 'user' });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CommandContractError);
      const result = (failure as CommandContractError).result;
      expect(result.data).toMatchObject({ consolidationAttempts: [{
        phase: 'consolidate', serviceId: 'web', model: 'anthropic/claude-sonnet-5', success: true,
        estimated: { outputTokens: null, maxOutputTokens: 32768 },
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
      }] });
      expect(generated).toBe(false);
      if (machine) {
        emitCommandResult(result, { machine: true,
          stdout: { write: (value: string | Uint8Array) => { output.push(String(value)); return true; } },
          stderr: { write: () => true } });
        const last = JSON.parse(output.at(-1)!);
        expect(last.result.data.consolidationAttempts).toHaveLength(1);
      } else {
        expect(output.filter(line => line.includes('measured input 40, output 20'))).toHaveLength(1);
      }
    } finally {
      log.mockRestore(); stdout.mockRestore(); gate.mockRestore();
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (oldCap === undefined) delete process.env.DOKLO_MAX_TOKENS_PER_RUN;
      else process.env.DOKLO_MAX_TOKENS_PER_RUN = oldCap;
    }
  });
});

describe('runGenerate', () => {
  it('throws a descriptive cache error for an explicitly selected service', async () => {
    const root = await tmpInit();
    const promise = runGenerate({ root, serviceId: 'web', noLexicon: true });
    await expect(promise).rejects.toThrowError(
      ConsolidatedCacheMissingError,
    );
    await expect(runGenerate({ root, serviceId: 'web', noLexicon: true })).rejects.toThrow(
      /web.*consolidated/i,
    );
  });

  it('writes one .doklo/hub/doks/<DOK-ID>.json per consolidated feature', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);

    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_feature, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '<prompt>',
        rawResponse: '{}',
        usage: null,
      }),
    };

    const result = await runGenerate({ root, noLexicon: true }, deps);
    expect(result.results).toHaveLength(2);
    const generated = await readdir(join(root, '.doklo/hub/doks'));
    expect(generated.sort()).toEqual(['AUTH.json', 'USER.json']);
    const statuses = await Promise.all(generated.map(async (file) => {
      const dok = JSON.parse(await readFile(join(root, '.doklo/hub/doks', file), 'utf8')) as {
        status?: unknown;
      };
      return dok.status;
    }));
    expect(statuses).toEqual(['draft', 'draft']);
  });

  it('creates the hub doks dir when missing (no ENOENT on a stale/legacy workspace)', async () => {
    // Mimic a workspace with workspace.json + cache but NO .doklo/hub (legacy
    // doklo-cli layout, or a deleted hub). generate must create its own output
    // directory rather than crashing with ENOENT.
    const root = await mkdtemp(join(tmpdir(), 'doklo-gen-nohub-'));
    await writeSupportedNextProject(root);
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
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeScanIr(root, 'web');

    const result = await runGenerate({ root, noLexicon: true }, stubDeps);
    expect(result.failures).toHaveLength(0);
    expect(result.results.map((r) => r.dokId)).toEqual(['AUTH']);
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual(['AUTH.json']);
  });

  it('rejects a consolidated cache that gives two features the same prefix', async () => {
    // The prefix IS the dok_id now — there is no serial suffix left to tell
    // two features apart, so a shared prefix is a hard error rather than
    // AUTH/AUTH.
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'AUTH']);

    const generator = vi.fn(async (_f, ctx) => ({
      success: true,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: null,
    }));

    await expect(
      runGenerate({ root, noLexicon: true }, { generateDokForFeature: generator }),
    ).rejects.toThrow(/Duplicate dok_id_prefix "AUTH"/);
    expect(generator).not.toHaveBeenCalled();
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual([]);
  });

  it('records failed generations in result.failures (does not throw)', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);

    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async () => ({
        success: false,
        dok: null,
        prompt: '',
        rawResponse: 'not json',
        usage: null,
        error: 'JSON parse failed',
      }),
    };

    const result = await runGenerate({ root, noLexicon: true }, deps);
    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.dokId).toBe('AUTH');
    expect(result.failures[0]?.reason).toMatch(/JSON parse/);
  });

  it('stops after an aborted provider call and preserves only completed Doks', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER', 'BILL']);
    const controller = new AbortController();
    const calls: string[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_feature, ctx, options) => {
        calls.push(ctx.dokId);
        expect(options.signal).toBe(controller.signal);
        if (ctx.dokId === 'USER') controller.abort(new Error('SIGINT'));
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: ctx.dokId === 'USER'
            ? null
            : { input_tokens: 10, output_tokens: 20 },
        };
      },
    };
    const consent = await paidConsent({
      root,
      signal: controller.signal,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    }, deps);

    const result = await runGenerateDirect({
      root,
      signal: controller.signal,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
      ...consent,
    }, deps);

    expect(calls).toEqual(['AUTH', 'USER']);
    expect(result.interrupted).toBe(true);
    expect(result.results.map((entry) => entry.dokId)).toEqual(['AUTH']);
    expect(JSON.parse(await readFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      'utf8',
    ))).toMatchObject({ dok_id: 'AUTH' });
    await expect(readFile(join(root, '.doklo/hub/doks/USER.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, '.doklo/hub/doks/BILL.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.generationLedger?.entries.map(({ dokId, reasonCode }) => ({
      dokId,
      reasonCode,
    }))).toEqual([
      { dokId: 'AUTH', reasonCode: 'GENERATED' },
      { dokId: 'USER', reasonCode: 'INTERRUPTED' },
      { dokId: 'BILL', reasonCode: 'INTERRUPTED' },
    ]);
  });

  it('threads the current authorized Claude Code reservation into the provider budget', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    let observedOptions: (Parameters<NonNullable<GenerateDeps['generateDokForFeature']>>[2] & {
      maxBudgetUsd?: number;
    }) | undefined;
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_feature, ctx, options) => {
        observedOptions = options;
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };
    const baseOptions = {
      root,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      noLexicon: true,
    };
    const consent = await paidConsent(baseOptions, deps, {
      providerKind: 'claude-code',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'claude-code',
    });

    await runGenerateDirect({ ...baseOptions, ...consent }, deps);

    expect(observedOptions?.providerKind).toBe('claude-code');
    expect(observedOptions?.apiKey).toBeUndefined();
    const reservedTokens = consent.plan.preparedCalls[0]?.reservedTokens;
    expect(reservedTokens).toBeGreaterThan(0);
    expect(observedOptions?.maxBudgetUsd).toBeUndefined();
    const ledger = JSON.parse(await readFile(join(root, '.doklo/cache/llm-token-ledger.json'), 'utf8'));
    expect(ledger.calls[0]).toMatchObject({ state: 'retained', reservedTokens });
  });

  it('--dry-run reports what would be generated without calling the LLM', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);

    const rolesBefore = await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8');
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const lexiconPass = vi.fn(async () => ({ written: false, cacheFile: '', suggestions: [] }));
    const iaPass = vi.fn(() => emptyDerivedRouteHierarchy('web'));
    const mappingPass = vi.fn(async () => ServiceCodeMappingFileSchema.parse({ service_id: 'web', entries: [], version: 1 }));
    const generator = vi.fn(async () => ({
      success: true,
      dok: null,
      prompt: '',
      rawResponse: '',
      usage: null,
    }));
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: generator,
      runRolesRefresh: rolesPass,
      runLexiconSuggest: lexiconPass,
      deriveIA: iaPass,
      deriveCodeMapping: mappingPass,
    };

    const result = await runGenerate({ root, dryRun: true, noLexicon: true }, deps);
    expect(generator).not.toHaveBeenCalled();
    expect(rolesPass).not.toHaveBeenCalled();
    expect(lexiconPass).not.toHaveBeenCalled();
    expect(iaPass).not.toHaveBeenCalled();
    expect(mappingPass).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8')).toBe(rolesBefore);
    await expect(readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(root, '.doklo/hub/services/web/code-mapping.json'), 'utf-8')).rejects.toThrow();
    expect(result.plan).toHaveLength(2);
    expect(result.plan.map((p) => p.dokId).sort()).toEqual(['AUTH', 'USER']);
  });

  it('builds a contained, sensitive-filtered transmission preview without consent', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['src/auth.ts', 'src/auth.test.ts', '.env', 'AuthKey.p8', 'application.properties']);
    await writeConsolidatedWithFiles(
      root,
      'web',
      'AUTH',
      ['src/auth.ts', 'src/auth.test.ts', '.env', 'AuthKey.p8', 'application.properties'],
    );

    const result = await runGenerateDirect({
      root,
      dryRun: true,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    });

    expect(result.transmissions).toEqual([
      {
        phase: 'generate', serviceId: 'web', file: '.doklo/cache/web.consolidated.json',
        maxChars: 12_000, dokId: 'AUTH',
      },
      {
        phase: 'generate',
        serviceId: 'web',
        file: 'src/auth.ts',
        maxChars: 192_000,
        dokId: 'AUTH',
      },
    ]);
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toThrow();
  });

  it('rejects cached source newly excluded by gitignore before preparing generation', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['src/customer-data.ts']);
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['src/customer-data.ts']);
    await writeFile(join(root, '.gitignore'), 'src/customer-data.ts\n');
    await expect(runGenerateDirect({ root, dryRun: true, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true })).rejects.toThrow(/no longer permitted/);
  });

  it('rejects newly ignored source resolved from a legacy route-only cache', async () => {
    const root = await tmpInit();
    const config = makeConsolidatedConfig(['AUTH']);
    const feature = config.groups[0]!.features[0]!;
    delete feature.source_files;
    delete feature.logic_files;
    feature.primary_route = '/';
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(config));
    await writeFile(join(root, '.gitignore'), 'app/page.tsx\n');
    await writeFile(join(root, 'app/page.tsx'), 'SYNTHETIC_PRIVATE_LEGACY_SOURCE');
    await expect(runGenerateDirect({
      root, dryRun: true, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true,
    })).rejects.toThrow(/no longer permitted/);
  });

  it('does not lose the only business rule after 24 source files', async () => {
    const root = await tmpInit();
    const files = Array.from({ length: 25 }, (_, index) => `src/source-${String(index).padStart(2, '0')}.ts`);
    await writeFixtureFiles(root, files);
    await writeFile(join(root, files[24]!), 'export const permission = "published AND no event";');
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', files);
    const result = await runGenerateDirect({ root, dryRun: true, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true });
    expect(result.preparedGeneration!.items[0]!.prompt).toContain('published AND no event');
    expect(result.transmissions.some(source => source.file === files[24])).toBe(true);
  });

  it('includes the fifth source and rules beyond 2000 characters in the authorized prompt', async () => {
    const root = await tmpInit();
    const files = Array.from({ length: 6 }, (_, index) => `src/policy-${index + 1}.ts`);
    await writeFixtureFiles(root, files);
    await writeFile(join(root, files[4]!), '// context\n'.repeat(250) + 'export const visibility = "published AND no event";');
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', files);
    const result = await runGenerateDirect({ root, dryRun: true, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true });
    expect(result.preparedGeneration!.items[0]!.prompt).toContain('published AND no event');
    expect(result.transmissions.some(source => source.file === files[5])).toBe(true);
  });

  it('manifests every source excerpt within the expanded context budget', async () => {
    const root = await tmpInit();
    const files = Array.from({ length: 8 }, (_, index) => `src/source-${index + 1}.ts`);
    await writeFixtureFiles(root, files);
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', files);

    const result = await runGenerateDirect({
      root,
      dryRun: true,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    });

    expect(result.transmissions).toEqual(expect.arrayContaining(files.map((file) => ({
      phase: 'generate',
      serviceId: 'web',
      file,
      maxChars: 192_000,
      dokId: 'AUTH',
    }))));
    expect(result.transmissions).toHaveLength(9);
    expect(result.transmissions.some((source) => source.maxChars === 0)).toBe(false);
  });

  it('never invokes an automatic paid lexicon phase during generate', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    const lexicon = vi.fn(async () => {
      throw new LlmTokenCapError('LLM_RUN_TOKEN_CAP', 'must not run');
    });
    await expect(runGenerate(
      { root, noRoles: true, noIa: true, noCodeMapping: true },
      {
        generateDokForFeature: generator,
        runLexiconSuggest: lexicon,
      },
    )).resolves.toMatchObject({ results: [expect.objectContaining({ dokId: 'AUTH' })] });
    expect(lexicon).not.toHaveBeenCalled();
    expect(generator).toHaveBeenCalledOnce();
  });

  it('rejects direct paid generation before roles, lexicon, provider work, or Hub writes', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const roles = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const lexicon = vi.fn(async () => ({ written: false, cacheFile: '', suggestions: [] }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerateDirect(
      { root },
      { generateDokForFeature: generator, runRolesRefresh: roles, runLexiconSuggest: lexicon },
    )).rejects.toMatchObject({
      exitCode: 2,
      result: {
        diagnostics: [expect.objectContaining({ code: 'LLM_CONSENT_REQUIRED' })],
      },
    });

    expect(roles).not.toHaveBeenCalled();
    expect(lexicon).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toThrow();
  });

  it('rejects a valid receipt whose plan authorizes consolidation rather than generation', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const plan = buildLlmRunPlan({
      llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
      candidateFiles: [],
      workItems: [{ phase: 'consolidate', serviceId: 'web', id: 'web' }],
      calls: { consolidate: 1, lexicon: 0, generateMax: 0, judgeMax: 0 },
      preparedCalls: [{
        phase: 'consolidate',
        workItem: { phase: 'consolidate', serviceId: 'web', id: 'web' },
        prompt: 'unrelated',
        maxOutputTokens: 1,
      }],
      debugDir: join(root, '.doklo/debug'),
    });
    const authorizedRun = await authorizeLlmRun(root, plan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false });
    const preview = await runGenerateDirect({
      root, dryRun: true, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true,
    });
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerateDirect({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      authorizedRun,
      preparedGeneration: preview.preparedGeneration,
    }, { generateDokForFeature: generator })).rejects.toMatchObject({
      exitCode: 2,
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })] },
    });
    expect(generator).not.toHaveBeenCalled();
  });

  it('rechecks prepared source permission after approval even if current cache removes the path', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const options = { root, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true };
    const consent = await paidConsent(options);
    const changed = makeConsolidatedConfig(['AUTH']);
    changed.groups[0]!.features[0]!.source_files = [];
    changed.groups[0]!.features[0]!.logic_files = [];
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(changed));
    await writeFile(join(root, '.gitignore'), 'app/page.tsx\n');
    const generator = vi.fn(stubDeps.generateDokForFeature!);
    await expect(runGenerateDirect({ ...options, ...consent }, {
      generateDokForFeature: generator,
    })).rejects.toThrow(/no longer permitted/);
    expect(generator).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf8')).rejects.toThrow();
  });

  it('forwards only the authorized exact prompt and capped source excerpts to the provider helper', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['src/auth.ts']);
    await writeFile(join(root, 'src/auth.ts'), 'x'.repeat(20_000));
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['src/auth.ts']);
    const options = {
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    };
    const preview = await runGenerateDirect({ ...options, dryRun: true });
    const expectedPromptParts = preview.preparedGeneration!.items[0]!.promptParts;
    expect(preview.preparedGeneration!.items[0]!.prompt)
      .toBe(`${expectedPromptParts.systemPrompt}\n\n${expectedPromptParts.userPrompt}`);
    expect(preview.preparedGeneration!.items[0]!.ctx.fileContext['src/auth.ts']).toHaveLength(20_000);
    const generator = vi.fn(async (_feature, ctx, providerOptions) => ({
      success: true,
      dok: makeDok(ctx.dokId),
      prompt: [
        providerOptions.preparedPrompt.systemPrompt,
        providerOptions.preparedPrompt.userPrompt,
      ].join('\n\n'),
      rawResponse: '',
      usage: null,
    }));

    await runGenerateDirect({
      ...options,
      ...await paidConsent(options),
    }, { generateDokForFeature: generator });

    expect(generator).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ preparedPrompt: expectedPromptParts }),
    );
  });

  it('binds the selected Korean policy to the approved prompt and accounts for its workspace contribution', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const workspacePath = join(root, 'workspace.json');
    const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
    await writeFile(workspacePath, JSON.stringify({ ...workspace, default_locale: 'ko', korean_customer_tone: 'plain' }));
    const options = { root, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true };
    const consent = await paidConsent(options);
    const item = consent.preparedGeneration!.items[0]!;
    expect(item.ctx.koreanCustomerTone).toBe('plain');
    expect(item.promptParts.systemPrompt).toContain('Korean customer tone: plain');
    expect(item.transmissions).toContainEqual(expect.objectContaining({ file: 'workspace.json', actualChars: expect.any(Number) }));
    expect(item.transmissions.find(source => source.file === 'workspace.json')!.actualChars).toBeGreaterThan(0);
    expect(consent.plan!.transmissions).toContainEqual(expect.objectContaining({ file: 'workspace.json' }));

    // Editing configuration does not silently replace the already-authorized prompt.
    await writeFile(workspacePath, JSON.stringify({ ...workspace, default_locale: 'ko', korean_customer_tone: 'formal' }));
    const provider = vi.fn(async (_feature, context, providerOptions) => {
      expect(context.koreanCustomerTone).toBe('plain');
      expect(providerOptions.preparedPrompt).toEqual(item.promptParts);
      return { success: true, dok: makeDok(context.dokId), prompt: item.prompt, rawResponse: '', usage: null };
    });
    await runGenerateDirect({ ...options, ...consent }, { generateDokForFeature: provider });
    expect(provider).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf8'))._meta.writing_policy).toEqual({ locale: 'ko', tone: 'plain' });
  });

  it('manifests the exact rendered consolidated feature and existing roles contributions', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(join(root, '.doklo/hub/roles.json'), JSON.stringify({
      roles: [{ role_id: 'ROLE-ADMIN', name: 'Admin', extends: [], scope: 'global' }],
      version: 1,
    }));

    const preview = await runGenerateDirect({
      root, dryRun: true, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true,
    });
    const item = preview.preparedGeneration!.items[0]!;
    const renderedFeature = JSON.stringify({
      canonical_id: item.feature.canonical_id,
      label: item.feature.label,
      primary_route: item.feature.primary_route,
      members: item.feature.members,
      files: item.feature.files.slice(0, 8),
    }, null, 2);
    const renderedRoles = item.ctx.knownRoles.map((role) => `  - ${role}`).join('\n');

    expect(preview.transmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: '.doklo/cache/web.consolidated.json', maxChars: 12_000, dokId: 'AUTH',
      }),
      expect.objectContaining({
        file: '.doklo/hub/roles.json', maxChars: 12_000, dokId: 'AUTH',
      }),
    ]));
    expect(item.transmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: '.doklo/cache/web.consolidated.json', actualChars: renderedFeature.length,
      }),
      expect.objectContaining({
        file: '.doklo/hub/roles.json', actualChars: renderedRoles.length,
      }),
    ]));
  });

  it('attributes prospective role fragments to safe role-signal files and filters secrets', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFixtureFiles(root, ['src/roles.ts']);
    await writeFile(join(root, '.env'), 'ROLE_SECRET=canary');
    await writeScanIr(root, 'web', {
      role_signals: [
        {
          value: 'mentor', kind: 'actor_type', source: 'explicit',
          file: 'src/roles.ts', line: 1, detector: 'test-safe-role',
        },
        {
          value: 'secret-operator', kind: 'actor_type', source: 'explicit',
          file: '.env', line: 1, detector: 'test-secret-role',
        },
      ],
    });

    const preview = await runGenerateDirect({
      root, dryRun: true, noLexicon: true, noIa: true, noCodeMapping: true,
    });
    const item = preview.preparedGeneration!.items[0]!;
    const roleSource = item.transmissions.find((source) => source.file === 'src/roles.ts');

    expect(item.ctx.knownRoles).toContain('ROLE-MENTOR');
    expect(item.ctx.knownRoles).not.toContain('ROLE-SECRET-OPERATOR');
    expect(roleSource?.actualChars).toBe('  - ROLE-MENTOR'.length);
    expect(roleSource?.actualChars).toBeLessThanOrEqual(12_000);
    expect(item.transmissions.some((source) => source.file === '.env')).toBe(false);
    expect(item.prompt).not.toContain('ROLE-SECRET-OPERATOR');
  });

  it('preserves a cross-service role source origin and full workspace path for the target Dok call', async () => {
    const root = await tmpInit();
    await writeFile(join(root, 'workspace.json'), JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [
        { service_id: 'service-a', type: 'frontend', framework: 'nextjs', code_root: 'apps/a' },
        { service_id: 'service-b', type: 'frontend', framework: 'nextjs', code_root: 'apps/b' },
      ],
      default_locale: 'en',
      supported_locales: ['en'],
    }));
    await writeSupportedNextProject(join(root, 'apps/a'));
    await writeSupportedNextProject(join(root, 'apps/b'));
    await writeFixtureFiles(root, ['apps/a/src/roles.ts']);
    await writeScanIr(root, 'service-a', {
      role_signals: [{
        value: 'mentor', kind: 'actor_type', source: 'explicit',
        file: 'src/roles.ts', line: 1, detector: 'service-a-role',
      }],
    });
    await writeScanIr(root, 'service-b');
    await writeConsolidated(root, 'service-a', []);
    await writeConsolidated(root, 'service-b', ['BETA']);
    const options = {
      root, noLexicon: true, noIa: true, noCodeMapping: true,
    };

    const preview = await runGenerateDirect({ ...options, dryRun: true });
    const item = preview.preparedGeneration!.items.find((entry) => entry.serviceId === 'service-b')!;
    const roleSource = item.transmissions.find((source) => source.file.endsWith('roles.ts'));
    const plannedSource = preview.transmissions.find((source) => source.file.endsWith('roles.ts'));

    expect(roleSource).toMatchObject({
      serviceId: 'service-b',
      originServiceId: 'service-a',
      codeRoot: 'apps/a',
      file: 'apps/a/src/roles.ts',
    });
    expect(roleSource!.actualChars).toBeGreaterThan(0);
    expect(plannedSource).toMatchObject({
      serviceId: 'service-b',
      originServiceId: 'service-a',
      codeRoot: 'apps/a',
      file: 'apps/a/src/roles.ts',
      dokId: 'BETA',
    });
    expect(item.transmissions.some((source) => source.file === 'apps/b/src/roles.ts')).toBe(false);
    expect(item.transmissions.some((source) => source.file === 'src/roles.ts')).toBe(false);

    const consent = await paidConsent(options);
    expect((consent as { plan: { transmissions: unknown[] } }).plan.transmissions).toEqual(
      expect.arrayContaining([expect.objectContaining({
        serviceId: 'service-b',
        originServiceId: 'service-a',
        codeRoot: 'apps/a',
        file: 'apps/a/src/roles.ts',
        workItemId: 'BETA',
      })]),
    );
    await expect(runGenerateDirect(
      { ...options, ...consent },
      {
        generateDokForFeature: vi.fn(stubDeps.generateDokForFeature!),
        runRolesRefresh: vi.fn(async () => ({
          candidates: [], added: [], kept: [], skipped: [], written: false,
        })),
      },
    )).resolves.toMatchObject({ results: [expect.objectContaining({ serviceId: 'service-b' })] });
  });

  it('omits prospective role sources pruned by the rendered role cap', async () => {
    const root = await tmpInit();
    const cappedRole = `ROLE-${'X'.repeat(9_488)}`;
    await writeFile(join(root, '.doklo/hub/roles.json'), JSON.stringify({
      roles: [{ role_id: cappedRole, name: 'Existing', extends: [], scope: 'global' }],
      version: 1,
    }));
    await writeFixtureFiles(root, ['src/roles.ts']);
    await writeScanIr(root, 'web', {
      role_signals: [{
        value: 'mentor', kind: 'actor_type', source: 'explicit',
        file: 'src/roles.ts', line: 1, detector: 'pruned-role',
      }],
    });
    await writeConsolidated(root, 'web', ['AUTH']);

    const preview = await runGenerateDirect({
      root, dryRun: true, noLexicon: true, noIa: true, noCodeMapping: true,
    });
    const item = preview.preparedGeneration!.items[0]!;

    expect(item.ctx.knownRoles).toEqual([cappedRole]);
    expect(item.transmissions.some((source) => source.file.endsWith('src/roles.ts'))).toBe(false);
    expect(preview.transmissions.some((source) => source.file.endsWith('src/roles.ts'))).toBe(false);
    expect(item.transmissions.every((source) => source.actualChars > 0)).toBe(true);
  });

  it('omits absent lexicon and suggestion-cache files from exact source coverage', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);

    const preview = await runGenerateDirect({
      root, dryRun: true, noRoles: true, noIa: true, noCodeMapping: true,
    });
    const files = preview.transmissions.map((source) => source.file);
    const item = preview.preparedGeneration!.items[0]!;

    expect(files).not.toContain('.doklo/hub/lexicon.json');
    expect(files).not.toContain('.doklo/cache/lexicon-suggestions.json');
    expect(item.transmissions.every((source) => source.actualChars > 0)).toBe(true);
  });

  it('rejects a missing role-signal source before preparing a paid prompt', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeScanIr(root, 'web', {
      role_signals: [{
        value: 'mentor', kind: 'actor_type', source: 'explicit',
        file: 'src/missing-role-source.ts', line: 1, detector: 'test-missing-role',
      }],
    });

    await expect(runGenerateDirect({
      root, dryRun: true, noLexicon: true, noIa: true, noCodeMapping: true,
    })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('filters a sensitive service consolidated cache before reading its canary', async () => {
    const root = await tmpInit();
    await writeFile(join(root, 'workspace.json'), JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [{ service_id: 'secrets', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'en',
      supported_locales: ['en'],
    }));
    await writeScanIr(root, 'secrets');
    const config = makeConsolidatedConfig(['SECRET']);
    config.groups[0]!.features[0]!.label = 'SENSITIVE_CONSOLIDATED_CANARY';
    await writeFile(
      join(root, '.doklo/cache/secrets.consolidated.json'),
      JSON.stringify(config),
    );

    await expect(runGenerateDirect({
      root,
      serviceId: 'secrets',
      dryRun: true,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    })).rejects.toBeInstanceOf(ConsolidatedCacheMissingError);
  });

  it('checks the run cap immediately before each Dok provider call', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    for (let index = 0; index < 5; index++) {
      const prior = await registerLlmRun(root, {
        receiptId: `prior-${index}`, planDigest: `prior-plan-${index}`, maxCalls: 1,
      });
      await reserveRegisteredLlmCall(prior, {
        callKey: `prior/${index}`,
        reservedTokens: 999_999,
      });
    }
    const auth = await paidConsent({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    });
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerateDirect({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
      ...auth,
    }, { generateDokForFeature: generator })).resolves.toMatchObject({
      tokenCapFailure: { code: 'LLM_TOTAL_TOKEN_CAP' },
    });
    expect(generator).not.toHaveBeenCalled();
  });

  it('rejects stale missing source paths on a Pages-only dry run', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await rm(join(root, 'app'), { recursive: true });
    await mkdir(join(root, 'pages'), { recursive: true });
    await writeFile(
      join(root, 'pages/index.tsx'),
      'export default function Page(){ return null }',
      'utf-8',
    );
    const trackedFiles = [
      join(root, '.doklo/cache/web.scan.json'),
      join(root, '.doklo/cache/web.consolidated.json'),
      join(root, '.doklo/hub/roles.json'),
    ];
    const before = await Promise.all(trackedFiles.map((path) => readFile(path, 'utf-8')));

    await expect(runGenerate({
      root,
      dryRun: true,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    })).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(Promise.all(
      trackedFiles.map((path) => readFile(path, 'utf-8')),
    )).resolves.toEqual(before);
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual([]);
  });

  it('reads the role registry from .doklo/hub/roles.json and forwards as knownRoles', async () => {
    const root = await tmpInit();
    await writeFile(
      join(root, '.doklo/hub/roles.json'),
      JSON.stringify({
        roles: [
          { role_id: 'ROLE-USER', name: 'User', extends: [], scope: 'global' },
          { role_id: 'ROLE-ADMIN', name: 'Admin', extends: ['ROLE-USER'], scope: 'global' },
        ],
        version: 1,
      }),
      'utf-8',
    );
    await writeConsolidated(root, 'web', ['AUTH']);

    let seenRoles: string[] | null = null;
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        seenRoles = [...ctx.knownRoles];
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    await runGenerate({ root, noLexicon: true }, deps);
    expect(seenRoles).toEqual(['ROLE-USER', 'ROLE-ADMIN']);
  });

  it('emits onProgress events in order: plan, dok-start/dok-done×N, done', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);

    const events: GenerateProgressEvent[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
    };

    await runGenerate(
      { root, noLexicon: true, onProgress: (e) => events.push(e) },
      deps,
    );

    const stages = events.map((e) => e.stage);
    expect(stages).toEqual([
      'roles',
      'lexicon',
      'plan',
      'dok-start',
      'dok-done',
      'dok-start',
      'dok-done',
      'ia',
      'code-mapping',
      'done',
    ]);

    // First generation event must announce a plan with total=2.
    const planEvent = events.find((e) => e.stage === 'plan') as { stage: 'plan'; total: number };
    expect(planEvent.total).toBe(2);

    // Each Dok generates a paired (dok-start, dok-done).
    const startEvents = events.filter((e) => e.stage === 'dok-start');
    const doneEvents = events.filter((e) => e.stage === 'dok-done');
    expect(startEvents).toHaveLength(2);
    expect(doneEvents).toHaveLength(2);

    // dok-start carries running index/total/dokId/featureLabel.
    const first = startEvents[0] as Extract<GenerateProgressEvent, { stage: 'dok-start' }>;
    expect(first.index).toBe(1);
    expect(first.total).toBe(2);
    expect(first.dokId).toMatch(/^(AUTH|USER)$/);
    expect(first.featureLabel).toMatch(/Feature \d+/);

    // dok-done carries success + elapsedMs (≥0).
    const firstDone = doneEvents[0] as Extract<GenerateProgressEvent, { stage: 'dok-done' }>;
    expect(firstDone.success).toBe(true);
    expect(firstDone.elapsedMs).toBeGreaterThanOrEqual(0);

    // Final 'done' totals match.
    const done = events[events.length - 1] as Extract<GenerateProgressEvent, { stage: 'done' }>;
    expect(done.succeeded).toBe(2);
    expect(done.failed).toBe(0);
    expect(done.layerFailed).toBe(0);
  });

  it('reports failure events with the LLM error reason', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);

    const events: GenerateProgressEvent[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async () => ({
        success: false,
        dok: null,
        prompt: '',
        rawResponse: '',
        usage: null,
        error: 'mocked LLM JSON parse failure',
      }),
    };

    await runGenerate(
      { root, noLexicon: true, onProgress: (e) => events.push(e) },
      deps,
    );

    const failed = events.find(
      (e) => e.stage === 'dok-done' && e.success === false,
    ) as Extract<GenerateProgressEvent, { stage: 'dok-done' }> | undefined;
    expect(failed).toBeDefined();
    expect(failed?.error).toBe('mocked LLM JSON parse failure');

    const done = events[events.length - 1] as Extract<GenerateProgressEvent, { stage: 'done' }>;
    expect(done.succeeded).toBe(0);
    expect(done.failed).toBe(1);
    expect(done.layerFailed).toBe(0);
  });

  it('does NOT emit any onProgress events in dry-run mode', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);

    const events: GenerateProgressEvent[] = [];
    await runGenerate({
      root,
      dryRun: true,
      noLexicon: true,
      onProgress: (e) => events.push(e),
    });
    expect(events).toEqual([]);
  });

  it('skips Doks whose target file already exists (idempotent re-run)', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    // Pre-create one Dok file as if a previous run had succeeded for it.
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );

    const calls: string[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        calls.push(ctx.dokId);
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    const result = await runGenerate({ root, noLexicon: true }, deps);
    expect(calls).toEqual(['USER']); // only the missing one was generated
    expect(result.skippedExisting).toEqual(['AUTH']);
    expect(result.results.map((r) => r.dokId)).toEqual(['USER']);
  });

  it('regenerates everything when force=true (overwrites existing files)', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH', 'Original')),
      'utf-8',
    );

    const calls: string[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        calls.push(ctx.dokId);
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId, 'Regenerated'))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    const result = await runGenerate({ root, force: true, noLexicon: true }, deps);
    expect(calls.sort()).toEqual(['AUTH', 'USER']); // both regenerated
    expect(result.skippedExisting).toEqual([]);
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written.name).toBe('Regenerated');
  });

  it('carries the existing _meta identity forward when force overwrites a Dok', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const existing = makeDok('AUTH', 'Original') as Record<string, unknown>;
    existing['_meta'] = {
      version: 3,
      history: [{ version: 2, date: '2026-01-02', change: 'reviewed by hand' }],
      external_ids: { notion: 'page-42' },
      created_at: '2026-01-01T00:00:00.000Z',
      previous_ids: ['AUTH-LOGIN'],
      edited_by_human: true,
      source_anchors: [{ file: 'app/page.tsx' }],
    };
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(existing),
      'utf-8',
    );

    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId, 'Regenerated'))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
    };

    await runGenerate({ root, force: true, noLexicon: true }, deps);

    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written.name).toBe('Regenerated');
    // Identity/audit half survives the regeneration…
    expect(written._meta.version).toBe(4);
    expect(written._meta.history).toEqual([
      { version: 2, date: '2026-01-02', change: 'reviewed by hand' },
    ]);
    expect(written._meta.external_ids).toEqual({ notion: 'page-42' });
    expect(written._meta.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(written._meta.previous_ids).toEqual(['AUTH-LOGIN']);
    // …the human-edit marker does not: the prose it protected is gone.
    expect(written._meta.edited_by_human).toBeUndefined();
    // …and this run's provenance is stamped so the next consolidation can
    // recognize the same feature and reuse this id.
    expect(written._meta.origins).toEqual([
      { service_id: 'web', canonical_feature_id: 'feat-0', primary_route: '/x0' },
    ]);
    expect(written._meta.anchor_service_id).toBe('web');
  });

  it('stamps origins on a first generation and starts at version 1', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);

    await runGenerate({ root, noLexicon: true }, stubDeps);

    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written._meta.version).toBe(1);
    expect(written._meta.origins).toEqual([
      { service_id: 'web', canonical_feature_id: 'feat-0', primary_route: '/x0' },
    ]);
  });

  it('reports hub Doks no consolidated feature produces any more as orphans', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    // A Dok left behind by an earlier consolidation whose feature is gone.
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH-LEGACY.json'),
      JSON.stringify(makeDok('AUTH-LEGACY')),
      'utf-8',
    );

    const result = await runGenerate({ root, noLexicon: true }, stubDeps);

    expect(result.orphanedDokIds).toEqual(['AUTH-LEGACY']);
    // Reported, never deleted — the file may hold reviewed prose.
    expect((await readdir(join(root, '.doklo/hub/doks'))).sort())
      .toEqual(['AUTH-LEGACY.json', 'AUTH.json']);
  });

  it('does not accuse other services Doks of being orphans on a --service run', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(
      join(root, '.doklo/hub/doks/ADMIN-USERS.json'),
      JSON.stringify(makeDok('ADMIN-USERS')),
      'utf-8',
    );

    const result = await runGenerate(
      { root, serviceId: 'web', noLexicon: true },
      stubDeps,
    );

    expect(result.orphanedDokIds).toEqual([]);
  });

  it('onlyDokIds restricts generation to the listed dok_ids', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);

    const calls: string[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        calls.push(ctx.dokId);
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    // force:true so the skip-existing pass is a no-op; onlyDokIds then narrows
    // the work list to AUTH alone.
    const result = await runGenerate({ root, force: true, onlyDokIds: ['AUTH'], noLexicon: true }, deps);
    expect(calls).toEqual(['AUTH']); // USER never generated
    expect(result.results.map((r) => r.dokId)).toEqual(['AUTH']);
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual(['AUTH.json']);
  });

  it('emits skippedExisting in the plan event payload', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );

    const events: GenerateProgressEvent[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
    };

    await runGenerate(
      { root, noLexicon: true, onProgress: (e) => events.push(e) },
      deps,
    );

    const planEvent = events.find((e) => e.stage === 'plan') as Extract<
      GenerateProgressEvent,
      { stage: 'plan' }
    >;
    expect(planEvent.total).toBe(1); // only USER is going to run
    expect(planEvent.skippedExisting).toEqual(['AUTH']);
  });

  it('injects deterministic _meta.source_anchors from the feature source files', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, [
      'app/auth/signin/page.tsx',
      'components/SigninForm.tsx',
      'hooks/useAuth.ts',
    ]);
    // Consolidated cache carrying member-derived source files (the union the
    // consolidator now attaches). Generate must transport these into the Dok.
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify({
        projectName: 'demo',
        basedOnFeaturesAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        model: 'claude-haiku-4-5',
        originalFeatureIds: ['auth-signin'],
        userReviewed: false,
        stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
        groups: [
          {
            group_id: 'auth',
            label: 'auth',
            excluded: [],
            features: [
              {
                canonical_id: 'auth-signin',
                label: 'Sign in',
                dok_id_prefix: 'AUTH',
                decision: 'keep',
                members: ['auth-signin'],
                primary_route: '/auth/signin',
                reason: '',
                user_reviewed: false,
                source_files: [
                  'app/auth/signin/page.tsx',
                  'components/SigninForm.tsx',
                  'hooks/useAuth.ts',
                ],
              },
            ],
          },
        ],
      }),
      'utf-8',
    );

    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
    };

    await runGenerate({ root, noLexicon: true }, deps);
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written._meta.source_anchors).toEqual([
      { file: 'app/auth/signin/page.tsx' },
      { file: 'components/SigninForm.tsx' },
      { file: 'hooks/useAuth.ts' },
    ]);
  });

  it('stamps _meta.anchor_service_id with the generating service (deterministic drift base)', async () => {
    // B2: drift path resolution must key off the service generate KNOWS the
    // anchors came from, not the LLM-authored `surfaces`. tmpInit's sole service
    // is 'web', so that id must be stamped onto the Dok deterministically.
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);

    await runGenerate({ root, noLexicon: true }, stubDeps);
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written._meta.anchor_service_id).toBe('web');
  });

  it('passes the full source file set (not just the entry page) to the LLM as context candidates', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, [
      'app/auth/signin/page.tsx',
      'components/SigninForm.tsx',
    ]);
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify({
        projectName: 'demo',
        basedOnFeaturesAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        model: 'claude-haiku-4-5',
        originalFeatureIds: ['auth-signin'],
        userReviewed: false,
        stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
        groups: [
          {
            group_id: 'auth',
            label: 'auth',
            excluded: [],
            features: [
              {
                canonical_id: 'auth-signin',
                label: 'Sign in',
                dok_id_prefix: 'AUTH',
                decision: 'keep',
                members: ['auth-signin'],
                primary_route: '/auth/signin',
                reason: '',
                user_reviewed: false,
                source_files: ['app/auth/signin/page.tsx', 'components/SigninForm.tsx'],
              },
            ],
          },
        ],
      }),
      'utf-8',
    );

    let seenFiles: string[] = [];
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (feature, ctx) => {
        seenFiles = [...feature.files];
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    await runGenerate({ root, noLexicon: true }, deps);
    expect(seenFiles).toEqual(['app/auth/signin/page.tsx', 'components/SigninForm.tsx']);
  });

  it('preserves existing _meta (version/history) when injecting source_anchors', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['app/auth/signin/page.tsx']);
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify({
        projectName: 'demo',
        basedOnFeaturesAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        model: 'claude-haiku-4-5',
        originalFeatureIds: ['auth-signin'],
        userReviewed: false,
        stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
        groups: [
          {
            group_id: 'auth',
            label: 'auth',
            excluded: [],
            features: [
              {
                canonical_id: 'auth-signin',
                label: 'Sign in',
                dok_id_prefix: 'AUTH',
                decision: 'keep',
                members: ['auth-signin'],
                primary_route: '/auth/signin',
                reason: '',
                user_reviewed: false,
                source_files: ['app/auth/signin/page.tsx'],
              },
            ],
          },
        ],
      }),
      'utf-8',
    );

    // Faithfully mirror production: the real generateDokForFeature returns a
    // schema-parsed Dok whose _meta carries version + history. Injection must
    // merge source_anchors WITHOUT clobbering those.
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        const dok = makeDok(ctx.dokId) as Record<string, unknown>;
        dok._meta = { version: 3, history: [{ version: 1, date: '2026-01-01', change: 'init' }] };
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(dok)) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    await runGenerate({ root, noLexicon: true }, deps);
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written._meta.version).toBe(3);
    expect(written._meta.history).toEqual([{ version: 1, date: '2026-01-01', change: 'init' }]);
    expect(written._meta.source_anchors).toEqual([{ file: 'app/auth/signin/page.tsx' }]);
  });

  it('reports dok_ids that resolved to no source files (empty-anchor rate)', async () => {
    const root = await tmpInit();
    // Legacy cache: no source_files. No scan cache either → IR fallback yields
    // nothing → the Dok gets source_anchors: [] and must be surfaced, not hidden.
    const config = makeConsolidatedConfig(['AUTH']);
    config.groups[0]!.features[0]!.source_files = [];
    config.groups[0]!.features[0]!.logic_files = [];
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(config));
    await writeScanIr(root, 'web', { files: [], routes: [] });

    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
    };

    const result = await runGenerate({ root, noLexicon: true }, deps);
    expect(result.emptyAnchorDokIds).toEqual([]);
    expect(result.failures[0]?.reason ?? '').toContain('ZERO_SOURCE_ANCHORS');
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back to the IR primary-route page file for caches without source_files', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['app/x0/page.tsx']);
    const config = makeConsolidatedConfig(['AUTH']); // legacy cache: no source_files
    delete config.groups[0]!.features[0]!.source_files;
    delete config.groups[0]!.features[0]!.logic_files;
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(config));
    await writeFile(
      join(root, '.doklo/cache/web.scan.json'),
      JSON.stringify({
        framework: 'nextjs',
        root,
        files: ['app/x0/page.tsx'],
        routes: [
          { path: '/x0', kind: 'page', file: 'app/x0/page.tsx', dynamic_params: [], layout_chain: [] },
        ],
        components: [],
        stores: [],
      }),
      'utf-8',
    );

    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => ({
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      }),
    };

    await runGenerate({ root, noLexicon: true }, deps);
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    // writeConsolidated assigns primary_route `/x0` to the first feature.
    expect(written._meta.source_anchors).toEqual([{ file: 'app/x0/page.tsx' }]);
  });

  it('preserves an explicitly empty source_files list without legacy IR fallback', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['app/x0/page.tsx']);
    const config = makeConsolidatedConfig(['AUTH']);
    config.groups[0]!.features[0]!.source_files = [];
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify(config),
      'utf-8',
    );
    await writeScanIr(root, 'web', {
      files: ['app/x0/page.tsx'],
      routes: [
        { path: '/x0', kind: 'page', file: 'app/x0/page.tsx', dynamic_params: [], layout_chain: [] },
      ],
    });

    const result = await runGenerate({ root, noLexicon: true }, stubDeps);
    expect(result.emptyAnchorDokIds).toEqual([]);
    expect(result.failures[0]?.reason ?? '').toContain('ZERO_SOURCE_ANCHORS');
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads file context (file content) from disk for each feature', async () => {
    const root = await tmpInit();
    const config = makeConsolidatedConfig(['AUTH']);
    delete config.groups[0]!.features[0]!.source_files;
    delete config.groups[0]!.features[0]!.logic_files;
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(config));
    // Generate locates files via the IR's page routes — write a matching
    // scan cache so the lookup succeeds.
    await writeFile(
      join(root, '.doklo/cache/web.scan.json'),
      JSON.stringify({
        framework: 'nextjs',
        root,
        files: ['app/x0/page.tsx'],
        routes: [
          {
            path: '/x0',
            kind: 'page',
            file: 'app/x0/page.tsx',
            dynamic_params: [],
            layout_chain: [],
          },
        ],
        components: [],
        stores: [],
      }),
      'utf-8',
    );
    await mkdir(join(root, 'app/x0'), { recursive: true });
    await writeFile(join(root, 'app/x0/page.tsx'), 'export default function X(){}', 'utf-8');

    let seenFiles: Record<string, string> = {};
    const deps: Partial<GenerateDeps> = {
      generateDokForFeature: async (_f, ctx) => {
        seenFiles = ctx.fileContext;
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      },
    };

    await runGenerate({ root, noLexicon: true }, deps);
    expect(seenFiles['app/x0/page.tsx'] ?? '').toContain('export default function X');
  });

  it('records _meta.logic_hash as the hash of the anchored source files', async () => {
    const root = await tmpInit();
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['app/auth/page.tsx']);
    await mkdir(join(root, 'app/auth'), { recursive: true });
    await writeFile(join(root, 'app/auth/page.tsx'), 'export default function P(){}', 'utf-8');

    await runGenerate({ root, noLexicon: true }, stubDeps);

    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );
    expect(written._meta.logic_hash).toBe(
      computeLogicHash([
        { file: 'app/auth/page.tsx', content: 'export default function P(){}' },
      ]),
    );
  });

  it('omits _meta.logic_hash when the Dok has no source anchors', async () => {
    const root = await tmpInit();
    // Legacy cache, no source_files, no scan → empty anchors → nothing to hash.
    const config = makeConsolidatedConfig(['AUTH']);
    config.groups[0]!.features[0]!.source_files = [];
    config.groups[0]!.features[0]!.logic_files = [];
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(config));
    await writeScanIr(root, 'web', { files: [], routes: [] });

    const result = await runGenerate({ root, noLexicon: true }, stubDeps);
    expect(result.failures[0]?.reason ?? '').toContain('ZERO_SOURCE_ANCHORS');
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an explicitly empty logic_files list without display-file fallback', async () => {
    const root = await tmpInit();
    const config = makeConsolidatedConfig(['AUTH']);
    config.groups[0]!.features[0]!.source_files = ['app/auth/page.tsx'];
    config.groups[0]!.features[0]!.logic_files = [];
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify(config),
      'utf-8',
    );
    await mkdir(join(root, 'app/auth'), { recursive: true });
    await writeFile(join(root, 'app/auth/page.tsx'), 'export default function P(){}', 'utf-8');

    await runGenerate({ root, noLexicon: true }, stubDeps);
    const written = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    );

    expect(written._meta.source_anchors).toEqual([{ file: 'app/auth/page.tsx' }]);
    expect(written._meta.logic_hash).toBeUndefined();
    expect(written._meta.logic_files).toBeUndefined();
  });

  it('changes _meta.logic_hash when an anchored file changes (the drift signal)', async () => {
    const root = await tmpInit();
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['app/auth/page.tsx']);
    await mkdir(join(root, 'app/auth'), { recursive: true });
    await writeFile(join(root, 'app/auth/page.tsx'), 'const v = 1;', 'utf-8');
    await runGenerate({ root, noLexicon: true }, stubDeps);
    const before = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    )._meta.logic_hash;

    // The code changes on disk; regenerating the same Dok must move the hash.
    await writeFile(join(root, 'app/auth/page.tsx'), 'const v = 2; // changed', 'utf-8');
    await runGenerate({ root, force: true, noLexicon: true }, stubDeps);
    const after = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
    )._meta.logic_hash;

    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it('dry-run plan carries the domain (consolidated group label)', async () => {
    const root = await tmpInit();
    // writeConsolidated puts every feature in one group labelled 'auth'.
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);

    const result = await runGenerate({ root, dryRun: true, noLexicon: true }, stubDeps);
    expect(result.plan).toHaveLength(2);
    expect(result.plan.every((p) => p.domain === 'auth')).toBe(true);
  });
});

describe('observed generate fault recovery contracts', () => {
  it('binds Dok output identity to the preflight-captured parent directory', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const originalDoksDir = join(root, '.doklo/hub/doks');
    const preservedDoksDir = join(root, '.doklo/hub/doks.original');
    const outside = await mkdtemp(join(tmpdir(), 'doklo-gen-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(join(originalDoksDir, 'preserved.txt'), 'original bytes\n');
    await writeFile(sentinel, 'outside sentinel\n');
    const sentinelHash = createHash('sha256').update(await readFile(sentinel)).digest('hex');
    const originalEntries = await readdir(originalDoksDir);
    let replaced = false;

    const invocation = runGenerate({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    }, {
      ...stubDeps,
      async writeFileAtomicContained(...args) {
        if (!replaced && args[1] === '.doklo/hub/doks/AUTH.json') {
          replaced = true;
          await rename(originalDoksDir, preservedDoksDir);
          await symlink(outside, originalDoksDir, 'dir');
        }
        await writeFileAtomicContained(...args);
      },
    });

    await expect(invocation).rejects.toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(replaced).toBe(true);
    expect(createHash('sha256').update(await readFile(sentinel)).digest('hex')).toBe(sentinelHash);
    await expect(readFile(join(outside, 'AUTH.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(outside, 'generation-ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(preservedDoksDir)).toEqual(originalEntries);
    expect(await readFile(join(preservedDoksDir, 'preserved.txt'), 'utf8')).toBe('original bytes\n');
  });

  it('binds the generation ledger identity to its captured cache directory', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const cacheDir = join(root, '.doklo/cache');
    const preservedCacheDir = join(root, '.doklo/cache.original');
    const outside = await mkdtemp(join(tmpdir(), 'doklo-ledger-outside-'));
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'outside sentinel\n');
    const sentinelHash = createHash('sha256').update(await readFile(sentinel)).digest('hex');
    let originalEntries: string[] = [];
    let replaced = false;

    const invocation = runGenerate({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    }, {
      ...stubDeps,
      async writeFileAtomicContained(...args) {
        if (!replaced && args[1] === '.doklo/cache/generation-ledger.json') {
          replaced = true;
          originalEntries = await readdir(cacheDir);
          await rename(cacheDir, preservedCacheDir);
          await symlink(outside, cacheDir, 'dir');
        }
        await writeFileAtomicContained(...args);
      },
    });

    await expect(invocation).rejects.toMatchObject({
      code: 'PATH_IDENTITY_CHANGED',
      retryable: true,
    });
    expect(replaced).toBe(true);
    expect(createHash('sha256').update(await readFile(sentinel)).digest('hex')).toBe(sentinelHash);
    await expect(readFile(join(outside, 'generation-ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(preservedCacheDir)).toEqual(originalEntries);
    await expect(readFile(join(preservedCacheDir, 'generation-ledger.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists the normal generation ledger through the contained writer seam', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const writes: string[] = [];

    const result = await runGenerate({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    }, {
      ...stubDeps,
      async writeFileAtomicContained(...args) {
        writes.push(args[1]);
        await writeFileAtomicContained(...args);
      },
    });

    expect(writes).toContain('.doklo/cache/generation-ledger.json');
    expect(result.generationLedger?.entries).toEqual([
      expect.objectContaining({ dokId: 'AUTH', status: 'success', reasonCode: 'GENERATED' }),
    ]);
  });

  it('persists the partial-failure ledger through the contained writer seam', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const writes: string[] = [];

    const result = await runGenerate({
      root,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    }, {
      generateDokForFeature: async () => ({
        success: false,
        dok: null,
        prompt: '',
        rawResponse: null,
        usage: null,
        failureKind: 'nonzero_exit',
        error: 'provider failed',
      }),
      async writeFileAtomicContained(...args) {
        writes.push(args[1]);
        await writeFileAtomicContained(...args);
      },
    });

    expect(writes).toEqual(['.doklo/cache/generation-ledger.json']);
    expect(result.generationLedger?.entries).toEqual([
      expect.objectContaining({ dokId: 'AUTH', status: 'failed', reasonCode: 'GENERATION_FAILED' }),
    ]);
  });

  it('persists the preflight-failure ledger through the contained writer seam', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(join(root, '.doklo/hub/roles.json'), '{ malformed roles', 'utf8');
    const writes: string[] = [];

    let thrown: unknown;
    try {
      await runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: {
            async writeFileAtomicContained(...args) {
              writes.push(args[1]);
              await writeFileAtomicContained(...args);
            },
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(toCommandContractError(thrown, 'generate').result).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'MALFORMED_HUB_FILE', file: '.doklo/hub/roles.json' }],
    });
    expect(writes).toEqual(['.doklo/cache/generation-ledger.json']);
    const ledger = JSON.parse(await readFile(
      join(root, '.doklo/cache/generation-ledger.json'),
      'utf8',
    )) as { entries: Array<{ dokId: string; status: string; reasonCode: string }> };
    expect(ledger.entries).toEqual([
      expect.objectContaining({ dokId: 'AUTH', status: 'failed', reasonCode: 'GENERATION_FAILED' }),
    ]);
  });

  it('publishes a retryable, file-scoped rate-limit diagnostic and failed ledger', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    const existingPath = join(root, '.doklo/hub/doks/AUTH.json');
    await writeFile(existingPath, JSON.stringify(makeDok('AUTH')), 'utf8');
    const existingBefore = await readFile(existingPath);
    const generator = vi.fn(async () => ({
      success: false as const,
      dok: null,
      prompt: '',
      rawResponse: null,
      usage: null,
      failureKind: 'rate_limit' as const,
      error: 'Claude Code provider rate limited the request.',
    }));

    const outcome = await runGenerateThroughCommander(
      root,
      ['--no-roles', '--no-ia', '--no-code-mapping'],
      {
        runGenerateDeps: { generateDokForFeature: generator },
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'claude-code',
          authSource: 'claude-code',
        }),
      },
    );

    expect(outcome.result).toMatchObject({
      command: 'generate',
      status: 'partial',
      diagnostics: [{
        code: 'PROVIDER_RATE_LIMITED',
        serviceId: 'web',
        file: '.doklo/hub/doks/USER.json',
        retryable: true,
        preserved: ['.doklo/hub/doks/AUTH.json'],
        nextCommand: 'doklo generate --only USER --yes',
      }],
    });
    expect(generator).toHaveBeenCalledOnce();
    expect(await readFile(existingPath)).toEqual(existingBefore);
    const ledger = JSON.parse(await readFile(
      join(root, '.doklo/cache/generation-ledger.json'),
      'utf8',
    )) as { entries: Array<{ dokId: string; status: string; reasonCode: string; message?: string }> };
    expect(ledger.entries).toEqual([
      expect.objectContaining({ dokId: 'AUTH', status: 'skipped', reasonCode: 'EXISTING_PRESERVED' }),
      expect.objectContaining({
        dokId: 'USER',
        status: 'failed',
        reasonCode: 'GENERATION_FAILED',
        message: 'Claude Code provider rate limited the request.',
      }),
    ]);
    await expect(readFile(
      join(root, '.doklo/hub/doks/USER.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(!(typeof process.getuid === 'function' && process.getuid() === 0))(
    'returns completed Doks as preserved when only the final generation ledger is unwritable',
    async () => {
      const root = await tmpInit();
      await writeConsolidated(root, 'web', ['AUTH']);
      const cacheDir = join(root, '.doklo/cache');
      let nowCalls = 0;
      const now = () => {
        nowCalls += 1;
        if (nowCalls === 3) chmodSync(cacheDir, 0o500);
        return `2026-07-22T00:00:0${nowCalls}.000Z`;
      };
      const generator = vi.fn(async (_feature, ctx) => ({
        success: true as const,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: { input_tokens: 10, output_tokens: 20 },
      }));

      try {
        const outcome = await runGenerateThroughCommander(
          root,
          ['--no-roles', '--no-ia', '--no-code-mapping'],
          {
            runGenerateDeps: { generateDokForFeature: generator, now },
            resolveLlmForRole: async () => ({
              model: 'anthropic/claude-sonnet-5',
              providerKind: 'anthropic',
              authSource: 'keychain',
              apiKey: 'test-key',
            }),
          },
        );

        expect(outcome.result).toMatchObject({
          command: 'generate',
          status: 'partial',
          data: {
            results: [expect.objectContaining({ dokId: 'AUTH' })],
            failures: [],
            generationLedger: undefined,
          },
          diagnostics: [{
            code: 'GENERATION_LEDGER_UNAVAILABLE',
            message: 'Generation completed, but its recovery ledger could not be written.',
            file: '.doklo/cache/generation-ledger.json',
            retryable: true,
            preserved: ['.doklo/hub/doks/AUTH.json'],
            nextCommand: 'doklo generate --yes',
          }],
        });
        const diagnosticJson = JSON.stringify(outcome.result?.diagnostics);
        expect(diagnosticJson).not.toContain(root);
        expect(diagnosticJson).not.toContain('.tmp');
        expect(generator).toHaveBeenCalledOnce();
        expect(JSON.parse(await readFile(
          join(root, '.doklo/hub/doks/AUTH.json'),
          'utf8',
        ))).toMatchObject({ dok_id: 'AUTH' });
      } finally {
        await chmod(cacheDir, 0o755);
      }
      expect((await readdir(cacheDir))
        .filter((name) => name.includes('generation-ledger.json.'))).toEqual([]);
    },
  );

  it('keeps malformed Hub primary diagnostics when loading the failure ledger source fails', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(join(root, '.doklo/hub/roles.json'), '{ malformed roles', 'utf8');
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), '{ malformed cache', 'utf8');
    const staleLedger = join(root, '.doklo/cache/generation-ledger.json');
    await writeFile(staleLedger, '{"stale":true}\n', 'utf8');

    let thrown: unknown;
    try {
      await runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
      );
    } catch (error) {
      thrown = error;
    }

    const contract = toCommandContractError(thrown, 'generate');
    expect(contract.result).toMatchObject({
      status: 'failed',
      diagnostics: [
        { code: 'MALFORMED_HUB_FILE', file: '.doklo/hub/roles.json' },
        {
          code: 'GENERATION_LEDGER_UNAVAILABLE',
          message: 'The generation ledger could not be updated; stale evidence was removed.',
          file: '.doklo/cache/generation-ledger.json',
          retryable: true,
          nextCommand: 'doklo generate --yes',
        },
      ],
    });
    await expect(readFile(staleLedger, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(!(typeof process.getuid === 'function' && process.getuid() === 0))(
    'keeps malformed Hub primary diagnostics and marks an undeletable stale ledger',
    async () => {
      const root = await tmpInit();
      await writeConsolidated(root, 'web', ['AUTH']);
      await writeFile(join(root, '.doklo/hub/roles.json'), '{ malformed roles', 'utf8');
      const cacheDir = join(root, '.doklo/cache');
      const staleLedger = join(cacheDir, 'generation-ledger.json');
      await writeFile(staleLedger, '{"stale":true}\n', 'utf8');
      await chmod(cacheDir, 0o500);

      let thrown: unknown;
      try {
        await runGenerateThroughCommander(
          root,
          ['--no-roles', '--no-ia', '--no-code-mapping'],
        );
      } catch (error) {
        thrown = error;
      } finally {
        await chmod(cacheDir, 0o755);
      }

      const contract = toCommandContractError(thrown, 'generate');
      expect(contract.result).toMatchObject({
        status: 'failed',
        diagnostics: [
          { code: 'MALFORMED_HUB_FILE', file: '.doklo/hub/roles.json' },
          {
            code: 'GENERATION_LEDGER_UNAVAILABLE',
            message: 'The generation ledger could not be updated; an existing ledger may be stale.',
            file: '.doklo/cache/generation-ledger.json',
            retryable: true,
            nextCommand: 'doklo generate --yes',
          },
        ],
      });
      expect(await readFile(staleLedger, 'utf8')).toBe('{"stale":true}\n');
    },
  );

  it('does not infer a rate limit from an arbitrary provider message', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const generator = vi.fn(async () => ({
      success: false as const,
      dok: null,
      prompt: '',
      rawResponse: null,
      usage: null,
      failureKind: 'nonzero_exit' as const,
      error: 'HTTP 429 rate limit words from an unrelated provider failure',
    }));

    const outcome = await runGenerateThroughCommander(
      root,
      ['--no-roles', '--no-ia', '--no-code-mapping'],
      {
        runGenerateDeps: { generateDokForFeature: generator },
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'claude-code',
          authSource: 'claude-code',
        }),
      },
    );

    expect(outcome.result).toMatchObject({
      status: 'partial',
      diagnostics: [{
        code: 'DOK_GENERATION_FAILED',
        serviceId: 'web',
      }],
    });
    expect(outcome.result?.diagnostics[0]).not.toHaveProperty('retryable');
    expect(outcome.result?.diagnostics[0]).not.toHaveProperty('nextCommand');
  });

  it('publishes truncated provider output as a file-scoped retryable recovery diagnostic', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    const existingPath = join(root, '.doklo/hub/doks/AUTH.json');
    await writeFile(existingPath, JSON.stringify(makeDok('AUTH')), 'utf8');
    const existingBefore = await readFile(existingPath);
    const generator = vi.fn(async () => ({
      success: false as const,
      dok: null,
      prompt: '',
      rawResponse: '{"dok_id":"USER"',
      usage: { input_tokens: 10, output_tokens: 20 },
      failureKind: 'truncated_response' as const,
      error: 'LLM output was incomplete or truncated before the JSON completed.',
    }));

    const outcome = await runGenerateThroughCommander(
      root,
      ['--no-roles', '--no-ia', '--no-code-mapping'],
      {
        runGenerateDeps: { generateDokForFeature: generator },
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'claude-code',
          authSource: 'claude-code',
        }),
      },
    );

    expect(outcome.result).toMatchObject({
      status: 'partial',
      diagnostics: [{
        code: 'PROVIDER_RESPONSE_TRUNCATED',
        message: 'USER: LLM output was incomplete or truncated before the JSON completed.',
        serviceId: 'web',
        retryable: true,
        file: '.doklo/hub/doks/USER.json',
        preserved: ['.doklo/hub/doks/AUTH.json'],
        nextCommand: 'doklo generate --only USER --yes',
      }],
    });
    expect(await readFile(existingPath)).toEqual(existingBefore);
    expect(generator).toHaveBeenCalledTimes(2);
    expect(outcome.result?.data).toMatchObject({ failures: [{ attempts: 2 }], retryTokenUsage: { attemptedCalls: 1 } });
    await expect(readFile(
      join(root, '.doklo/hub/doks/USER.json'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves malformed roles bytes, calls no provider, and records every frozen work item failed', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    const malformed = Buffer.from('{ deliberately truncated roles', 'utf8');
    await writeFile(join(root, '.doklo/hub/roles.json'), malformed);
    const generator = vi.fn(async () => {
      throw new Error('provider must not run');
    });

    let thrown: unknown;
    try {
      await runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        { runGenerateDeps: { generateDokForFeature: generator } },
      );
    } catch (error) {
      thrown = error;
    }

    const contract = toCommandContractError(thrown, 'generate');
    expect(contract.result).toMatchObject({
      command: 'generate',
      status: 'failed',
      diagnostics: [{
        code: 'MALFORMED_HUB_FILE',
        file: '.doklo/hub/roles.json',
        retryable: true,
        preserved: ['.doklo/hub/roles.json'],
        nextCommand: 'doklo generate --yes',
      }],
    });
    expect(generator).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.doklo/hub/roles.json'))).toEqual(malformed);
    const ledger = JSON.parse(await readFile(
      join(root, '.doklo/cache/generation-ledger.json'),
      'utf8',
    )) as {
      entries: Array<{ dokId: string; status: string; reasonCode: string }>;
      summary: { success: number; skipped: number; failed: number };
    };
    expect(ledger.entries).toEqual([
      expect.objectContaining({ dokId: 'AUTH', status: 'failed', reasonCode: 'GENERATION_FAILED' }),
      expect.objectContaining({ dokId: 'USER', status: 'failed', reasonCode: 'GENERATION_FAILED' }),
    ]);
    expect(ledger.summary).toMatchObject({ success: 0, skipped: 0, failed: 2 });
  });

  it('turns a canonical permission failure into a retryable partial result and atomic failed ledger', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const doksDir = join(root, '.doklo/hub/doks');
    const generator = vi.fn(async (_feature, ctx) => ({
      success: true as const,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: { input_tokens: 10, output_tokens: 20 },
    }));

    await chmod(doksDir, 0o500);
    try {
      const outcome = await runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: { generateDokForFeature: generator },
          resolveLlmForRole: async () => ({
            model: 'anthropic/claude-sonnet-5',
            providerKind: 'anthropic',
            authSource: 'keychain',
            apiKey: 'test-key',
          }),
        },
      );

      expect(outcome.result).toMatchObject({
        command: 'generate',
        status: 'partial',
        diagnostics: [{
          code: 'PERMISSION_DENIED',
          message: 'AUTH: The Dok could not be written because its destination is not writable.',
          serviceId: 'web',
          file: '.doklo/hub/doks/AUTH.json',
          retryable: true,
          preserved: [],
          nextCommand: 'doklo generate --only AUTH --yes',
        }],
      });
      expect(JSON.stringify(outcome.result?.diagnostics)).not.toContain(root);
      expect(JSON.stringify(outcome.result?.diagnostics)).not.toContain('.tmp');
      expect(outcome.result?.data).toMatchObject({ failures: [{ dokId: 'AUTH', attempts: 1 }] });
      expect(generator).toHaveBeenCalledOnce();
      await expect(readFile(
        join(root, '.doklo/hub/doks/AUTH.json'),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
      const ledger = JSON.parse(await readFile(
        join(root, '.doklo/cache/generation-ledger.json'),
        'utf8',
      )) as {
        entries: Array<{ dokId: string; status: string; reasonCode: string }>;
        summary: { success: number; skipped: number; failed: number };
      };
      expect(ledger.entries).toEqual([expect.objectContaining({
        dokId: 'AUTH',
        status: 'failed',
        reasonCode: 'GENERATION_FAILED',
      })]);
      expect(ledger.summary).toMatchObject({ success: 0, skipped: 0, failed: 1 });
      expect((await readdir(join(root, '.doklo/cache')))
        .filter((name) => name.includes('generation-ledger.json.'))).toEqual([]);
    } finally {
      await chmod(doksDir, 0o755);
    }
  });
});

describe('runGenerate — decision:exclude', () => {
  it('drops features marked decision:"exclude" from the plan', async () => {
    const root = await tmpInit();
    await writeFile(
      join(root, '.doklo/cache', 'web.consolidated.json'),
      JSON.stringify({
        projectName: 'demo',
        basedOnFeaturesAt: new Date().toISOString(),
        generatedAt: new Date().toISOString(),
        model: 'claude-haiku-4-5',
        originalFeatureIds: ['a', 'b'],
        userReviewed: true,
        stats: { originalFeatures: 2, consolidatedFeatures: 2, merges: 0, excluded: 0 },
        groups: [{
          group_id: 'auth', label: 'auth', excluded: [],
          features: [
            { canonical_id: 'a', label: 'Kept', dok_id_prefix: 'KEEP',
              decision: 'keep', members: ['a'], primary_route: '/a', reason: '', user_reviewed: false },
            { canonical_id: 'b', label: 'Dropped', dok_id_prefix: 'DROP',
              decision: 'exclude', members: ['b'], primary_route: '/b', reason: '', user_reviewed: false },
          ],
        }],
      }),
      'utf-8',
    );
    const res = await runGenerate({ root, dryRun: true, noLexicon: true });
    const ids = res.plan.map((p) => p.dokId);
    expect(ids).toContain('KEEP');
    expect(ids).not.toContain('DROP');
  });
});

describe('runGenerate — B1: logic_files cover shared infra beyond display anchors', () => {
  it('hashes the full reachable closure (shared incl.) so a shared change is caught, while source_anchors stay display-only', async () => {
    const root = await tmpInit();

    // Two entry pages + one shared util. Feature A depends on the shared util
    // (it lives in A's logic_files but NOT its display source_files); Feature B
    // has no shared dependency and acts as the independent control.
    await mkdir(join(root, 'src/shared'), { recursive: true });
    const signupContent = 'export default function Signup(){ return null; }';
    const profileContent = 'export default function Profile(){ return null; }';
    const validationV1 = 'export const emailRule = /.+@.+/;';
    await writeFile(join(root, 'src/signup.tsx'), signupContent, 'utf-8');
    await writeFile(join(root, 'src/profile.tsx'), profileContent, 'utf-8');
    await writeFile(join(root, 'src/shared/validation.ts'), validationV1, 'utf-8');

    await writeConsolidatedWithLogicFiles(root, 'web', [
      {
        prefix: 'AUTH',
        route: '/auth/signup',
        source_files: ['src/signup.tsx'],
        logic_files: ['src/signup.tsx', 'src/shared/validation.ts'],
      },
      {
        prefix: 'PROF',
        route: '/profile',
        source_files: ['src/profile.tsx'],
        logic_files: ['src/profile.tsx'],
      },
    ]);

    // Fresh resolver evidence, including the shared utility's other consumers.
    for (const file of ['src/aux-a.tsx', 'src/aux-b.tsx']) {
      await writeFile(join(root, file), 'export default function Aux(){ return null; }');
    }
    const graph = {
      'src/signup.tsx': ['src/shared/validation.ts'], 'src/profile.tsx': [],
      'src/aux-a.tsx': ['src/shared/validation.ts'], 'src/aux-b.tsx': ['src/shared/validation.ts'],
      'src/shared/validation.ts': [],
    };
    await writeScanIr(root, 'web', {
      files: Object.keys(graph),
      routes: [['/auth/signup', 'src/signup.tsx'], ['/profile', 'src/profile.tsx'], ['/aux-a', 'src/aux-a.tsx'], ['/aux-b', 'src/aux-b.tsx']].map(([path, file]) => ({ path: path!, file: file!, kind: 'page', layout_chain: [], dynamic_params: [] })),
      framework_specific: { import_graph_tracking_version: 2, import_graph: graph,
        file_ledger: Object.keys(graph).map(file => ({ file, status: 'processed', stages: ['discovery', 'import-graph'], reason: 'OK' })) },
    });
    const cacheFile = join(root, '.doklo/cache/web.consolidated.json');
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
    cache.groups[0].features[0].members = ['auth-signup'];
    cache.groups[0].features[1].members = ['profile'];
    cache.originalFeatureIds = ['auth-signup', 'profile'];
    await writeFile(cacheFile, JSON.stringify(cache));

    await runGenerate({ root, noLexicon: true }, stubDeps);

    const readDok = async (id: string): Promise<{ _meta: Record<string, unknown> }> =>
      JSON.parse(await readFile(join(root, `.doklo/hub/doks/${id}.json`), 'utf-8'));
    const dokA = await readDok('AUTH');
    const dokB = await readDok('PROF');

    // Display attribution is unchanged — shared infra is still excluded from
    // source_anchors (its many consumers must not see a format/semantics shift).
    expect(dokA._meta.source_anchors).toEqual([{ file: 'src/signup.tsx' }]);

    // The drift set additionally carries the shared util drift actually hashed.
    expect(dokA._meta.logic_files).toEqual([
      { file: 'src/signup.tsx' },
      { file: 'src/shared/validation.ts' },
    ]);

    // logic_hash covers the full closure (shared incl.), not just the anchor.
    expect(dokA._meta.logic_hash).toBe(
      computeLogicHash([
        { file: 'src/signup.tsx', content: signupContent },
        { file: 'src/shared/validation.ts', content: validationV1 },
      ]),
    );

    // Freshly generated: both Doks are fresh.
    expect(isDokStale(dokA as never, root)).toEqual({ stale: false });
    expect(isDokStale(dokB as never, root)).toEqual({ stale: false });

    // The B1 payoff: editing a SHARED file that sits OUTSIDE the display anchor
    // set now marks the dependent Dok stale (was false-fresh before the fix),
    // while the unrelated Dok stays fresh.
    await writeFile(
      join(root, 'src/shared/validation.ts'),
      'export const emailRule = /.+@.+\\..+/; // stricter rule',
      'utf-8',
    );
    expect(isDokStale(dokA as never, root)).toEqual({ stale: true, reason: 'changed' });
    expect(isDokStale(dokB as never, root)).toEqual({ stale: false });
  });
});

describe('lexicon pass', () => {
  // `generate` only reuses confirmed Hub terminology. Fresh paid
  // suggestions are a separate `lexicon-suggest` command.
  const fakeSuggest = (texts: string[]) =>
    vi.fn(async () => ({
      written: true,
      cacheFile: '',
      corpus: 'code' as const,
      suggestions: texts.map((text) => ({ text, category: 'concept' as const, reason: '', dok_refs: [] })),
    }));

  const captureGen = (seen: unknown[]) =>
    vi.fn(async (_f: unknown, ctx: unknown) => {
      seen.push(ctx);
      const dokId = (ctx as { dokId: string }).dokId;
      return { success: true, dok: makeDok(dokId), prompt: '', rawResponse: '', usage: null };
    });

  it('does not make a fresh automatic lexicon call', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['MILE']);
    const seen: unknown[] = [];
    const suggest = fakeSuggest(['마일스톤']);
    await runGenerate({ root }, { generateDokForFeature: captureGen(seen), runLexiconSuggest: suggest });
    expect(suggest).not.toHaveBeenCalled();
    expect((seen[0] as { lexiconTerms?: string[] }).lexiconTerms).toBeUndefined();
  });

  it('does not promote unconfirmed suggestions into canonical generation terminology', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['MILE']);
    await writeFile(
      join(root, '.doklo/cache/lexicon-suggestions.json'),
      JSON.stringify({ generated_at: 't', corpus_size: 1, suggestions: [{ text: '멘토링', category: 'concept', reason: '', dok_refs: [] }] }),
      'utf-8',
    );
    const seen: unknown[] = [];
    const suggest = fakeSuggest(['unused']);
    await runGenerate({ root }, { generateDokForFeature: captureGen(seen), runLexiconSuggest: suggest });
    expect(suggest).not.toHaveBeenCalled();
    expect((seen[0] as { lexiconTerms?: string[] }).lexiconTerms).toBeUndefined();
  });

  it('discloses only confirmed canonical lexicon as a generation source', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['MILE']);
    await writeFile(join(root, '.doklo/hub/lexicon.json'), JSON.stringify({
      version: 1,
      terms: [{
        term_id: 'TERM-MILESTONE',
        category: 'concept',
        binding: { type: 'owned' }, locales: { en: 'Milestone' },
      }],
    }));
    await writeFile(join(root, '.doklo/cache/lexicon-suggestions.json'), JSON.stringify({
      generated_at: 't', corpus_size: 1,
      suggestions: [{ text: 'Mentoring', category: 'concept', reason: '', dok_refs: [] }],
    }));

    const preview = await runGenerateDirect({ root, dryRun: true });

    expect(preview.transmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'generate', file: '.doklo/hub/lexicon.json', maxChars: 12_000,
      }),
    ]));
    expect(preview.transmissions.some(source => source.file === '.doklo/cache/lexicon-suggestions.json')).toBe(false);
    expect(preview.preparedGeneration!.items[0]!.ctx.lexiconTerms).toEqual(['Milestone']);
  });

  it('excludes large unconfirmed caches from prompts and source accounting', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['MILE']);
    await writeFile(join(root, '.doklo/cache/lexicon-suggestions.json'), JSON.stringify({
      generated_at: 't', corpus_size: 81,
      suggestions: [
        ...Array.from({ length: 80 }, (_, index) => ({
          text: `${index}-` + 'x'.repeat(190), category: 'concept', reason: '', dok_refs: [],
        })),
        { text: 'CACHED_TERMINOLOGY_AFTER_12K_CANARY', category: 'concept', reason: '', dok_refs: [] },
      ],
    }));
    const seen: unknown[] = [];

    const preview = await runGenerateDirect({ root, dryRun: true });
    const preparedItem = preview.preparedGeneration!.items[0]!;
    const preparedTerms = preparedItem.ctx.lexiconTerms ?? [];
    const renderedTerms = preparedTerms.map((term) => `  - ${term}`).join('\n');
    const suggestionSource = preparedItem.transmissions.find((source) =>
      source.file === '.doklo/cache/lexicon-suggestions.json');
    expect(suggestionSource).toBeUndefined();
    expect(renderedTerms).toBe('');

    await runGenerate(
      { root },
      { generateDokForFeature: captureGen(seen), runLexiconSuggest: fakeSuggest(['unused']) },
    );

    const terms = (seen[0] as { lexiconTerms?: string[] }).lexiconTerms ?? [];
    expect(terms.join('\n')).not.toContain('CACHED_TERMINOLOGY_AFTER_12K_CANARY');
  });

  it('skips entirely with noLexicon', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['MILE']);
    const seen: unknown[] = [];
    const suggest = fakeSuggest(['x']);
    await runGenerate({ root, noLexicon: true }, { generateDokForFeature: captureGen(seen), runLexiconSuggest: suggest });
    expect(suggest).not.toHaveBeenCalled();
    expect((seen[0] as { lexiconTerms?: string[] }).lexiconTerms).toBeUndefined();
  });

  it('does not invoke a failing lexicon worker during generation', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['MILE']);
    const failingSuggest = vi.fn(async () => ({ written: false, cacheFile: '', suggestions: [], error: 'boom' }));
    const events: GenerateProgressEvent[] = [];
    const result = await runGenerate(
      { root, onProgress: (e) => events.push(e) },
      { generateDokForFeature: captureGen([]), runLexiconSuggest: failingSuggest },
    );
    expect(result.results).toHaveLength(1);
    expect(failingSuggest).not.toHaveBeenCalled();
    expect(events.some((e) => e.stage === 'lexicon' && e.status === 'error')).toBe(false);
  });
});

describe('runGenerate — deterministic Hub layers', () => {
  const fixedNow = '2026-07-15T12:00:00.000Z';

  it('refreshes roles before Dok generation, forwards the dynamic actor hint, preserves curated data, and is byte-idempotent', async () => {
    const root = await tmpInit();
    await writeMentorFixture(root);
    await writeFile(
      join(root, '.doklo/hub/roles.json'),
      JSON.stringify({
        roles: [
          {
            role_id: 'ROLE-USER',
            name: 'Curated user',
            description: 'Never replace this description',
            kind: 'access',
            extends: [],
            scope: 'resource',
          },
        ],
        version: 1,
      }),
      'utf-8',
    );
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    await writeFile(
      join(root, '.doklo/hub/services/web/ia.json'),
      JSON.stringify({
        service_id: 'web',
        version: 2,
        trees: [
          {
            tree_id: 'web-nav',
            type: 'navigation',
            source: 'manual',
            platform: 'all',
            nodes: [
              {
                path: '/curated',
                kind: 'destination',
                label: 'Curated label',
                curated_fields: [],
                bindings: [],
                tags: ['hand-authored'],
                children: [],
              },
            ],
          },
        ],
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );

    const seenContexts: Array<{ knownRoles: readonly string[]; suggestedActorRole?: string }> = [];
    const generator = vi.fn(async (_feature, ctx) => {
      seenContexts.push({
        knownRoles: [...ctx.knownRoles],
        ...(ctx.suggestedActorRole === undefined ? {} : { suggestedActorRole: ctx.suggestedActorRole }),
      });
      return {
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      };
    });

    const result = await runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, now: () => fixedNow },
    );

    expect(seenContexts[0]?.knownRoles).toContain('ROLE-MENTOR');
    expect(seenContexts[0]?.suggestedActorRole).toBe('ROLE-MENTOR');

    const roles = JSON.parse(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8'));
    expect(roles.roles.find((role: { role_id: string }) => role.role_id === 'ROLE-USER')).toMatchObject({
      name: 'Curated user',
      description: 'Never replace this description',
      kind: 'access',
      scope: 'resource',
    });
    expect(roles.roles.find((role: { role_id: string }) => role.role_id === 'ROLE-MENTOR')).toMatchObject({
      kind: 'actor_type',
    });

    const iaPath = join(root, '.doklo/hub/services/web/ia.json');
    const mappingPath = join(root, '.doklo/hub/services/web/code-mapping.json');
    const ia = IaFileV2Schema.parse(JSON.parse(await readFile(iaPath, 'utf-8')));
    const mapping = ServiceCodeMappingFileSchema.parse(
      JSON.parse(await readFile(mappingPath, 'utf-8')),
    );
    const routes = ia.trees.find((tree) => tree.tree_id === 'web-routes');
    expect(routes).toMatchObject({
      type: 'route_hierarchy',
      source: 'auto',
      producer: ROUTE_HIERARCHY_PRODUCER,
    });
    expect(findIaNode(routes!.nodes, '/mentor')).toMatchObject({ kind: 'group' });
    expect(findIaNode(routes!.nodes, '/mentor/profile')).toMatchObject({
      kind: 'destination',
      bindings: [{ dok_ref: 'MENTOR', source: 'auto' }],
      evidence: [{ kind: 'route_source', file: 'app/mentor/profile/page.tsx' }],
    });
    const nav = ia.trees.find((tree) => tree.tree_id === 'web-nav');
    expect(nav).toMatchObject({ source: 'manual' });
    expect(findIaNode(nav!.nodes, '/curated')).toMatchObject({
      label: 'Curated label',
      bindings: [],
      tags: ['hand-authored'],
    });
    expect(mapping.entries.map((entry) => entry.dok_id)).toEqual(['MENTOR']);
    expect(result.layers.ia).toHaveLength(1);
    expect(result.layers.ia[0]?.count).toBe(1);
    expect(result.layers.codeMapping).toHaveLength(1);
    expect(result.layerFailures).toEqual([]);

    const firstMtime = (await stat(iaPath)).mtimeMs;
    const firstBytes = {
      roles: await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8'),
      ia: await readFile(iaPath, 'utf-8'),
      mapping: await readFile(mappingPath, 'utf-8'),
    };
    const second = await runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, now: () => '2026-07-16T12:00:00.000Z' },
    );
    expect(generator).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8')).toBe(firstBytes.roles);
    expect(await readFile(iaPath, 'utf-8')).toBe(firstBytes.ia);
    expect((await stat(iaPath)).mtimeMs).toBe(firstMtime);
    expect(await readFile(mappingPath, 'utf-8')).toBe(firstBytes.mapping);
    expect(second.layers.ia[0]?.status).toBe('unchanged');
  });

  it('runs roles, Dok, IA, and code-mapping without an automatic lexicon worker', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const callOrder: string[] = [];
    const events: GenerateProgressEvent[] = [];
    const result = await runGenerate(
      { root, onProgress: (event) => events.push(event) },
      {
        runRolesRefresh: async () => {
          callOrder.push('roles');
          return { candidates: [], added: [], kept: [], skipped: [], written: false };
        },
        runLexiconSuggest: async () => {
          callOrder.push('lexicon');
          return { written: false, cacheFile: '', suggestions: [] };
        },
        generateDokForFeature: async (_feature, ctx) => {
          callOrder.push('dok');
          return {
            success: true,
            dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
            prompt: '',
            rawResponse: '',
            usage: null,
          };
        },
        deriveIA: (ctx) => {
          callOrder.push('ia');
          return emptyDerivedRouteHierarchy(ctx.serviceId);
        },
        deriveCodeMapping: async (ctx) => {
          callOrder.push('code-mapping');
          return ServiceCodeMappingFileSchema.parse({ service_id: ctx.serviceId, entries: [], version: 1 });
        },
        now: () => fixedNow,
      },
    );

    expect(callOrder).toEqual(['roles', 'dok', 'ia', 'code-mapping']);
    expect(events.at(-1)).toMatchObject({ stage: 'done', failed: 0, layerFailed: 0 });
    expect(result.layerFailures).toEqual([]);
  });

  it('rejects duplicate workspace-wide Dok IDs before any producer or write', async () => {
    const root = await tmpInit();
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
    await writeScanIr(root, 'admin');
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeConsolidated(root, 'admin', ['AUTH']);
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const generator = vi.fn(async (_feature, ctx) => ({
      success: true,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: null,
    }));

    await expect(runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, runRolesRefresh: rolesPass },
    )).rejects.toThrow(/AUTH.*web.*admin|duplicate.*AUTH|collision.*AUTH/i);

    expect(rolesPass).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toThrow();
  });

  it('rejects a malformed consolidated cache at the runtime boundary', async () => {
    const root = await tmpInit();
    const malformed = makeConsolidatedConfig(['AUTH']) as unknown as Record<string, unknown>;
    malformed['unexpected'] = 'must not be stripped';
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify(malformed),
      'utf-8',
    );
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true, noRoles: true },
      { generateDokForFeature: generator },
    )).rejects.toMatchObject({
      name: 'InvalidConsolidatedCacheError',
      cachePath: join(root, '.doklo/cache/web.consolidated.json'),
    });

    expect(generator).not.toHaveBeenCalled();
  });

  it('prepares generation from a legacy route-slug collision without rewriting its cache', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, [
      'app/create-template/page.tsx',
      'app/create/template/page.tsx',
    ]);
    await writeScanIr(root, 'web', {
      files: [
        'app/create-template/page.tsx',
        'app/create/template/page.tsx',
      ],
      routes: [
        {
          path: '/create-template',
          kind: 'page',
          file: 'app/create-template/page.tsx',
          dynamic_params: [],
          layout_chain: [],
        },
        {
          path: '/create/template',
          kind: 'page',
          file: 'app/create/template/page.tsx',
          dynamic_params: [],
          layout_chain: [],
        },
      ],
    });
    const legacy = makeConsolidatedConfig(['TEMPLATE', 'CREATE-TPL']);
    legacy.originalFeatureIds = ['create-template', 'create-template'];
    legacy.groups = [
      {
        group_id: 'create-template',
        label: 'Direct',
        excluded: [],
        features: [{
          ...legacy.groups[0]!.features[0]!,
          canonical_id: 'create-template',
          members: ['create-template'],
          primary_route: '/create-template',
          source_files: ['app/create/template/page.tsx'],
          logic_files: ['app/create/template/page.tsx'],
        }],
      },
      {
        group_id: 'create',
        label: 'Nested',
        excluded: [],
        features: [{
          ...legacy.groups[0]!.features[1]!,
          canonical_id: 'create-template',
          members: ['create-template'],
          primary_route: '/create/template',
          source_files: ['app/create/template/page.tsx'],
          logic_files: ['app/create/template/page.tsx'],
        }],
      },
    ];
    const cachePath = join(root, '.doklo/cache/web.consolidated.json');
    const before = JSON.stringify(legacy);
    await writeFile(cachePath, before, 'utf-8');

    const result = await runGenerate({
      root,
      dryRun: true,
      noLexicon: true,
      noRoles: true,
      noIa: true,
      noCodeMapping: true,
    });

    expect(result.plan.map((item) => item.dokId)).toEqual(['TEMPLATE', 'CREATE-TPL']);
    expect(result.preparedGeneration?.items.map((item) => ({
      dokId: item.dokId,
      files: item.feature.files,
    }))).toEqual([
      { dokId: 'TEMPLATE', files: ['app/create-template/page.tsx'] },
      { dokId: 'CREATE-TPL', files: ['app/create/template/page.tsx'] },
    ]);
    expect(await readFile(cachePath, 'utf-8')).toBe(before);
  });

  it('rejects a service code_root that escapes the workspace before any producer', async () => {
    const root = await tmpInit();
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '../outside' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeConsolidated(root, 'web', ['AUTH']);
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true, noRoles: true },
      { generateDokForFeature: generator },
    )).rejects.toThrow(/outside.*root|escape|contain/i);

    expect(generator).not.toHaveBeenCalled();
  });

  it.each([
    ['consolidated source file', 'source' as const],
    ['IR fallback route file', 'route' as const],
  ])('rejects an escaping %s before any producer', async (_label, source) => {
    const root = await tmpInit();
    await mkdir(join(root, 'service'), { recursive: true });
    await writeSupportedNextProject(join(root, 'service'));
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
    const config = makeConsolidatedConfig(['AUTH']);
    if (source === 'source') {
      config.groups[0]!.features[0]!.source_files = ['../outside-secret.ts'];
    }
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify(config),
      'utf-8',
    );
    if (source === 'route') {
      await writeScanIr(root, 'web', {
        files: ['../outside-secret.ts'],
        routes: [
          { path: '/x0', kind: 'page', file: '../outside-secret.ts', dynamic_params: [], layout_chain: [] },
        ],
      });
    }
    await writeFile(join(root, 'outside-secret.ts'), 'workspace secret', 'utf-8');
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true, noRoles: true },
      { generateDokForFeature: generator },
    )).rejects.toThrow(/outside.*root|escape|contain/i);

    expect(generator).not.toHaveBeenCalled();
  });

  it('rejects a symlinked source path that resolves outside the service root', async () => {
    const root = await tmpInit();
    await mkdir(join(root, 'service'), { recursive: true });
    await writeSupportedNextProject(join(root, 'service'));
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside/secret.ts'), 'workspace secret', 'utf-8');
    await symlink('../outside', join(root, 'service/link'));
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
    const config = makeConsolidatedConfig(['AUTH']);
    config.groups[0]!.features[0]!.source_files = ['link/secret.ts'];
    await writeFile(
      join(root, '.doklo/cache/web.consolidated.json'),
      JSON.stringify(config),
      'utf-8',
    );
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true, noRoles: true },
      { generateDokForFeature: generator },
    )).rejects.toThrow(/outside.*root|escape|contain/i);

    expect(generator).not.toHaveBeenCalled();
  });

  it('rejects a Hub service output symlink outside the workspace before any producer', async () => {
    const root = await tmpInit();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-gen-output-outside-'));
    await writeConsolidated(root, 'web', ['AUTH']);
    await mkdir(join(root, '.doklo/hub/services'), { recursive: true });
    await symlink(outside, join(root, '.doklo/hub/services/web'));
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, runRolesRefresh: rolesPass },
    )).rejects.toThrow(/outside|contain|root|symlink/i);

    expect(rolesPass).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it('atomically replaces a changed layer file instead of mutating an external hard-link alias', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['app/x0/page.tsx']);
    const outside = await mkdtemp(join(tmpdir(), 'doklo-gen-hardlink-outside-'));
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeScanIr(root, 'web', {
      files: ['app/x0/page.tsx'],
      routes: [{ path: '/x0', kind: 'page', file: 'app/x0/page.tsx' }],
    });
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const target = join(root, '.doklo/hub/services/web/ia.json');
    const alias = join(outside, 'ia-alias.json');
    const original = `${JSON.stringify({
      service_id: 'web',
      trees: [],
      edges: [],
      version: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
    }, null, 2)}\n`;
    await writeFile(target, original, 'utf-8');
    await link(target, alias);

    await runGenerate(
      {
        root,
        noLexicon: true,
        noRoles: true,
        noCodeMapping: true,
      },
      {
        generateDokForFeature: async () => {
          throw new Error('pre-existing Dok must not invoke generation');
        },
        now: () => fixedNow,
      },
    );

    expect(await readFile(alias, 'utf-8')).toBe(original);
    expect(await readFile(target, 'utf-8')).not.toBe(original);
  });

  it('writes deterministic layers when every Dok already exists without calling the LLM', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['app/x0/page.tsx']);
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeScanIr(root, 'web', {
      files: ['app/x0/page.tsx'],
      routes: [{ path: '/x0', kind: 'page', file: 'app/x0/page.tsx' }],
    });
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );
    const generator = vi.fn(async () => {
      throw new Error('zero-Dok path must not call the LLM');
    });

    const result = await runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, now: () => fixedNow },
    );

    expect(generator).not.toHaveBeenCalled();
    expect(result.skippedExisting).toEqual(['AUTH']);
    const ia = IaFileV2Schema.parse(
      JSON.parse(await readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')),
    );
    const mapping = ServiceCodeMappingFileSchema.parse(
      JSON.parse(await readFile(join(root, '.doklo/hub/services/web/code-mapping.json'), 'utf-8')),
    );
    expect(ia.trees[0]?.nodes[0]).toMatchObject({
      kind: 'destination',
      bindings: [{ dok_ref: 'AUTH', source: 'auto' }],
    });
    expect(mapping.entries.map((entry) => entry.dok_id)).toEqual(['AUTH']);
  });

  it('migrates a legacy v1 IA file to the v2 contract inside generate', async () => {
    const root = await tmpInit();
    await writeMentorFixture(root);
    await writeFile(
      join(root, '.doklo/hub/doks/MENTOR.json'),
      JSON.stringify(makeDok('MENTOR')),
      'utf-8',
    );
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const iaPath = join(root, '.doklo/hub/services/web/ia.json');
    await writeFile(iaPath, `${JSON.stringify(legacyIaFile(), null, 2)}\n`, 'utf-8');

    const result = await runGenerate(
      { root, noLexicon: true },
      {
        generateDokForFeature: async () => {
          throw new Error('pre-existing Dok must not invoke generation');
        },
        now: () => fixedNow,
      },
    );

    const raw = JSON.parse(await readFile(iaPath, 'utf-8'));
    const ia = IaFileV2Schema.parse(raw);

    expect(result.layerFailures).toEqual([]);
    expect(result.layers.ia[0]?.status).toBe('written');
    expect(ia.version).toBe(2);
    expect(raw).not.toHaveProperty('edges');
    // The producer-owned flat nav is re-derived in place under the canonical id;
    // the curated tree survives beside it.
    expect(ia.trees.map((tree) => tree.tree_id)).toEqual(['web-routes', 'web-main-nav']);
    expect(ia.trees[0]).toMatchObject({
      type: 'route_hierarchy',
      source: 'auto',
      producer: ROUTE_HIERARCHY_PRODUCER,
    });
    // Every binding states its provenance, and the curated placement's repeat of
    // a derived dok_ref collapses into the single auto entry.
    expect(findIaNode(ia.trees[0]!.nodes, '/mentor/profile')).toMatchObject({
      kind: 'destination',
      bindings: [{ dok_ref: 'MENTOR', source: 'auto' }],
      evidence: [{ kind: 'route_source', file: 'app/mentor/profile/page.tsx' }],
    });
    expect(ia.trees[1]).toMatchObject({ type: 'navigation', source: 'manual' });
    expect(findIaNode(ia.trees[1]!.nodes, '/mentor/profile')).toMatchObject({
      label: 'My profile',
      kind: 'destination',
      bindings: [],
    });
    expect(ia.updated_at).toBe(fixedNow);
  });

  it('leaves a legacy IA file byte-identical when its migration is blocked', async () => {
    const root = await tmpInit();
    await writeMentorFixture(root);
    await writeFile(
      join(root, '.doklo/hub/doks/MENTOR.json'),
      JSON.stringify(makeDok('MENTOR')),
      'utf-8',
    );
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const iaPath = join(root, '.doklo/hub/services/web/ia.json');
    const blocked = {
      ...legacyIaFile(),
      trees: [
        legacyIaFile().trees[0]!,
        {
          tree_id: 'web-main-nav',
          type: 'navigation',
          platform: 'all',
          source: 'manual',
          // Pathless, so there is no destination to move the binding onto.
          nodes: [{ label: 'Saved items', dok_ref: 'MENTOR', children: [] }],
        },
      ],
    };
    await writeFile(iaPath, `${JSON.stringify(blocked, null, 2)}\n`, 'utf-8');
    const before = await readFile(iaPath);
    const beforeMtime = (await stat(iaPath)).mtimeMs;

    const result = await runGenerate(
      { root, noLexicon: true },
      {
        generateDokForFeature: async () => {
          throw new Error('pre-existing Dok must not invoke generation');
        },
        now: () => fixedNow,
      },
    );

    expect(await readFile(iaPath)).toEqual(before);
    expect((await stat(iaPath)).mtimeMs).toBe(beforeMtime);
    expect(result.layers.ia).toEqual([]);
    expect(result.layerFailures).toHaveLength(1);
    expect(result.layerFailures[0]).toMatchObject({ layer: 'ia', serviceId: 'web' });
    expect(result.layerFailures[0]?.reason).toContain(
      'web-main-nav/Saved items: assign a path or move the binding manually',
    );
    // Other layers still run: an IA failure is isolated per service and layer.
    expect(result.layers.codeMapping).toHaveLength(1);
  });

  it('reports the migrated IA file as unchanged on the next generate', async () => {
    const root = await tmpInit();
    await writeMentorFixture(root);
    await writeFile(
      join(root, '.doklo/hub/doks/MENTOR.json'),
      JSON.stringify(makeDok('MENTOR')),
      'utf-8',
    );
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const iaPath = join(root, '.doklo/hub/services/web/ia.json');
    await writeFile(iaPath, `${JSON.stringify(legacyIaFile(), null, 2)}\n`, 'utf-8');
    const zeroDokGenerator = async () => {
      throw new Error('pre-existing Dok must not invoke generation');
    };

    const first = await runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: zeroDokGenerator, now: () => fixedNow },
    );
    const migratedBytes = await readFile(iaPath, 'utf-8');
    const migratedMtime = (await stat(iaPath)).mtimeMs;

    const second = await runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: zeroDokGenerator, now: () => '2026-07-16T12:00:00.000Z' },
    );

    expect(first.layers.ia[0]?.status).toBe('written');
    expect(second.layers.ia[0]?.status).toBe('unchanged');
    expect(await readFile(iaPath, 'utf-8')).toBe(migratedBytes);
    expect((await stat(iaPath)).mtimeMs).toBe(migratedMtime);
  });

  it('uses a validated existing Dok name as the zero-Dok sitemap label fallback', async () => {
    const root = await tmpInit();
    await writeMentorFixture(root);
    const consolidatedPath = join(root, '.doklo/cache/web.consolidated.json');
    const consolidated = JSON.parse(await readFile(consolidatedPath, 'utf-8'));
    consolidated.groups[0].features[0].label = '';
    await writeFile(consolidatedPath, JSON.stringify(consolidated), 'utf-8');
    await writeFile(
      join(root, '.doklo/hub/doks/MENTOR.json'),
      JSON.stringify(makeDok('MENTOR', 'Mentor profile')),
      'utf-8',
    );
    const generator = vi.fn(async () => {
      throw new Error('zero-Dok path must not call the LLM');
    });

    await runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, now: () => fixedNow },
    );

    expect(generator).not.toHaveBeenCalled();
    const ia = IaFileV2Schema.parse(
      JSON.parse(await readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')),
    );
    const routes = ia.trees.find((tree) => tree.tree_id === 'web-routes');
    expect(findIaNode(routes!.nodes, '/mentor/profile')?.label).toBe('Mentor profile');
  });

  it('omits dangling IA and code-mapping refs when a Dok generation fails', async () => {
    const root = await tmpInit();
    await writeFixtureFiles(root, ['app/x0/page.tsx']);
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeScanIr(root, 'web', {
      files: ['app/x0/page.tsx'],
      routes: [{ path: '/x0', kind: 'page', file: 'app/x0/page.tsx' }],
    });

    const result = await runGenerate(
      { root, noLexicon: true },
      {
        generateDokForFeature: async () => ({
          success: false,
          dok: null,
          prompt: '',
          rawResponse: '',
          usage: null,
          error: 'intentional failure',
        }),
        now: () => fixedNow,
      },
    );

    expect(result.failures.map((failure) => failure.dokId)).toEqual(['AUTH']);
    const ia = IaFileV2Schema.parse(
      JSON.parse(await readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')),
    );
    const mapping = ServiceCodeMappingFileSchema.parse(
      JSON.parse(await readFile(join(root, '.doklo/hub/services/web/code-mapping.json'), 'utf-8')),
    );
    expect(ia.trees[0]?.nodes[0]).toMatchObject({ kind: 'destination', bindings: [] });
    expect(mapping.entries).toEqual([]);
  });

  it.each([
    ['ia', 'ia.json'],
    ['code-mapping', 'code-mapping.json'],
  ] as const)('rejects malformed existing %s before roles, LLMs, or writes', async (_layer, file) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const target = join(root, '.doklo/hub/services/web', file);
    const malformed = '{ definitely not valid JSON';
    await writeFile(target, malformed, 'utf-8');
    const originalRoles = await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8');
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true },
      {
        generateDokForFeature: generator,
        runRolesRefresh: rolesPass,
        now: () => fixedNow,
      },
    )).rejects.toMatchObject({ name: 'InvalidLayerFileError', outputPath: target });

    expect(await readFile(target, 'utf-8')).toBe(malformed);
    expect(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8')).toBe(originalRoles);
    expect(rolesPass).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).rejects.toThrow();
  });

  it('does not preflight an invalid IA file when the IA layer is explicitly disabled', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const target = join(root, '.doklo/hub/services/web/ia.json');
    const malformed = '{ intentionally invalid IA';
    await writeFile(target, malformed, 'utf-8');
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    const result = await runGenerate(
      {
        root,
        noLexicon: true,
        noRoles: true,
        noIa: true,
        noCodeMapping: true,
      },
      { generateDokForFeature: generator },
    );

    expect(generator).toHaveBeenCalledOnce();
    expect(result.results.map((entry) => entry.dokId)).toEqual(['AUTH']);
    expect(await readFile(target, 'utf-8')).toBe(malformed);
  });

  it('preflights all selected services before the first service can mutate the Hub', async () => {
    const root = await tmpInit();
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
    await writeScanIr(root, 'admin');
    await writeConsolidated(root, 'web', ['WEB']);
    await writeConsolidated(root, 'admin', ['ADMIN']);
    await mkdir(join(root, '.doklo/hub/services/admin'), { recursive: true });
    await writeFile(join(root, '.doklo/hub/services/admin/ia.json'), '{ invalid IA', 'utf-8');
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, runRolesRefresh: rolesPass },
    )).rejects.toThrow(/invalid.*ia|layer.*invalid/i);

    expect(rolesPass).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/hub/doks/WEB.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(root, '.doklo/hub/doks/ADMIN.json'), 'utf-8')).rejects.toThrow();
  });

  it.each([
    ['ia', 'ia.json', { service_id: 'other', trees: [], edges: [], version: 1 }],
    ['code-mapping', 'code-mapping.json', { service_id: 'other', entries: [], version: 1 }],
  ] as const)('rejects a schema-valid %s file owned by another service before mutation', async (_layer, file, existing) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const target = join(root, '.doklo/hub/services/web', file);
    const original = `${JSON.stringify(existing, null, 2)}\n`;
    await writeFile(target, original, 'utf-8');
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true },
      {
        generateDokForFeature: generator,
        runRolesRefresh: rolesPass,
        now: () => fixedNow,
      },
    )).rejects.toThrow(/other|service/i);

    expect(await readFile(target, 'utf-8')).toBe(original);
    expect(rolesPass).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
  });

  it.each([
    ['noRoles', 'roles', 'runRolesRefresh'],
    ['noIa', 'ia', 'deriveIA'],
    ['noCodeMapping', 'code-mapping', 'deriveCodeMapping'],
  ] as const)('honors %s independently', async (option, stage, disabledDep) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const events: GenerateProgressEvent[] = [];
    const deps = {
      generateDokForFeature: stubDeps.generateDokForFeature!,
      runLexiconSuggest: vi.fn(async () => ({ written: false, cacheFile: '', suggestions: [] })),
      runRolesRefresh: vi.fn(async () => ({
        candidates: [], added: [], kept: [], skipped: [], written: false,
      })),
      deriveIA: vi.fn((ctx: { serviceId: string }) =>
        emptyDerivedRouteHierarchy(ctx.serviceId)),
      deriveCodeMapping: vi.fn(async (ctx: { serviceId: string }) =>
        ServiceCodeMappingFileSchema.parse({ service_id: ctx.serviceId, entries: [], version: 1 })),
      now: () => fixedNow,
    };

    await runGenerate(
      { root, noLexicon: true, [option]: true, onProgress: (event) => events.push(event) },
      deps,
    );

    expect(deps[disabledDep]).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ stage, status: 'skipped' }));
  });

  it('limits every pass to --service and rejects an unknown explicit service', async () => {
    const root = await tmpInit();
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
    await writeScanIr(root, 'admin');
    await writeConsolidated(root, 'web', ['WEB']);
    await writeConsolidated(root, 'admin', ['ADMIN']);
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));

    const result = await runGenerate(
      { root, serviceId: 'admin', noLexicon: true },
      {
        generateDokForFeature: stubDeps.generateDokForFeature,
        runRolesRefresh: rolesPass,
        now: () => fixedNow,
      },
    );

    expect(result.results.map((entry) => entry.serviceId)).toEqual(['admin']);
    expect(rolesPass).toHaveBeenCalledWith({ root, apply: true, serviceId: 'admin' });
    await expect(readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')).rejects.toThrow();
    expect(IaFileV2Schema.parse(
      JSON.parse(await readFile(join(root, '.doklo/hub/services/admin/ia.json'), 'utf-8')),
    ).service_id).toBe('admin');

    await expect(runGenerate({ root, serviceId: 'missing', dryRun: true })).rejects.toThrow(
      /missing.*service|service.*missing/i,
    );
  });

  it('rejects real execution for an explicit service whose scan cache is missing', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await rm(join(root, '.doklo/cache/web.scan.json'));
    await expect(runGenerateDirect({ root, serviceId: 'web' })).rejects.toThrowError(
      GenerateScanCacheMissingError,
    );
  });

  it.each([
    ['malformed JSON', '{ not JSON'],
    ['schema-invalid JSON', JSON.stringify({ roles: [{ role_id: 'not-a-role' }], version: 1 })],
  ])('treats %s roles.json as fatal even when role refresh is disabled', async (_label, invalidRoles) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const rolesPath = join(root, '.doklo/hub/roles.json');
    await writeFile(rolesPath, invalidRoles, 'utf-8');
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      {
        root,
        noRoles: true,
        noLexicon: true,
        noIa: true,
        noCodeMapping: true,
      },
      { generateDokForFeature: generator },
    )).rejects.toThrow(/roles.*invalid|invalid.*roles/i);

    expect(generator).not.toHaveBeenCalled();
    expect(await readFile(rolesPath, 'utf-8')).toBe(invalidRoles);
  });

  it.each([
    ['malformed JSON', '{ invalid dok'],
    ['mismatched dok_id', JSON.stringify(makeDok('OTHER'), null, 2)],
  ])('rejects an existing Dok target with %s before mutation or layer references', async (_label, invalidDok) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const target = join(root, '.doklo/hub/doks/AUTH.json');
    await writeFile(target, invalidDok, 'utf-8');
    const rolesPass = vi.fn(async () => ({
      candidates: [], added: [], kept: [], skipped: [], written: false,
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator, runRolesRefresh: rolesPass },
    )).rejects.toThrow(/AUTH.*invalid|invalid.*AUTH|dok_id.*AUTH/i);

    expect(rolesPass).not.toHaveBeenCalled();
    expect(generator).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf-8')).toBe(invalidDok);
    await expect(readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(root, '.doklo/hub/services/web/code-mapping.json'), 'utf-8')).rejects.toThrow();
  });

  it('skips unusable services in a whole-workspace run without creating dangling contexts', async () => {
    const root = await tmpInit();
    const events: GenerateProgressEvent[] = [];
    const result = await runGenerate({
      root,
      noLexicon: true,
      onProgress: (event) => events.push(event),
    });

    expect(result.results).toEqual([]);
    expect(result.layerFailures).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ stage: 'ia', serviceId: 'web', status: 'skipped' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ stage: 'code-mapping', serviceId: 'web', status: 'skipped' }),
    );
  });

  it('allows a declared non-Next service through generation admission', async () => {
    const root = await tmpInit();
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [{
          service_id: 'web',
          type: 'mobile',
          framework: 'react-native',
          code_root: '.',
        }],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    const generator = vi.fn(stubDeps.generateDokForFeature!);

    await expect(runGenerate(
      { root, noLexicon: true },
      { generateDokForFeature: generator },
    )).resolves.toMatchObject({ results: [] });
    expect(generator).not.toHaveBeenCalled();
  });

  it('still validates Hub policy for a declared non-Next service before credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-gen-unsupported-'));
    await mkdir(join(root, '.doklo/hub/doks'), { recursive: true });
    await mkdir(join(root, '.doklo/debug'), { recursive: true });
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
        services: [
          {
            service_id: 'mobile',
            type: 'mobile',
            framework: 'react-native',
            code_root: '.',
          },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeFile(
      join(root, '.doklo/hub/roles.json'),
      '{ invalid roles',
      'utf-8',
    );

    resolveLlmForRoleMock.mockReset();
    resolveLlmForRoleMock.mockRejectedValueOnce(new Error('credential resolution masked scan failure'));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerGenerateCommand(program, createContext('en'));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await expect(
        program.parseAsync([
          'generate',
          '--root', root,
          '--yes',
          '--no-lexicon',
          '--no-roles',
          '--no-ia',
          '--no-code-mapping',
        ], { from: 'user' }),
      ).rejects.toMatchObject({
        name: 'InvalidRolesFileError',
      });
      expect(resolveLlmForRoleMock).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      consoleSpy.mockRestore();
      resolveLlmForRoleMock.mockReset();
      resolveLlmForRoleMock.mockResolvedValue({
        model: 'anthropic/claude-sonnet-5',
        providerKind: 'anthropic',
        apiKey: 'test-key',
      });
    }
  });

  it('rejects missing cached source paths on a Pages-only Commander dry run', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await rm(join(root, 'app'), { recursive: true });
    await mkdir(join(root, 'pages'), { recursive: true });
    await writeFile(
      join(root, 'pages/index.tsx'),
      'export default function Page(){ return null }',
      'utf-8',
    );
    const trackedFiles = [
      join(root, '.doklo/cache/web.scan.json'),
      join(root, '.doklo/cache/web.consolidated.json'),
      join(root, '.doklo/hub/roles.json'),
    ];
    const before = await Promise.all(trackedFiles.map((path) => readFile(path, 'utf-8')));

    await expect(runGenerateThroughCommander(root, [
      '--dry-run',
      '--no-roles',
      '--no-ia',
      '--no-code-mapping',
    ])).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await expect(Promise.all(
      trackedFiles.map((path) => readFile(path, 'utf-8')),
    )).resolves.toEqual(before);
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual([]);
  });

  it('preflights role extraction before a paid auto-consolidation call', async () => {
    const root = await tmpInit();
    const rolePreflight = vi.fn(async () => {
      throw new Error('conflicting extracted role kinds');
    });
    const resolveCredentials = vi.fn(async () => ({
      model: 'anthropic/claude-sonnet-5',
      providerKind: 'anthropic' as const,
      apiKey: 'test-key',
    }));
    commandConsolidateMock.mockReset();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), {
      runGenerateDeps: { runRolesRefresh: rolePreflight },
      resolveLlmForRole: resolveCredentials,
    });

    try {
      await expect(
        program.parseAsync(['generate', '--root', root, '--yes'], { from: 'user' }),
      ).rejects.toThrow(/conflicting extracted role kinds/i);
      expect(rolePreflight).toHaveBeenCalledWith({
        root,
        apply: false,
      });
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(commandConsolidateMock).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      commandConsolidateMock.mockReset();
    }
  });

  it('rejects an invalid existing layer before auto-scan, credentials, or paid consolidation', async () => {
    const root = await tmpInit();
    await rm(join(root, '.doklo/cache/web.scan.json'));
    await mkdir(join(root, '.doklo/hub/services/web'), { recursive: true });
    const invalidIa = join(root, '.doklo/hub/services/web/ia.json');
    await writeFile(invalidIa, '{ invalid IA', 'utf-8');
    const resolveCredentials = vi.fn(async () => ({
      model: 'anthropic/claude-sonnet-5',
      providerKind: 'anthropic' as const,
      apiKey: 'test-key',
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);
    commandConsolidateMock.mockReset();

    try {
      await expect(runGenerateThroughCommander(root, [], {
        runGenerateDeps: { generateDokForFeature: generator },
        resolveLlmForRole: resolveCredentials,
      })).rejects.toMatchObject({ name: 'InvalidLayerFileError', outputPath: invalidIa });

      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(commandConsolidateMock).not.toHaveBeenCalled();
      expect(generator).not.toHaveBeenCalled();
      await expect(readFile(join(root, '.doklo/cache/web.scan.json'), 'utf-8')).rejects.toThrow();
      await expect(readFile(join(root, '.doklo/cache/web.consolidated.json'), 'utf-8')).rejects.toThrow();
      expect(await readFile(invalidIa, 'utf-8')).toBe('{ invalid IA');
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('rejects an external code_root symlink before auto-scan can reach credentials or consolidation', async () => {
    const root = await tmpInit();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-gen-command-outside-'));
    await mkdir(join(outside, 'app'), { recursive: true });
    await writeFile(join(outside, 'app/page.tsx'), 'export default () => null;\n', 'utf-8');
    await rm(join(root, '.doklo/cache/web.scan.json'));
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
    await symlink(outside, join(root, 'service'));
    const resolveCredentials = vi.fn(async () => ({
      model: 'anthropic/claude-sonnet-5',
      providerKind: 'anthropic' as const,
      apiKey: 'test-key',
    }));
    commandConsolidateMock.mockReset();

    try {
      await expect(runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        { resolveLlmForRole: resolveCredentials },
      )).rejects.toThrow(/outside|contain|root/i);

      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(commandConsolidateMock).not.toHaveBeenCalled();
      await expect(readFile(join(root, '.doklo/cache/web.scan.json'), 'utf-8')).rejects.toThrow();
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('rejects an external Doks output directory before fresh auto-scan or consolidation', async () => {
    const root = await tmpInit();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-gen-doks-outside-'));
    await rm(join(root, '.doklo/cache/web.scan.json'));
    await rm(join(root, '.doklo/hub/doks'), { recursive: true });
    await symlink(outside, join(root, '.doklo/hub/doks'));
    const resolveCredentials = vi.fn(async () => ({
      model: 'anthropic/claude-sonnet-5',
      providerKind: 'anthropic' as const,
      apiKey: 'test-key',
    }));
    commandConsolidateMock.mockReset();

    try {
      await expect(runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-lexicon', '--no-ia', '--no-code-mapping'],
        { resolveLlmForRole: resolveCredentials },
      )).rejects.toThrow(/outside|contain|root|symlink/i);

      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(commandConsolidateMock).not.toHaveBeenCalled();
      await expect(readFile(join(root, '.doklo/cache/web.scan.json'), 'utf-8')).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('preserves supported auto-consolidation after the credential-free cache preflight', async () => {
    const root = await tmpInit();
    const callOrder: string[] = [];
    commandConsolidateMock.mockReset();
    commandConsolidateMock.mockImplementation(async () => {
      callOrder.push('consolidate');
      return {
        success: true,
        config: makeConsolidatedConfig(['AUTH']),
        prompt: '',
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      };
    });
    const generator = vi.fn(async (_feature, ctx) => {
      callOrder.push('generate');
      return {
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      };
    });
    const resolveCredentials = vi.fn(async () => {
      callOrder.push('resolve');
      return {
        model: 'anthropic/claude-sonnet-5',
        providerKind: 'anthropic' as const,
        apiKey: 'test-key',
      };
    });

    try {
      const outcome = await runGenerateThroughCommander(
        root,
        ['--progress-json', '--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: { generateDokForFeature: generator },
          resolveLlmForRole: resolveCredentials,
        },
      );

      expect(outcome).toMatchObject({ result: { status: 'success' }, exitCode: undefined });
      expect(resolveCredentials).toHaveBeenCalledOnce();
      expect(commandConsolidateMock).toHaveBeenCalledOnce();
      expect(generator).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(['resolve', 'consolidate', 'generate']);
      expect(JSON.parse(
        await readFile(join(root, '.doklo/cache/web.consolidated.json'), 'utf-8'),
      )).toMatchObject({ projectName: 'demo' });
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('streams truthful scan reuse and auto-consolidation progress before generation', async () => {
    const root = await tmpInit();
    commandConsolidateMock.mockReset();
    commandConsolidateMock.mockResolvedValue({
      success: true,
      config: makeConsolidatedConfig(['AUTH']),
      prompt: '',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), {
      runGenerateDeps: {
        generateDokForFeature: async (_feature, ctx) => ({
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        }),
      },
      resolveLlmForRole: async () => ({
        model: 'anthropic/claude-sonnet-5',
        providerKind: 'anthropic',
        apiKey: 'test-key',
      }),
    });
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await program.parseAsync([
        'generate', '--root', root, '--progress-json', '--yes', '--no-lexicon',
        '--no-roles', '--no-ia', '--no-code-mapping',
      ], { from: 'user' });

      const events = chunks.join('').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { stage: string; status?: string; phase?: string; [key: string]: unknown });
      const scan = events.find((event) => event.stage === 'scan');
      const consolidate = events.filter((event) => event.stage === 'consolidate');

      expect(scan).toMatchObject({
        stage: 'scan',
        serviceId: 'web',
        status: 'reused',
        routes: 1,
        components: 0,
      });
      expect(consolidate).toEqual([
        expect.objectContaining({
          stage: 'consolidate', serviceId: 'web', status: 'running', featureGroups: 1,
        }),
        expect.objectContaining({
          stage: 'consolidate', serviceId: 'web', status: 'completed', featureGroups: 1,
        }),
      ]);
      expect(events.map((event) => `${event.stage}:${event.status ?? event.phase ?? ''}`)).toEqual([
        'scan:reused',
        'source-classification:',
        'consent-plan:consolidation',
        'consolidate:running',
        'consolidate:completed',
        'consent-plan:generation',
        'roles:skipped',
        'lexicon:skipped',
        'plan:',
        'dok-start:',
        'dok-done:',
        'ia:skipped',
        'code-mapping:skipped',
        'done:',
      ]);
    } finally {
      process.exitCode = previousExitCode;
      consoleErrorSpy.mockRestore();
      consoleSpy.mockRestore();
      stdoutSpy.mockRestore();
      commandConsolidateMock.mockReset();
    }
  });

  it('streams the complete all-reused pipeline trace with a generation consent phase', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), {
      runGenerateDeps: {
        generateDokForFeature: async (_feature, ctx) => ({
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        }),
      },
      resolveLlmForRole: async () => ({
        model: 'anthropic/claude-sonnet-5',
        providerKind: 'anthropic',
        apiKey: 'test-key',
      }),
    });
    const chunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await program.parseAsync([
        'generate', '--root', root, '--progress-json', '--yes', '--no-lexicon',
        '--no-roles', '--no-ia', '--no-code-mapping',
      ], { from: 'user' });
      const events = chunks.join('').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { stage: string; status?: string; phase?: string });

      expect(events.map((event) => `${event.stage}:${event.status ?? event.phase ?? ''}`)).toEqual([
        'scan:reused',
        'consolidate:reused',
        'consent-plan:generation',
        'roles:skipped',
        'lexicon:skipped',
        'plan:',
        'dok-start:',
        'dok-done:',
        'ia:skipped',
        'code-mapping:skipped',
        'done:',
      ]);
    } finally {
      process.exitCode = previousExitCode;
      consoleErrorSpy.mockRestore();
      consoleSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it('streams the complete fresh preparation trace after consolidation consent', async () => {
    const root = await tmpInit();
    await rm(join(root, '.doklo/cache/web.scan.json'));
    const freshConfig = makeConsolidatedConfig(['AUTH']);
    freshConfig.groups[0]!.features[0]!.members = ['home'];
    freshConfig.groups[0]!.features[0]!.primary_route = '/';
    freshConfig.originalFeatureIds = ['home'];
    commandConsolidateMock.mockReset();
    commandConsolidateMock.mockResolvedValue({
      success: true,
      config: freshConfig,
      prompt: '',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });
    try {
      const events = await captureGenerateProgress(root, [], {
        runGenerateDeps: { generateDokForFeature: stubDeps.generateDokForFeature! },
        resolveLlmForRole: async () => ({ model: 'anthropic/claude-sonnet-5', providerKind: 'anthropic', apiKey: 'test-key' }),
      });
      expect(events.map((event) => `${event.stage}:${event.status ?? event.phase ?? ''}`)).toEqual([
        'source-classification:',
        'consent-plan:consolidation',
        'scan:running',
        'scan:completed',
        'consolidate:running',
        'consolidate:completed',
        'consent-plan:generation',
        'roles:skipped',
        'lexicon:skipped',
        'plan:',
        'dok-start:',
        'dok-done:',
        'ia:skipped',
        'code-mapping:skipped',
        'done:',
      ]);
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('carries an unverified Dok takeover into machine output, not just the console', async () => {
    // Auto-consolidation raised the advisory. Studio and every other --json
    // consumer read the result envelope, so a human-only warning here would
    // leave the takeover invisible on the path most runs actually take.
    const root = await tmpInit();
    commandConsolidateMock.mockReset();
    commandConsolidateMock.mockImplementation(async (
      _features: unknown,
      options?: { onProgress?: (event: { stage: string; dokId: string; canonicalId: string }) => void },
    ) => {
      options?.onProgress?.({
        stage: 'unverified-id-reuse',
        dokId: 'AUTH',
        canonicalId: 'feat-0',
      });
      return {
        success: true,
        config: makeConsolidatedConfig(['AUTH']),
        prompt: '',
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      };
    });

    try {
      const outcome = await runGenerateThroughCommander(root, [], {
        runGenerateDeps: { generateDokForFeature: stubDeps.generateDokForFeature! },
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'anthropic',
          apiKey: 'test-key',
        }),
      });

      expect(outcome.result?.diagnostics).toContainEqual(expect.objectContaining({
        code: 'UNVERIFIED_ID_REUSE',
        serviceId: 'web',
        message: expect.stringContaining('AUTH'),
      }));
      // Advisory only — it must not turn a clean run into a partial one.
      expect(outcome.result?.status).toBe('success');
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('reports only the missing service lifecycle in a mixed-cache workspace', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['WEB']);
    await addNextService(root, 'api');
    const freshConfig = makeConsolidatedConfig(['API']);
    freshConfig.groups[0]!.features[0]!.members = ['home'];
    freshConfig.groups[0]!.features[0]!.primary_route = '/';
    freshConfig.originalFeatureIds = ['home'];
    commandConsolidateMock.mockReset();
    commandConsolidateMock.mockResolvedValue({
      success: true,
      config: freshConfig,
      prompt: '',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });
    try {
      const events = await captureGenerateProgress(root, [], {
        runGenerateDeps: { generateDokForFeature: stubDeps.generateDokForFeature! },
        resolveLlmForRole: async () => ({ model: 'anthropic/claude-sonnet-5', providerKind: 'anthropic', apiKey: 'test-key' }),
      });
      expect(events.filter((event) => event.stage === 'scan' || event.stage === 'consolidate'))
        .toEqual([
          expect.objectContaining({ stage: 'scan', serviceId: 'web', status: 'reused' }),
          expect.objectContaining({ stage: 'consolidate', serviceId: 'web', status: 'reused' }),
          expect.objectContaining({ stage: 'scan', serviceId: 'api', status: 'running' }),
          expect.objectContaining({ stage: 'scan', serviceId: 'api', status: 'completed' }),
          expect.objectContaining({ stage: 'consolidate', serviceId: 'api', status: 'running' }),
          expect.objectContaining({ stage: 'consolidate', serviceId: 'api', status: 'completed' }),
        ]);
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('does not announce a sensitive consolidated cache as reused', async () => {
    const root = await tmpInit();
    const workspace = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf-8')) as { services: Array<{ service_id: string }> };
    workspace.services[0]!.service_id = 'secrets';
    await writeFile(join(root, 'workspace.json'), JSON.stringify(workspace), 'utf-8');
    await writeScanIr(root, 'secrets', {
      files: ['app/page.tsx'],
      routes: [{ path: '/', kind: 'page', file: 'app/page.tsx', dynamic_params: [], layout_chain: [] }],
    });
    await writeConsolidated(root, 'secrets', ['SECRET']);

    const events = await captureGenerateProgress(root, []);
    expect(events).toContainEqual(expect.objectContaining({
      stage: 'consolidate', serviceId: 'secrets', status: 'skipped',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      stage: 'consolidate', serviceId: 'secrets', status: 'reused',
    }));
  });

  it('rejects an external scan-cache symlink before emitting reused progress', async () => {
    const root = await tmpInit();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-external-cache-'));
    const externalCache = join(outside, 'web.scan.json');
    await writeFile(externalCache, JSON.stringify({
      framework: 'nextjs', root, files: [], routes: [], components: [], stores: [], role_signals: [],
    }), 'utf-8');
    await rm(join(root, '.doklo/cache/web.scan.json'));
    await symlink(externalCache, join(root, '.doklo/cache/web.scan.json'));

    const outcome = await captureGenerateProgressFailure(root, []);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.events).not.toContainEqual(expect.objectContaining({
      stage: 'scan', serviceId: 'web', status: 'reused',
    }));
  });

  it('completes only started services when the second consolidation fails', async () => {
    const root = await tmpInit();
    await addNextService(root, 'api');
    await writeScanIr(root, 'api', {
      files: ['app/page.tsx'],
      routes: [{ path: '/', kind: 'page', file: 'app/page.tsx', dynamic_params: [], layout_chain: [] }],
    });
    commandConsolidateMock.mockReset();
    commandConsolidateMock
      .mockResolvedValueOnce({
        success: true,
        config: makeConsolidatedConfig(['WEB']),
        prompt: '',
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'provider failed for api',
        prompt: '',
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
      });
    try {
      const outcome = await captureGenerateProgressFailure(root, [], {
        resolveLlmForRole: async () => ({ model: 'anthropic/claude-sonnet-5', providerKind: 'anthropic', apiKey: 'test-key' }),
      });
      expect(outcome.error).toMatchObject({
        message: 'Consolidation failed for service "api": provider failed for api',
      });
      expect(outcome.events.filter((event) => event.stage === 'consolidate')).toEqual([
        expect.objectContaining({ serviceId: 'web', status: 'running' }),
        expect.objectContaining({ serviceId: 'web', status: 'completed' }),
        expect.objectContaining({ serviceId: 'api', status: 'running' }),
      ]);
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('does not report consolidation complete when its output cache is invalid', async () => {
    const root = await tmpInit();
    const invalid = makeConsolidatedConfig(['AUTH']);
    invalid.groups[0]!.features[0]!.metadata = null as never;
    commandConsolidateMock.mockReset();
    commandConsolidateMock.mockResolvedValueOnce({
      success: true,
      config: invalid,
      prompt: '',
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
    });

    try {
      const outcome = await captureGenerateProgressFailure(root, [], {
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'anthropic',
          apiKey: 'test-key',
        }),
      });

      expect(outcome.error).toMatchObject({ name: 'InvalidConsolidationOutputError' });
      expect(outcome.events.filter((event) => event.stage === 'consolidate')).toEqual([
        expect.objectContaining({ serviceId: 'web', status: 'running' }),
      ]);
    } finally {
      commandConsolidateMock.mockReset();
    }
  });

  it('approves the visible immutable plan before any paid generate worker', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const order: string[] = [];
    const generator = vi.fn(async (_feature, ctx) => {
      order.push('generate');
      return {
        success: true,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: null,
      };
    });
    const authorize = vi.fn(async (...args: Parameters<typeof authorizeLlmRun>) => {
      expect(generator).not.toHaveBeenCalled();
      order.push('approve');
      return authorizeLlmRun(...args);
    });

    await runGenerateThroughCommander(
      root,
      ['--no-roles', '--no-ia', '--no-code-mapping'],
      {
        runGenerateDeps: { generateDokForFeature: generator },
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'anthropic',
          authSource: 'keychain',
          apiKey: 'test-key',
        }),
        authorizeLlmRun: authorize,
      } as never,
    );

    expect(order).toEqual(['approve', 'generate']);
  });

  it('does not create a fresh scan cache before approving its first paid plan', async () => {
    const root = await tmpInit();
    const scanPath = join(root, '.doklo/cache/web.scan.json');
    await rm(scanPath);
    let cacheExistedAtApproval: boolean | undefined;
    const authorize = vi.fn(async () => {
      try {
        await readFile(scanPath, 'utf8');
        cacheExistedAtApproval = true;
      } catch {
        cacheExistedAtApproval = false;
      }
      throw new Error('stop after approval observation');
    });

    await expect(runGenerateThroughCommander(
      root,
      ['--no-roles', '--no-ia', '--no-code-mapping'],
      {
        resolveLlmForRole: async () => ({
          model: 'anthropic/claude-sonnet-5',
          providerKind: 'anthropic',
          authSource: 'keychain',
          apiKey: 'test-key',
        }),
        authorizeLlmRun: authorize as never,
      },
    )).rejects.toThrow(/stop after approval observation/);

    expect(cacheExistedAtApproval).toBe(false);
  });

  it('keeps automatic lexicon calls out of the generation plan', async () => {
    const root = await tmpInit();
    await writeConsolidatedWithFiles(root, 'web', 'AUTH', ['app/page.tsx']);
    await mkdir(join(root, 'messages'), { recursive: true });
    await writeFile(join(root, 'messages/en.json'), JSON.stringify({ title: 'Domain term' }));
    let approvedPlan: unknown;
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), {
      resolveLlmForRole: async () => ({
        model: 'anthropic/claude-sonnet-5',
        providerKind: 'anthropic',
        authSource: 'keychain',
        apiKey: 'test-key',
      }),
      authorizeLlmRun: (async (_root: string, plan: unknown) => {
        approvedPlan = plan;
        throw new Error('stop after combined plan');
      }) as never,
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      await expect(program.parseAsync([
        'generate', '--root', root, '--yes', '--no-roles', '--no-ia', '--no-code-mapping',
      ], { from: 'user' })).rejects.toThrow(/stop after combined plan/);
    } finally {
      stdoutSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(approvedPlan).toMatchObject({
      calls: { lexicon: 0 },
    });
    expect((approvedPlan as { transmissions: Array<{ phase: string }> }).transmissions
      .some((source) => source.phase === 'lexicon')).toBe(false);
  });

  it.each([
    ['--no-roles', 'roles', ['ia', 'codeMapping']],
    ['--no-ia', 'ia', ['roles', 'codeMapping']],
    ['--no-code-mapping', 'codeMapping', ['roles', 'ia']],
  ] as const)(
    'forwards %s through Commander to the actual runGenerate pipeline',
    async (flag, disabledCall, enabledCalls) => {
      const root = await tmpInit();
      await writeConsolidated(root, 'web', ['AUTH']);
      await writeFile(
        join(root, '.doklo/hub/doks/AUTH.json'),
        JSON.stringify(makeDok('AUTH')),
        'utf-8',
      );
      const roles = vi.fn(async () => ({
        candidates: [], added: [], kept: [], skipped: [], written: false,
      }));
      const ia = vi.fn((ctx: Parameters<GenerateDeps['deriveIA']>[0]) =>
        emptyDerivedRouteHierarchy(ctx.serviceId));
      const codeMapping = vi.fn(async (ctx: Parameters<GenerateDeps['deriveCodeMapping']>[0]) =>
        ServiceCodeMappingFileSchema.parse({ service_id: ctx.serviceId, entries: [], version: 1 }));
      const calls = { roles, ia, codeMapping };

      const outcome = await runGenerateThroughCommander(root, [flag], {
        runGenerateDeps: {
          generateDokForFeature: async () => {
            throw new Error('pre-existing Dok must not invoke generation');
          },
          runRolesRefresh: roles,
          deriveIA: ia,
          deriveCodeMapping: codeMapping,
        },
        resolveLlmForRole: async () => {
          throw new Error('zero-Dok flag forwarding must not resolve credentials');
        },
      });

      expect(outcome).toMatchObject({ result: { status: 'success' }, exitCode: undefined });
      expect(calls[disabledCall]).not.toHaveBeenCalled();
      for (const enabledCall of enabledCalls) {
        expect(calls[enabledCall]).toHaveBeenCalledOnce();
      }
    },
  );

  it('keeps --no-lexicon disabled during the Commander preview preflight', async () => {
    const root = await tmpInit();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-gen-lexicon-outside-'));
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );
    await symlink(
      join(outside, 'lexicon.json'),
      join(root, '.doklo/hub/lexicon.json'),
    );

    const outcome = await runGenerateThroughCommander(root, [], {
      runGenerateDeps: {
        generateDokForFeature: async () => {
          throw new Error('pre-existing Dok must not invoke generation');
        },
      },
      resolveLlmForRole: async () => {
        throw new Error('zero-Dok run must not resolve credentials');
      },
    });

    expect(outcome).toMatchObject({ result: { status: 'success' }, exitCode: undefined });
    await expect(readFile(join(outside, 'lexicon.json'), 'utf-8')).rejects.toThrow();
  });

  it('requires --yes in non-TTY mode before LLM resolution or Hub mutation', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const resolveCredentials = vi.fn(async () => ({
      model: 'anthropic/claude-sonnet-5',
      providerKind: 'anthropic' as const,
      apiKey: 'test-key',
    }));
    const generator = vi.fn(stubDeps.generateDokForFeature!);
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), {
      runGenerateDeps: { generateDokForFeature: generator },
      resolveLlmForRole: resolveCredentials,
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      await expect(
        program.parseAsync(
          [
            'generate',
            '--root', root,
            '--no-lexicon',
            '--no-roles',
            '--no-ia',
            '--no-code-mapping',
          ],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({
        exitCode: 2,
        result: {
          command: 'generate',
          status: 'cancelled',
        },
      });
      expect(resolveCredentials).not.toHaveBeenCalled();
      expect(generator).not.toHaveBeenCalled();
      await expect(
        readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8'),
      ).rejects.toThrow();
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      consoleSpy.mockRestore();
    }
  });

  it('reports an actionable cap error when no Dok can fit without invoking the provider', async () => {
    vi.stubEnv('DOKLO_MAX_TOKENS_PER_RUN', '1');
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const generator = vi.fn(stubDeps.generateDokForFeature!);
    try {
      await expect(runGenerateThroughCommander(root, [], {
        runGenerateDeps: { generateDokForFeature: generator },
        resolveLlmForRole: async () => ({ model: 'anthropic/claude-sonnet-5', providerKind: 'anthropic', apiKey: 'test-key' }),
      })).rejects.toMatchObject({ result: { diagnostics: [
        expect.objectContaining({ code: 'LLM_RUN_TOKEN_CAP', message: expect.stringContaining('DOKLO_MAX_TOKENS_PER_RUN') }),
      ] } });
      expect(generator).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it('shows the selected batch count instead of the original 60-Dok plan', async () => {
    vi.stubEnv('DOKLO_MAX_TOKENS_PER_RUN', '500000');
    const root = await tmpInit();
    await writeConsolidated(root, 'web', Array.from({ length: 60 }, (_, i) => `FEATURE-${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`));
    const generator = vi.fn(async (_feature, ctx) => ({
      success: true, dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '', rawResponse: '', usage: { input_tokens: 100, output_tokens: 50 },
    }));
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), {
      runGenerateDeps: { generateDokForFeature: generator },
      resolveLlmForRole: async () => ({ model: 'anthropic/claude-sonnet-5', providerKind: 'anthropic', apiKey: 'test-key' }),
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    try {
      await program.parseAsync(['generate', '--root', root, '--yes', '--no-lexicon', '--no-roles', '--no-ia', '--no-code-mapping'], { from: 'user' });
      const count = generator.mock.calls.length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(60);
      const output = logs.join('\n');
      expect(output).toContain(`This run: ${count} Dok(s)`);
      expect(output).not.toContain('This run: 60');
      expect(output).toContain(`${60 - count} deferred`);
      expect(output).toContain('estimated input');
      expect(output).not.toContain('~$');
    } finally {
      vi.unstubAllEnvs(); spy.mockRestore(); }
  });

  it('publishes a partial result without mutating process.exitCode for a Dok failure', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    commandGenerateDokMock.mockReset();
    commandGenerateDokMock.mockImplementation(async (_feature, ctx) => ({
      success: true,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: null,
    }));
    const failedGenerator = vi.fn(async () => ({
      success: false as const,
      dok: null,
      prompt: '',
      rawResponse: '',
      usage: { input_tokens: 100, output_tokens: 50 },
      error: 'intentional Commander Dok failure',
    }));

    try {
      const outcome = await runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: { generateDokForFeature: failedGenerator },
          resolveLlmForRole: async () => ({
            model: 'anthropic/claude-sonnet-5',
            providerKind: 'anthropic',
            apiKey: 'test-key',
          }),
        },
      );

      expect(failedGenerator).toHaveBeenCalledOnce();
      expect(outcome.result?.data).toMatchObject({
        tokenUsage: { attemptedCalls: 1, measuredCalls: 1, missingCalls: 0,
          actual: { inputTokens: 100, outputTokens: 50 } },
      });
      const ledger = JSON.parse(await readFile(join(root, '.doklo/cache/llm-token-ledger.json'), 'utf-8'));
      expect(ledger.calls[0]).toMatchObject({ state: 'settled' });
      expect(outcome).toMatchObject({
        exitCode: undefined,
        result: {
          status: 'partial',
          diagnostics: [
            expect.objectContaining({ code: 'DOK_GENERATION_FAILED' }),
          ],
        },
      });
    } finally {
      commandGenerateDokMock.mockReset();
    }
  });

  it('publishes a partial result without mutating process.exitCode for a layer failure', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );
    const failedIa = vi.fn(() => {
      throw new Error('intentional Commander IA failure');
    });

    const outcome = await runGenerateThroughCommander(
      root,
      ['--no-roles', '--no-code-mapping'],
      {
        runGenerateDeps: {
          generateDokForFeature: async () => {
            throw new Error('pre-existing Dok must not invoke generation');
          },
          deriveIA: failedIa,
        },
        resolveLlmForRole: async () => {
          throw new Error('zero-Dok layer failure must not resolve credentials');
        },
      },
    );

    expect(failedIa).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      exitCode: undefined,
      result: {
        status: 'partial',
        diagnostics: [
          expect.objectContaining({ code: 'LAYER_GENERATION_FAILED' }),
        ],
      },
    });
  });

  it('registers deterministic-layer flags and runs zero-Dok layers without resolving credentials', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(makeDok('AUTH')),
      'utf-8',
    );
    const program = new Command();
    registerGenerateCommand(program, createContext('en'));
    const command = program.commands.find((candidate) => candidate.name() === 'generate');
    expect(command?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--no-roles', '--no-ia', '--no-code-mapping', '--json', '--yes']),
    );

    resolveLlmForRoleMock.mockClear();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(['generate', '--root', root, '--yes'], { from: 'user' });
      expect(resolveLlmForRoleMock).not.toHaveBeenCalled();
      expect(IaFileV2Schema.parse(
        JSON.parse(await readFile(join(root, '.doklo/hub/services/web/ia.json'), 'utf-8')),
      ).service_id).toBe('web');
      expect(ServiceCodeMappingFileSchema.parse(
        JSON.parse(await readFile(join(root, '.doklo/hub/services/web/code-mapping.json'), 'utf-8')),
      ).service_id).toBe('web');
    } finally {
      process.exitCode = previousExitCode;
      consoleSpy.mockRestore();
    }
  });

  it.each([
    ['zero-Dok', true],
    ['nonzero-Dok', false],
  ] as const)('keeps --progress-json stdout JSONL-only for a %s flow', async (_label, preexisting) => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    if (preexisting) {
      await writeFile(
        join(root, '.doklo/hub/doks/AUTH.json'),
        JSON.stringify(makeDok('AUTH')),
        'utf-8',
      );
    }

    commandGenerateDokMock.mockReset();
    commandGenerateDokMock.mockImplementation(async (_feature, ctx) => ({
      success: true,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: null,
    }));
    resolveLlmForRoleMock.mockClear();
    const program = new Command();
    registerGenerateCommand(program, createContext('en'));
    const humanStdout: string[] = [];
    const jsonStdout: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      humanStdout.push(args.map(String).join(' '));
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      jsonStdout.push(String(chunk));
      return true;
    }) as never);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await program.parseAsync(
        ['generate', '--root', root, '--progress-json', '--yes', '--no-lexicon'],
        { from: 'user' },
      );
      const result = takeCommandResult(program);
      expect(result).toBeDefined();
      emitCommandResult(result!, {
        machine: true,
        stdout: process.stdout,
        stderr: process.stderr,
      });
      expect(humanStdout).toEqual([]);
      const lines = jsonStdout.join('').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(JSON.parse(line)).toHaveProperty('stage');
      }
      const parsed = lines.map((line) => JSON.parse(line) as { stage: string });
      expect(parsed.filter((line) => line.stage === 'result')).toHaveLength(1);
      expect(parsed.at(-1)).toMatchObject({
        stage: 'result',
        result: { status: 'success' },
      });
    } finally {
      process.exitCode = previousExitCode;
      stdoutSpy.mockRestore();
      consoleSpy.mockRestore();
      commandGenerateDokMock.mockReset();
    }
  });

  it('turns SIGINT into one resumable cancelled result and removes its listener', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    const baselineListeners = new Set(process.rawListeners('SIGINT'));
    let calls = 0;
    const generator = vi.fn(async (_feature, ctx, options) => {
      calls += 1;
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (calls === 2) {
        const actionListeners = process.rawListeners('SIGINT')
          .filter((listener) => !baselineListeners.has(listener));
        expect(actionListeners).toHaveLength(1);
        (actionListeners[0] as () => void)();
        await Promise.resolve();
        return {
          success: false as const,
          dok: null,
          prompt: '',
          rawResponse: null,
          usage: null,
          interrupted: true,
          error: 'Generation interrupted.',
        };
      }
      return {
        success: true as const,
        dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
        prompt: '',
        rawResponse: '',
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    });

    try {
      await expect(runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: { generateDokForFeature: generator },
          resolveLlmForRole: async () => ({
            model: 'anthropic/claude-sonnet-5',
            providerKind: 'anthropic',
            apiKey: 'test-key',
          }),
        },
      )).rejects.toMatchObject({
        exitCode: 130,
        result: {
          command: 'generate',
          status: 'cancelled',
          data: {
            interrupted: true,
            results: [expect.objectContaining({ dokId: 'AUTH' })],
          },
          diagnostics: [{
            code: 'GENERATION_INTERRUPTED',
            retryable: true,
            preserved: ['.doklo/hub/doks/AUTH.json'],
            nextCommand: 'doklo generate --yes',
          }],
        },
      });
      expect(generator).toHaveBeenCalledTimes(2);
    } finally {
      expect(new Set(process.rawListeners('SIGINT'))).toEqual(baselineListeners);
    }
  });

  it('cancels a late SIGINT after final post-processing without relabeling completed work', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH']);
    const baselineListeners = new Set(process.rawListeners('SIGINT'));
    let activeNowCalls = 0;
    let signalSent = false;
    const now = () => {
      const actionListeners = process.rawListeners('SIGINT')
        .filter((listener) => !baselineListeners.has(listener));
      if (actionListeners.length === 1) {
        activeNowCalls += 1;
        if (activeNowCalls === 2) {
          signalSent = true;
          (actionListeners[0] as () => void)();
        }
      }
      return `tick-${activeNowCalls}`;
    };
    const generator = vi.fn(async (_feature, ctx) => ({
      success: true as const,
      dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
      prompt: '',
      rawResponse: '',
      usage: { input_tokens: 10, output_tokens: 20 },
    }));

    try {
      await expect(runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: { generateDokForFeature: generator, now },
          resolveLlmForRole: async () => ({
            model: 'anthropic/claude-sonnet-5',
            providerKind: 'anthropic',
            authSource: 'keychain',
            apiKey: 'test-key',
          }),
        },
      )).rejects.toMatchObject({
        exitCode: 130,
        result: {
          status: 'cancelled',
          data: { interrupted: true },
          diagnostics: [{ code: 'GENERATION_INTERRUPTED' }],
        },
      });
      expect(signalSent).toBe(true);
      expect(JSON.parse(await readFile(
        join(root, '.doklo/hub/doks/AUTH.json'),
        'utf8',
      ))).toMatchObject({ dok_id: 'AUTH' });
      const ledger = JSON.parse(await readFile(
        join(root, '.doklo/cache/generation-ledger.json'),
        'utf8',
      )) as { entries: Array<{ dokId: string; status: string; reasonCode: string }> };
      expect(ledger.entries).toEqual([
        expect.objectContaining({
          dokId: 'AUTH',
          status: 'success',
          reasonCode: 'GENERATED',
        }),
      ]);
    } finally {
      expect(new Set(process.rawListeners('SIGINT'))).toEqual(baselineListeners);
    }
  });

  it('removes the per-action SIGINT listener after success and thrown failures', async () => {
    const baselineListeners = new Set(process.rawListeners('SIGINT'));
    for (const outcome of ['success', 'failure'] as const) {
      const root = await tmpInit();
      await writeConsolidated(root, 'web', ['AUTH']);
      const generator = vi.fn(async (_feature, ctx, options) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(process.rawListeners('SIGINT')
          .filter((listener) => !baselineListeners.has(listener))).toHaveLength(1);
        if (outcome === 'failure') throw new Error('terminal generation failure');
        return {
          success: true as const,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      });
      const invocation = runGenerateThroughCommander(
        root,
        ['--no-roles', '--no-ia', '--no-code-mapping'],
        {
          runGenerateDeps: { generateDokForFeature: generator },
          resolveLlmForRole: async () => ({
            model: 'anthropic/claude-sonnet-5',
            providerKind: 'anthropic',
            apiKey: 'test-key',
          }),
        },
      );
      if (outcome === 'success') await expect(invocation).resolves.toBeDefined();
      else await expect(invocation).rejects.toThrow('terminal generation failure');
      expect(new Set(process.rawListeners('SIGINT'))).toEqual(baselineListeners);
    }
  });
});

// ── Priority injection ────────────────────────────────────────────────────
//
// Detection and merge are unit-tested in packages/generator. What only this
// level can prove is that generate calls them: signals stamped from the drift
// file set, a pinned axis surviving regeneration, and the pin reaching the
// prompt so the model is never asked about it in the first place.
describe('generate — Dok priority', () => {
  const MONEY_MODEL =
    'const OrderSchema = new Schema({\n  amount: { type: Number, required: true },\n});\n';

  /** Stub LLM returning a Dok whose priority the test controls. */
  function depsWithPriority(
    priority: { impact?: string; blast_radius?: string } | undefined,
    onCtx?: (ctx: { lockedPriority?: unknown }) => void,
  ): Partial<GenerateDeps> {
    return {
      generateDokForFeature: async (_f, ctx) => {
        onCtx?.(ctx as { lockedPriority?: unknown });
        const dok = JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as Record<string, unknown>;
        if (priority !== undefined) {
          dok.priority = { impact: 'enabling', blast_radius: 'degrading', ...priority };
        }
        return { success: true, dok: dok as never, prompt: '', rawResponse: '', usage: null };
      },
    };
  }

  async function moneyProject(): Promise<string> {
    const root = await tmpInit();
    await mkdir(join(root, 'models'), { recursive: true });
    await writeFile(join(root, 'models/order.model.ts'), MONEY_MODEL, 'utf-8');
    await writeConsolidatedWithFiles(root, 'web', 'PAYMENT', [
      'app/page.tsx',
      'models/order.model.ts',
    ]);
    return root;
  }

  async function readPriority(root: string): Promise<Record<string, unknown> | undefined> {
    const dok = JSON.parse(
      await readFile(join(root, '.doklo/hub/doks/PAYMENT.json'), 'utf8'),
    ) as { priority?: Record<string, unknown> };
    return dok.priority;
  }

  it('stamps money-model evidence over the Dok source files', async () => {
    const root = await moneyProject();
    const result = await runGenerate(
      { root, noLexicon: true },
      depsWithPriority({ impact: 'revenue' }),
    );
    expect(result.failures).toHaveLength(0);

    const priority = await readPriority(root);
    expect(priority?.impact).toBe('revenue');
    expect(priority?.signals).toEqual([
      { file: 'models/order.model.ts', start_line: 2, detector: 'money-model' },
    ]);
  });

  it('leaves priority absent when the model did not judge', async () => {
    // No axes means no judgment to hang evidence on. Absent reads as "not
    // judged", which is honest — inventing an axis to carry signals would be
    // exactly the unverifiable claim this field exists to prevent.
    const root = await moneyProject();
    await runGenerate({ root, noLexicon: true }, depsWithPriority(undefined));
    expect(await readPriority(root)).toBeUndefined();
  });

  it('keeps a pinned axis and re-derives signals on regeneration', async () => {
    const root = await moneyProject();
    await runGenerate({ root, noLexicon: true }, depsWithPriority({ impact: 'revenue' }));

    // A person pins impact, with a reason, and the file carries a stale signal
    // the next run must NOT carry forward.
    const dokPath = join(root, '.doklo/hub/doks/PAYMENT.json');
    const pinned = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
    pinned.priority = {
      impact: 'revenue',
      blast_radius: 'degrading',
      signals: [{ file: 'gone.ts', detector: 'money-model' }],
      curated: { impact: { reason: 'settlement API is called from this screen' } },
    };
    await writeFile(dokPath, JSON.stringify(pinned, null, 2), 'utf-8');

    // The model now says supporting/cosmetic. The pin must win on impact only.
    await runGenerate(
      { root, force: true, noLexicon: true },
      depsWithPriority({ impact: 'supporting', blast_radius: 'cosmetic' }),
    );

    const after = await readPriority(root);
    expect(after?.impact).toBe('revenue');
    expect((after?.curated as Record<string, { reason: string }>).impact.reason)
      .toBe('settlement API is called from this screen');
    // The unpinned axis took the fresh judgment.
    expect(after?.blast_radius).toBe('cosmetic');
    // Evidence was re-derived, not carried: the dead anchor is gone.
    expect(after?.signals).toEqual([
      { file: 'models/order.model.ts', start_line: 2, detector: 'money-model' },
    ]);
  });

  it('tells the prompt about a pinned axis so the model is never asked', async () => {
    const root = await moneyProject();
    await runGenerate({ root, noLexicon: true }, depsWithPriority({ impact: 'revenue' }));

    const dokPath = join(root, '.doklo/hub/doks/PAYMENT.json');
    const pinned = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
    pinned.priority = {
      impact: 'revenue',
      blast_radius: 'degrading',
      signals: [],
      curated: { impact: { reason: 'settlement API is called from this screen' } },
    };
    await writeFile(dokPath, JSON.stringify(pinned, null, 2), 'utf-8');

    const seen: unknown[] = [];
    await runGenerate(
      { root, force: true, noLexicon: true },
      depsWithPriority({ impact: 'supporting' }, (ctx) => { seen.push(ctx.lockedPriority); }),
    );

    expect(seen[0]).toEqual([
      { field: 'impact', value: 'revenue', reason: 'settlement API is called from this screen' },
    ]);
  });
});

describe('generation tracking trust', () => {
  async function trackingFixture() {
    const root = await tmpInit();
    await writeFile(join(root, 'app/Child.tsx'), 'export default function Child(){ return null; }');
    const config = makeConsolidatedConfig(['UPLOAD']);
    const feature = config.groups[0]!.features[0]!;
    feature.canonical_id = 'home'; feature.members = ['home']; feature.primary_route = '/';
    config.originalFeatureIds = ['home'];
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(config));
    await writeScanIr(root, 'web', {
      files: ['app/page.tsx', 'app/Child.tsx'],
      routes: [{ path: '/', kind: 'page', file: 'app/page.tsx', layout_chain: [], dynamic_params: [] }],
      framework_specific: { import_graph_tracking_version: 2,
        import_graph: { 'app/page.tsx': ['app/Child.tsx'], 'app/Child.tsx': [] },
        file_ledger: ['app/page.tsx', 'app/Child.tsx'].map(file => ({ file, status: 'processed', stages: ['discovery', 'import-graph'], reason: 'OK' })) },
    });
    return root;
  }

  it('rebuilds legacy consolidated mappings from validated IR before trusting generation', async () => {
    const root = await trackingFixture();
    const old = makeDok('UPLOAD') as any;
    old._meta.tracking_version = 2; old._meta.tracking_review_required = true;
    await writeFile(join(root, '.doklo/hub/doks/UPLOAD.json'), JSON.stringify(old));
    await runGenerate({ root, force: true }, stubDeps);
    const dok = JSON.parse(await readFile(join(root, '.doklo/hub/doks/UPLOAD.json'), 'utf8'));
    expect(dok._meta.logic_files).toEqual([{ file: 'app/page.tsx' }, { file: 'app/Child.tsx' }]);
    expect(dok._meta.tracking_version).toBe(2);
    expect(dok._meta.tracking_review_required).toBeUndefined();
  });

  it('does not trust partial reads or clear an existing tracking review requirement', async () => {
    const root = await trackingFixture();
    const old = makeDok('UPLOAD') as any;
    old._meta.tracking_version = 2; old._meta.tracking_review_required = true;
    await writeFile(join(root, '.doklo/hub/doks/UPLOAD.json'), JSON.stringify(old));
    const result = await runGenerate({ root, force: true }, {
      generateDokForFeature: async (_feature, ctx) => {
        await rm(join(root, 'app/Child.tsx'));
        return { success: true, dok: makeDok(ctx.dokId) as never, prompt: '', rawResponse: '', usage: null };
      },
    });
    const dok = JSON.parse(await readFile(join(root, '.doklo/hub/doks/UPLOAD.json'), 'utf8'));
    expect(result.results).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(dok).toEqual(old);
    expect(dok._meta.tracking_review_required).toBe(true);
  });
});

it('generates from Python source and detects an edit without a framework parser', async () => {
  const root = await tmpInit();
  await rm(join(root, 'app'), { recursive: true });
  await rm(join(root, 'package.json'));
  await writeFile(join(root, 'main.py'), 'def run(): return 1');
  const { runScan } = await import('../src/commands/scan.js');
  const scan = await runScan({ root });
  const unit = scan.results[0]!.ir.analysis_units![0]!;
  await writeConsolidatedWithFiles(root, 'web', 'PYTHON', unit.files);
  const cachePath = join(root, '.doklo/cache/web.consolidated.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  cache.originalFeatureIds = [unit.id];
  Object.assign(cache.groups[0].features[0], { canonical_id: unit.id, members: [unit.id], primary_route: '' });
  await writeFile(cachePath, JSON.stringify(cache));
  const result = await runGenerate({ root, noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true }, stubDeps);
  expect(result.failures).toEqual([]);
  const dokFile = (await readdir(join(root, '.doklo/hub/doks'))).find(file => file.endsWith('.json'))!;
  const dok = JSON.parse(await readFile(join(root, '.doklo/hub/doks', dokFile), 'utf8'));
  expect(dok._meta.source_anchors).toContainEqual({ file: 'main.py' });
  expect(isDokStale(dok, root)).toEqual({ stale: false });
  await writeFile(join(root, 'main.py'), 'def run(): return 2');
  expect(isDokStale(dok, root)).toEqual({ stale: true, reason: 'changed' });
});

// A stale cache must not reintroduce private material through drift hashing.
it('keeps sensitive cached logic files out of generated tracking metadata', async () => {
  const root = await tmpInit();
  await writeFixtureFiles(root, ['src/notices.ts', 'AuthKey.p8']);
  await writeConsolidatedWithLogicFiles(root, 'web', [{ prefix: 'NOTICE', route: '',
    source_files: ['src/notices.ts'], logic_files: ['src/notices.ts', 'AuthKey.p8'],
  }]);
  await runGenerate({ root, noLexicon: true }, stubDeps);
  const dok = JSON.parse(await readFile(join(root, '.doklo/hub/doks/NOTICE.json'), 'utf8'));
  expect(dok._meta.logic_files).toEqual([{ file: 'src/notices.ts' }]);
});

describe('bounded generation recovery', () => {
  it('recovers malformed JSON with an approved identical prompt and accounts for extra usage', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    const existingPath = join(root, '.doklo/hub/doks/AUTH.json');
    await writeFile(existingPath, JSON.stringify(makeDok('AUTH', 'Human edited')));
    const before = await readFile(existingPath);
    let attempt = 0;
    const prompts: unknown[] = [];
    const outcome = await runGenerateThroughCommander(root,
      ['--retries', '1', '--no-roles', '--no-ia', '--no-code-mapping'], {
        runGenerateDeps: { generateDokForFeature: async (_feature, context, options) => {
          prompts.push(options?.preparedPrompt);
          attempt++;
          return attempt === 1
            ? { success: false, dok: null, prompt: '', rawResponse: '{bad}', usage: { input_tokens: 11, output_tokens: 7 }, error: 'Failed to parse Dok JSON' }
            : { success: true, dok: makeDok(context.dokId) as never, prompt: '', rawResponse: '{}', usage: { input_tokens: 13, output_tokens: 9 } };
        } },
      });
    expect(outcome.result).toMatchObject({ status: 'success', data: {
      results: [{ dokId: 'USER', attempts: 2 }],
      retryTokenUsage: { attemptedCalls: 1, actual: { inputTokens: 13, outputTokens: 9 } },
      tokenUsage: { attemptedCalls: 2, actual: { inputTokens: 24, outputTokens: 16 } },
    } });
    expect(prompts[1]).toEqual(prompts[0]);
    expect(await readFile(existingPath)).toEqual(before);
    expect(JSON.parse(await readFile(join(root, '.doklo/hub/doks/USER.json'), 'utf8')).status).toBe('draft');
  });

  it('stops repeated malformed responses and emits only-failed resume instructions', async () => {
    const root = await tmpInit();
    await writeConsolidated(root, 'web', ['AUTH', 'USER']);
    const outcome = await runGenerateThroughCommander(root,
      ['--only', 'USER', '--retries', '2', '--no-roles', '--no-ia', '--no-code-mapping'], {
        runGenerateDeps: { generateDokForFeature: async () => ({
          success: false, dok: null, prompt: '', rawResponse: '{bad}',
          usage: { input_tokens: 11, output_tokens: 7 }, error: 'Failed to parse Dok JSON',
        }) },
      });
    expect(outcome.result).toMatchObject({ status: 'partial', data: {
      failures: [{ dokId: 'USER', attempts: 3, code: 'DOK_RESPONSE_MALFORMED', nextCommand: 'doklo generate --only USER --yes' }],
      tokenUsage: { attemptedCalls: 3 }, retryTokenUsage: { attemptedCalls: 2 },
    } });
    expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual([]);
  });
});

it('stops before reserving a recovery attempt when cancelled by retry progress', async () => {
  const root = await tmpInit();
  await writeConsolidated(root, 'web', ['AUTH']);
  const controller = new AbortController();
  const result = await runGenerate({
    root, retries: 1, noRoles: true, noIa: true, noCodeMapping: true,
    signal: controller.signal,
    onProgress: (event) => { if (event.stage === 'dok-retry') controller.abort(); },
  }, { generateDokForFeature: async () => ({
    success: false, dok: null, prompt: '', rawResponse: '{bad}', usage: null, error: 'Malformed',
  }) });
  expect(result).toMatchObject({ interrupted: true, tokenUsage: { attemptedCalls: 1, missingCalls: 1 } });
  expect(await readdir(join(root, '.doklo/hub/doks'))).toEqual([]);
});

it('accounts for an aborted contacted retry as missing usage in both summaries', async () => {
  const root = await tmpInit();
  await writeConsolidated(root, 'web', ['AUTH']);
  let attempt = 0;
  await expect(runGenerateThroughCommander(root, ['--no-roles', '--no-ia', '--no-code-mapping'], {
    runGenerateDeps: { generateDokForFeature: async () => {
      attempt++;
      if (attempt === 2) {
        process.emit('SIGINT');
        throw new Error('Provider aborted');
      }
      return { success: false, dok: null, prompt: '', rawResponse: '{bad}',
        usage: { input_tokens: 11, output_tokens: 7 }, error: 'Malformed' };
    } },
  })).rejects.toMatchObject({ result: { data: {
    interrupted: true,
    tokenUsage: { attemptedCalls: 2, measuredCalls: 1, missingCalls: 1 },
    retryTokenUsage: { attemptedCalls: 1, measuredCalls: 0, missingCalls: 1 },
  } } });
  const ledger = JSON.parse(await readFile(join(root, '.doklo/cache/llm-token-ledger.json'), 'utf8'));
  expect(ledger.calls.map((call: { state: string }) => call.state)).toEqual(['settled', 'retained']);
});

it('offers explicitly scoped forced recovery and preserves other human-edited Doks', async () => {
  const root = await tmpInit();
  await writeConsolidated(root, 'web', ['AUTH', 'USER']);
  for (const id of ['AUTH', 'USER']) await writeFile(join(root, `.doklo/hub/doks/${id}.json`), JSON.stringify(makeDok(id, `Human ${id}`)));
  const authBefore = await readFile(join(root, '.doklo/hub/doks/AUTH.json'));
  const userBefore = await readFile(join(root, '.doklo/hub/doks/USER.json'));
  const options = ['--only', 'USER', '--force', '--no-roles', '--no-ia', '--no-code-mapping'];
  const failed = await runGenerateThroughCommander(root, options, {
    runGenerateDeps: { generateDokForFeature: async () => ({ success: false, dok: null, prompt: '', rawResponse: '{bad}', usage: null, error: 'Malformed' }) },
  });
  expect(failed.result).toMatchObject({ status: 'partial', data: { failures: [{
    dokId: 'USER', existingPreserved: true, attempts: 2,
    nextCommand: 'doklo generate --only USER --force --yes',
    preserved: expect.arrayContaining(['.doklo/hub/doks/USER.json']),
  }] } });
  expect(await readFile(join(root, '.doklo/hub/doks/USER.json'))).toEqual(userBefore);
  const recovered = await runGenerateThroughCommander(root, options, {
    runGenerateDeps: { generateDokForFeature: async (_feature, context) => ({ success: true, dok: makeDok(context.dokId, 'Recovered') as never, prompt: '', rawResponse: '{}', usage: null }) },
  });
  expect(recovered.result).toMatchObject({ status: 'success', data: { results: [{ dokId: 'USER' }] } });
  expect(await readFile(join(root, '.doklo/hub/doks/AUTH.json'))).toEqual(authBefore);
  expect(JSON.parse(await readFile(join(root, '.doklo/hub/doks/USER.json'), 'utf8')).name).toBe('Recovered');
});
