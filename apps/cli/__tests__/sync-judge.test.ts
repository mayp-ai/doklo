// `doklo sync --judge` end to end (judge-gated sync design §4): the preview
// prepares every judge prompt, the judge plan is approved and run, and the
// regeneration plan covers only the Doks still needing it. The judge is a stub
// injected the way GenerateDeps injects the generator (`judgeDok`); consent and
// the token ledger are the real runtime-trust layer. No network, no model.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext } from '../src/lib/context.js';
import { takeCommandResult, type CommandResult } from '../src/lib/command-result.js';
import {
  runGenerate as runGenerateDirect,
  type GenerateDeps,
  type PreparedGenerationPayload,
  type RunGenerateOptions,
} from '../src/commands/generate.js';
import {
  buildSyncDiagnostics,
  registerSyncCommand,
  runSync as runSyncDirect,
  type RunSyncDeps,
  type RunSyncOptions,
  type RunSyncResult,
} from '../src/commands/sync.js';
import { dokJudgeVerdict, loadDok, printDok, dokStaleness } from '../src/commands/show.js';
import { runScan } from '../src/commands/scan.js';
import { resolveContainedOutputPath } from '@doklo-beta/generator';
import { authorizeLlmRun, buildLlmRunPlan } from '../src/lib/llm-preflight.js';
import { judgePlanInput, type JudgeDokFn, type JudgeDokOptions } from '../src/lib/judge/judge.js';
import type { JudgePayload } from '../src/lib/judge/request.js';
import { SYNC_JUDGE_PROMPT_DIGEST } from '../src/lib/judge/prompt.js';
import type { SyncJudgeResponse } from '../src/lib/judge/parse.js';

const SONNET = {
  providerKind: 'anthropic' as const,
  model: 'anthropic/claude-sonnet-5',
  authSource: 'keychain' as const,
  apiKey: 'test-key',
};

// ── Fixtures (mirrored from sync.test.ts; test files never import each other) ──

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

async function tmpInit(locale: 'en' | 'ko' = 'en'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-sync-judge-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.4.0' } }), 'utf-8');
  await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){ return null }', 'utf-8');
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await writeFile(join(root, 'workspace.json'), JSON.stringify({
    workspace_id: 'demo',
    name: 'Demo',
    services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
    default_locale: locale,
    supported_locales: [locale],
  }), 'utf-8');
  await writeFile(join(root, '.doklo/hub/roles.json'), JSON.stringify({ roles: [], version: 1 }), 'utf-8');
  git(root, ['init', '-q']);
  return root;
}

function makeDok(dokId: string, description = 'A stub dok produced by the test fake LLM.'): unknown {
  return {
    dok_id: dokId,
    name: 'Stub',
    status: 'active',
    tags: ['demo'],
    surfaces: ['web'],
    description,
    user_actions: {
      steps: [{ order: 1, actor: { kind: 'system' }, intent: 'Render', outcome: 'Rendered', variants: [{ platform: 'all', interaction: 'auto' }] }],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
  };
}

async function writeSource(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

async function writeConsolidatedMulti(root: string, features: { prefix: string; sourceFiles: string[] }[]): Promise<void> {
  for (const [index, feature] of features.entries()) {
    await writeSource(root, `app/x${index}/page.tsx`,
      feature.sourceFiles.map((file) => `import '../../${file}';`).join('\n')
      + '\nexport default function Page() { return null; }');
  }
  await writeFile(join(root, '.doklo/cache', 'web.consolidated.json'), JSON.stringify({
    projectName: 'demo',
    basedOnFeaturesAt: new Date().toISOString(),
    generatedAt: new Date(Date.now() + 60_000).toISOString(),
    model: 'claude-haiku-4-5',
    originalFeatureIds: features.map((_, i) => `x${i}`),
    userReviewed: false,
    stats: { originalFeatures: features.length, consolidatedFeatures: features.length, merges: 0, excluded: 0 },
    groups: [{
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
    }],
  }), 'utf-8');
}

const stubDeps: Partial<GenerateDeps> = {
  generateDokForFeature: async (_f, ctx) => ({
    success: true,
    dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never,
    prompt: '',
    rawResponse: '',
    usage: null,
  }),
};

/** A generator stub whose regenerations differ from the first generation (so a proposal has a change to describe). */
function regeneratingDeps(): { deps: Partial<GenerateDeps>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      generateDokForFeature: vi.fn(async (_f, ctx) => {
        calls.push(ctx.dokId);
        return {
          success: true,
          dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId, 'Regenerated for the new code.'))) as never,
          prompt: '',
          rawResponse: '',
          usage: null,
        };
      }) as GenerateDeps['generateDokForFeature'],
    },
  };
}

/** A generator stub that regenerates the same content (a regeneration that changes nothing). */
function identicalDeps(): { deps: Partial<GenerateDeps>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      generateDokForFeature: vi.fn(async (_f, ctx) => {
        calls.push(ctx.dokId);
        return { success: true, dok: JSON.parse(JSON.stringify(makeDok(ctx.dokId))) as never, prompt: '', rawResponse: '', usage: null };
      }) as GenerateDeps['generateDokForFeature'],
    },
  };
}

const isolated = { noLexicon: true, noRoles: true, noIa: true, noCodeMapping: true } as const;

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
    llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
    candidateFiles: preview.transmissions,
    workItems: work.map((item) => ({ phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId })),
    calls: { consolidate: 0, lexicon: 0, generateMax: work.length, judgeMax: 0 },
    preparedCalls: (preview.preparedGeneration?.items ?? []).map((item) => ({
      phase: 'generate' as const,
      workItem: { phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId },
      prompt: item.prompt,
      maxOutputTokens: 8_192,
    })),
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    authorizedRun: await authorizeLlmRun(root, plan, SONNET, { yes: true, isTTY: false }),
    preparedGeneration: preview.preparedGeneration,
  };
}

async function runGenerate(options: RunGenerateOptions, deps?: Partial<GenerateDeps>) {
  await runScan({ root: options.root });
  const preview = await runGenerateDirect({ ...options, dryRun: true }, deps);
  return runGenerateDirect({ ...options, ...await generationConsent(options.root, preview) }, deps);
}

/** The three steps the command takes: preview, judge (consent one), regeneration (consent two). */
async function judgeSync(
  root: string,
  opts: Omit<RunSyncOptions, 'root'> = {},
  deps: RunSyncDeps = {},
): Promise<{ preview: RunSyncResult; staged: RunSyncResult; result: RunSyncResult }> {
  const base = { root, ...opts, judge: opts.judge ?? {} };
  const preview = await runSyncDirect({ ...base, previewOnly: true }, deps);
  let staged = preview;
  if ((preview.preparedJudge?.calls.length ?? 0) > 0) {
    const plan = buildLlmRunPlan({
      llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
      ...judgePlanInput(preview.preparedJudge!),
      debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
    });
    const authorizedJudgeRun = await authorizeLlmRun(root, plan, SONNET, { yes: true, isTTY: false });
    staged = await runSyncDirect({ ...base, prepared: preview, authorizedJudgeRun }, deps);
  }
  if (staged.plannedRegeneration.length === 0) return { preview, staged, result: staged };
  const { judge: _judge, ...rest } = base;
  const result = await runSyncDirect({ ...rest, ...await generationConsent(root, staged), prepared: staged }, deps);
  return { preview, staged, result };
}

type Answer = 'accurate' | 'needs_update' | 'uncertain' | 'fail' | 'bare-path';

/** A judge stub: answers per Dok, citing a path it was sent (or a bare file name for `bare-path`). */
function stubJudge(answers: Record<string, Answer>, summaries: Record<string, string> = {}) {
  const calls: Array<{ dokId: string; payload: JudgePayload; options: JudgeDokOptions; label: string }> = [];
  const judgeDok: JudgeDokFn = async (request, options) => {
    const payload = JSON.parse(request.userPrompt) as JudgePayload;
    const dokId = payload.dok['dok_id'] as string;
    calls.push({ dokId, payload, options, label: request.label });
    const answer = answers[dokId] ?? 'accurate';
    if (answer === 'fail') return { success: false, content: null, usage: null, error: 'ai_sdk_error: boom' };
    const cite = payload.changed_files.find((file) => file.shown_as !== 'withheld')!.path;
    const evidence = answer === 'bare-path' ? cite.split('/').at(-1)! : cite;
    const response: SyncJudgeResponse = answer === 'needs_update'
      ? {
          verdict: 'needs_update',
          errors: [{ severity: 'major', claim_path: 'description', claim: 'A stub dok', evidence_files: [evidence], reason: 'the value moved', scope: 'this_change' }],
          omissions: [],
          checked: [],
          summary: summaries[dokId] ?? `The Dok must now say ${dokId} uses the new value.`,
        }
      : answer === 'uncertain'
        ? { verdict: 'uncertain', errors: [], omissions: [], checked: [], summary: 'The deciding code was not sent.' }
        : {
            verdict: 'accurate',
            errors: [],
            omissions: [],
            checked: [{ claim_path: 'description', evidence_files: [evidence], reason: 'still renders' }],
            summary: summaries[dokId] ?? `Only an internal value of ${dokId} moved; the Dok still holds.`,
          };
    return { success: true, content: JSON.stringify(response), usage: { input_tokens: 100, output_tokens: 20 }, error: null };
  };
  return { judgeDok, calls };
}

const approval = { version: 2, date: '2026-10-05', change: 'Activated', author: 'tester', kind: 'status', from: 'draft', to: 'active' };

async function readDok(root: string, dokId: string): Promise<Record<string, unknown> & { status: string; description: string; _meta: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(root, `.doklo/hub/doks/${dokId}.json`), 'utf-8'));
}

async function approve(root: string, dokId: string, meta: Record<string, unknown> = {}): Promise<void> {
  const dok = await readDok(root, dokId);
  dok.status = 'active';
  dok._meta = { ...dok._meta, version: 2, history: [approval], ...meta };
  await writeFile(join(root, `.doklo/hub/doks/${dokId}.json`), JSON.stringify(dok, null, 2) + '\n', 'utf-8');
}

/**
 * Generate each feature from committed sources (so `source_commit` is HEAD
 * and every logic file carries its sha256), approve the named ones, then edit
 * the named sources in the working tree.
 */
async function seed(
  root: string,
  features: Array<{ prefix: string; file: string }>,
  opts: { approve?: string[]; change?: string[] } = {},
): Promise<void> {
  await writeConsolidatedMulti(root, features.map((f) => ({ prefix: f.prefix, sourceFiles: [f.file] })));
  for (const f of features) await writeSource(root, f.file, `export const ${f.prefix.toLowerCase()} = 1;\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  await runGenerate({ root, ...isolated }, stubDeps);
  for (const dokId of opts.approve ?? features.map((f) => f.prefix)) await approve(root, dokId);
  for (const prefix of opts.change ?? features.map((f) => f.prefix)) {
    const feature = features.find((f) => f.prefix === prefix)!;
    await writeSource(root, feature.file, `export const ${prefix.toLowerCase()} = 2;\n`);
  }
}

const exists = (path: string) => access(path).then(() => true, () => false);

describe('doklo sync --judge (runSync steps)', () => {
  it('accurate: the Dok is not regenerated, not demoted, and its verdict is cached', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const before = await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8');
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate' });
      const gen = regeneratingDeps();

      const { preview, result } = await judgeSync(root, {}, { ...gen.deps, judgeDok });

      // Every judge prompt was prepared before consent.
      expect(preview.preparedJudge?.calls.map((c) => c.dokId)).toEqual(['AUTH']);
      expect(preview.plannedRegeneration).toEqual(['AUTH']); // pending the judge
      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toMatchObject({
        answer_language: 'English',
        changed_files: [{ path: 'src/auth.ts', shown_as: 'diff' }],
      });
      expect(calls[0]!.payload.diff).toContain('+export const auth = 2;');
      expect(calls[0]!.payload.dok).not.toHaveProperty('_meta');
      expect(calls[0]!.options).toMatchObject({ providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key', maxTokens: 8_192 });
      expect(calls[0]!.options.debugDir.endsWith(join('.doklo', 'debug'))).toBe(true);
      expect(calls[0]!.label).toBe('judge-AUTH');

      expect(result.judged).toEqual([{
        dokId: 'AUTH',
        verdict: 'accurate',
        cached: false,
        model: 'anthropic/claude-sonnet-5',
        summary: 'Only an internal value of AUTH moved; the Dok still holds.',
      }]);
      expect(result.judgeSkipped).toEqual({ noFacts: [], overMax: [], overBudget: [], noDiff: [] });
      expect(result.plannedRegeneration).toEqual([]);
      expect(result.plannedReturnToDraft).toEqual([]);
      expect(gen.calls).toEqual([]);
      expect(await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf-8')).toBe(before);

      const cache = JSON.parse(await readFile(join(root, '.doklo/cache/judge/AUTH.json'), 'utf-8')) as Record<string, unknown>;
      expect(cache).toMatchObject({
        schema_version: 1,
        dok_id: 'AUTH',
        verdict: 'accurate',
        model: 'anthropic/claude-sonnet-5',
        prompt_digest: SYNC_JUDGE_PROMPT_DIGEST,
        source_commit: git(root, ['rev-parse', 'HEAD']).trim(),
        checked: [{ claim_path: 'description', evidence_files: ['src/auth.ts'], reason: 'still renders' }],
      });
      expect(Object.keys(cache).some((key) => /at$|time|date/i.test(key))).toBe(false);

      // Still stale to drift and MCP; --check shows the unconfirmed verdict.
      const check = await runSyncDirect({ root, check: true });
      expect(check.stale.map((s) => [s.dokId, s.reason])).toEqual([['AUTH', 'changed']]);
      expect(check.judged).toEqual([{ ...result.judged![0], cached: true }]);
      expect(buildSyncDiagnostics(check, true)).toContainEqual(expect.objectContaining({
        code: 'SYNC_STALE_DOK',
        message: "AUTH is stale (changed); judged accurate by anthropic/claude-sonnet-5, awaiting a person's confirmation.",
        nextCommand: 'doklo serve',
      }));
      expect(buildSyncDiagnostics(result, false)).toContainEqual(expect.objectContaining({
        code: 'SYNC_KEPT_BY_JUDGE', preserved: ['AUTH'], nextCommand: 'doklo serve',
      }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('runs the judge on GPT-6 Luna with an OpenAI API key: the default endpoint, no custom transport', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate' });
      const deps = { ...regeneratingDeps().deps, judgeDok };
      // What a headless runner resolves: nothing stored, OPENAI_API_KEY set.
      const luna = { providerKind: 'openai' as const, model: 'openai/gpt-6-luna', authSource: 'environment' as const, apiKey: 'sk-env' };

      const preview = await runSyncDirect({ root, judge: {}, previewOnly: true }, deps);
      const plan = buildLlmRunPlan({
        llm: luna,
        ...judgePlanInput(preview.preparedJudge!),
        debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
      });
      expect(plan).toMatchObject({ route: 'openai-api-key', model: 'openai/gpt-6-luna', authSource: 'environment' });
      const authorizedJudgeRun = await authorizeLlmRun(root, plan, luna, { yes: true, isTTY: false });
      const staged = await runSyncDirect({ root, judge: {}, prepared: preview, authorizedJudgeRun }, deps);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.options).toMatchObject({ providerKind: 'openai', model: 'openai/gpt-6-luna', apiKey: 'sk-env', maxTokens: 8_192 });
      expect(calls[0]!.options).not.toHaveProperty('baseURL');
      expect(calls[0]!.options).not.toHaveProperty('fetch');
      expect(staged.judged).toEqual([expect.objectContaining({ dokId: 'AUTH', verdict: 'accurate', model: 'openai/gpt-6-luna' })]);
      expect(staged.plannedRegeneration).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('needs_update: regenerated with the judge’s sentence staged as a model proposal', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'needs_update' }, { AUTH: 'The Dok must now say the flag is 2.' });
      const gen = regeneratingDeps();

      const { staged, result } = await judgeSync(root, {}, { ...gen.deps, judgeDok });

      expect(staged.plannedRegeneration).toEqual(['AUTH']);
      expect(staged.plannedReturnToDraft).toEqual(['AUTH']);
      expect(result.judged).toEqual([expect.objectContaining({ dokId: 'AUTH', verdict: 'needs_update', cached: false })]);
      expect(result.regenerated).toEqual(['AUTH']);
      expect(result.returnedToDraft).toEqual(['AUTH']);
      const written = await readDok(root, 'AUTH');
      expect(written.status).toBe('draft');
      expect(written.description).toBe('Regenerated for the new code.');
      expect(written._meta['pending_change']).toEqual({
        summary: 'The Dok must now say the flag is 2.',
        source: 'model',
        base_version: 2,
        previous_status: 'active',
      });
      expect(written._meta['history']).toEqual([approval]); // no entry until a person approves
      expect(await exists(join(root, '.doklo/cache/judge/AUTH.json'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uncertain, a failed call and an answer citing an unsent path all regenerate as without --judge', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [
        { prefix: 'AUTH', file: 'src/auth.ts' },
        { prefix: 'USER', file: 'src/user.ts' },
        { prefix: 'TEAM', file: 'src/team.ts' },
      ]);
      const { judgeDok } = stubJudge({ AUTH: 'uncertain', USER: 'fail', TEAM: 'bare-path' });
      const gen = regeneratingDeps();

      const { result } = await judgeSync(root, {}, { ...gen.deps, judgeDok });

      expect(result.judged).toEqual([
        { dokId: 'AUTH', verdict: 'uncertain', cached: false, model: 'anthropic/claude-sonnet-5', summary: 'The deciding code was not sent.' },
        expect.objectContaining({ dokId: 'TEAM', verdict: 'uncertain', reason: 'evidence_outside_sent' }),
        { dokId: 'USER', verdict: 'uncertain', cached: false, model: 'anthropic/claude-sonnet-5', reason: 'call_failed' },
      ]);
      expect([...result.regenerated].sort()).toEqual(['AUTH', 'TEAM', 'USER']);
      for (const dokId of ['AUTH', 'USER', 'TEAM']) {
        expect((await readDok(root, dokId))._meta['pending_change']).toMatchObject({ source: 'diff', base_version: 2 });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a Dok without the change facts is regenerated without the judge and listed', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }]);
      const user = await readDok(root, 'USER');
      delete user._meta['source_commit'];
      await writeFile(join(root, '.doklo/hub/doks/USER.json'), JSON.stringify(user, null, 2) + '\n', 'utf-8');
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate' });
      const gen = regeneratingDeps();

      const { preview, result } = await judgeSync(root, {}, { ...gen.deps, judgeDok });

      expect(preview.judgeSkipped).toEqual({ noFacts: ['USER'], overMax: [], overBudget: [], noDiff: [] });
      expect(calls.map((c) => c.dokId)).toEqual(['AUTH']);
      expect(result.judgeSkipped?.noFacts).toEqual(['USER']);
      expect(result.regenerated).toEqual(['USER']);
      expect(gen.calls).toEqual(['USER']);
      expect(buildSyncDiagnostics(result, false)).toContainEqual(expect.objectContaining({
        code: 'SYNC_JUDGE_SKIPPED', message: 'Regenerated without the judge (no change facts recorded yet): USER',
      }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('--judge-max caps the calls; the rest regenerate without the judge', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }]);
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate', USER: 'accurate' });
      const gen = regeneratingDeps();

      const { preview, result } = await judgeSync(root, { judge: { max: 1 } }, { ...gen.deps, judgeDok });

      expect(preview.preparedJudge?.calls.map((c) => c.dokId)).toEqual(['AUTH']);
      expect(preview.judgeSkipped?.overMax).toEqual(['USER']);
      expect(calls.map((c) => c.dokId)).toEqual(['AUTH']);
      expect(result.judged?.map((j) => [j.dokId, j.verdict])).toEqual([['AUTH', 'accurate']]);
      expect(result.regenerated).toEqual(['USER']);
      expect(result.plannedRegeneration).toEqual(['USER']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reuses a cached accurate verdict instead of calling again, until the code moves', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate' });
      await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });
      expect(calls).toHaveLength(1);

      const again = await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });
      expect(calls).toHaveLength(1); // no second call
      expect(again.preview.preparedJudge?.calls).toEqual([]);
      expect(again.result.judged).toEqual([expect.objectContaining({ dokId: 'AUTH', verdict: 'accurate', cached: true })]);
      expect(again.result.plannedRegeneration).toEqual([]);

      await writeSource(root, 'src/auth.ts', 'export const auth = 3;\n');
      await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });
      expect(calls).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('drafts are regenerated without the judge; human-edited Doks stay protected without --force', async () => {
    const root = await tmpInit();
    try {
      await seed(
        root,
        [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }],
        { approve: ['USER'] },
      );
      await approve(root, 'USER', { edited_by_human: true });
      const { judgeDok, calls } = stubJudge({});
      const gen = regeneratingDeps();

      const { result } = await judgeSync(root, {}, { ...gen.deps, judgeDok });

      expect(calls).toEqual([]);
      expect(result.judged).toEqual([]);
      expect(result.regenerated).toEqual(['AUTH']);
      expect(result.skippedHumanEdit).toEqual(['USER']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('needs_update whose regeneration comes out unchanged proposes nothing and is reported', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'needs_update' });

      const { result } = await judgeSync(root, {}, { ...identicalDeps().deps, judgeDok });

      expect(result.regenerated).toEqual(['AUTH']);
      expect(result.regeneratedUnchanged).toEqual(['AUTH']);
      expect((await readDok(root, 'AUTH'))._meta['pending_change']).toBeUndefined();
      expect(buildSyncDiagnostics(result, false)).toContainEqual(expect.objectContaining({
        code: 'SYNC_JUDGE_UNCHANGED_REGENERATION', preserved: ['AUTH'],
      }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a person’s note outranks the judge’s sentence', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'needs_update' });

      await judgeSync(root, { proposalNote: { change: 'Passkeys are now required.', category: 'changed' } }, { ...regeneratingDeps().deps, judgeDok });

      expect((await readDok(root, 'AUTH'))._meta['pending_change']).toEqual({
        summary: 'Passkeys are now required.',
        source: 'human',
        category: 'changed',
        base_version: 2,
        previous_status: 'active',
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('an empty judge sentence falls back to the deterministic comparison', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'needs_update' }, { AUTH: '   ' });

      await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });

      expect((await readDok(root, 'AUTH'))._meta['pending_change']).toMatchObject({ source: 'diff', summary: 'Updated the description.' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('asks in the workspace’s language', async () => {
    const root = await tmpInit('ko');
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate' });
      await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });
      expect(calls[0]!.payload.answer_language).toBe('Korean');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a token cap stops the judge: the call that reached it keeps its answer, the rest regenerate', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }]);
      const stub = stubJudge({ AUTH: 'accurate', USER: 'accurate' });
      // Provider usage far past the 1,000,000-token run cap.
      const judgeDok: JudgeDokFn = async (request, options) => ({
        ...await stub.judgeDok(request, options),
        usage: { input_tokens: 2_000_000, output_tokens: 0 },
      });
      const preview = await runSyncDirect({ root, previewOnly: true, judge: {} }, { ...stubDeps, judgeDok });
      const plan = buildLlmRunPlan({
        llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
        ...judgePlanInput(preview.preparedJudge!),
        debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
      });
      const authorizedJudgeRun = await authorizeLlmRun(root, plan, SONNET, { yes: true, isTTY: false });

      const staged = await runSyncDirect({ root, prepared: preview, authorizedJudgeRun }, { ...stubDeps, judgeDok });

      expect(stub.calls.map((c) => c.dokId)).toEqual(['AUTH']);
      expect(staged.judged).toEqual([
        expect.objectContaining({ dokId: 'AUTH', verdict: 'accurate' }),
        { dokId: 'USER', verdict: 'uncertain', cached: false, model: 'anthropic/claude-sonnet-5', reason: 'token_cap' },
      ]);
      expect(staged.plannedRegeneration).toEqual(['USER']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects --judge together with --check before touching the workspace', async () => {
    const root = await tmpInit();
    try {
      await expect(runSyncDirect({ root, check: true, judge: {} })).rejects.toMatchObject({ code: 'SYNC_JUDGE_WITH_CHECK' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('the judge step refuses to run without the preview’s prepared calls', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const preview = await runSyncDirect({ root, previewOnly: true }, stubDeps);
      const plan = buildLlmRunPlan({
        llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
        candidateFiles: [],
        workItems: [{ phase: 'judge', serviceId: 'web', id: 'AUTH' }],
        calls: { consolidate: 0, lexicon: 0, generateMax: 0, judgeMax: 1 },
        preparedCalls: [{ phase: 'judge', workItem: { phase: 'judge', serviceId: 'web', id: 'AUTH' }, prompt: 'x', maxOutputTokens: 1 }],
        debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
      });
      const authorizedJudgeRun = await authorizeLlmRun(root, plan, SONNET, { yes: true, isTTY: false });
      await expect(runSyncDirect({ root, prepared: preview, authorizedJudgeRun }, stubDeps)).rejects.toMatchObject({
        result: { diagnostics: [expect.objectContaining({ code: 'LLM_PREPARED_PAYLOAD_REQUIRED' })] },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('doklo sync --judge (command)', () => {
  async function syncThroughCommander(
    root: string,
    args: string[],
    deps: RunSyncDeps,
    locale: 'en' | 'ko' = 'en',
  ): Promise<{ lines: string[]; result: CommandResult<RunSyncResult> | undefined; roles: string[] }> {
    const output: string[] = [];
    const roles: string[] = [];
    const program = new Command();
    registerSyncCommand(program, createContext(locale), {
      runSync: (options) => runSyncDirect(options, deps),
      resolveLlmForRole: async (role) => {
        roles.push(role);
        return { ...SONNET };
      },
      authorizeLlmRun: async (...consent: Parameters<typeof authorizeLlmRun>) => {
        output.push('<consent>');
        return authorizeLlmRun(...consent);
      },
    });
    const capture = (...parts: unknown[]): void => { output.push(parts.map(String).join(' ')); };
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
      roles,
    };
  }

  const lineWith = (lines: string[], text: string): number => lines.findIndex((line) => line.includes(text));

  it('asks for two consents with --yes: the judge plan, then the regeneration plan', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'accurate', USER: 'needs_update' }, { USER: 'The Dok must now say user is 2.' });
      const gen = regeneratingDeps();

      const { lines, result, roles } = await syncThroughCommander(root, ['--judge', '--yes'], { ...gen.deps, judgeDok });

      expect(roles).toEqual(['judge', 'generate']);
      const asking = lineWith(lines, 'Asking the judge about 2 stale Dok(s) before regenerating them.');
      const judgePlan = lineWith(lines, 'LLM consent plan');
      const consents = lines.flatMap((line, index) => (line === '<consent>' ? [index] : []));
      expect(consents).toHaveLength(2);
      expect(lines[judgePlan + 2]).toContain('judge<=2');
      expect(asking).toBeLessThan(judgePlan);
      expect(judgePlan).toBeLessThan(consents[0]!);
      const accurate = lineWith(lines, '✓ AUTH — still accurate (anthropic/claude-sonnet-5): Only an internal value of AUTH moved; the Dok still holds.');
      const needs = lineWith(lines, '↻ USER — needs an update (anthropic/claude-sonnet-5): The Dok must now say user is 2.');
      const summary = lineWith(lines, 'Judge: 1 still accurate, 1 need an update, 0 undecided (0 reused).');
      expect(accurate).toBeGreaterThan(consents[0]!);
      expect(needs).toBeGreaterThan(accurate);
      expect(summary).toBeGreaterThan(needs);
      const regenPlan = lines.findIndex((line, index) => index > summary && line.includes('LLM consent plan'));
      expect(regenPlan).toBeGreaterThan(summary);
      expect(lines[regenPlan + 2]).toContain('generate<=1');
      expect(lineWith(lines, '1 approved Dok(s) in this plan will return to draft until re-approved.')).toBeGreaterThan(regenPlan);
      expect(consents[1]!).toBeGreaterThan(regenPlan);
      expect(lineWith(lines, 'Regenerated 1 Dok(s).')).toBeGreaterThan(consents[1]!);

      expect(gen.calls).toEqual(['USER']);
      expect(result?.status).toBe('partial'); // AUTH stays stale until a person confirms it
      expect(result?.data).toMatchObject({
        plannedRegeneration: ['USER'],
        regenerated: ['USER'],
        returnedToDraft: ['USER'],
        judged: [
          expect.objectContaining({ dokId: 'AUTH', verdict: 'accurate', cached: false }),
          expect.objectContaining({ dokId: 'USER', verdict: 'needs_update', cached: false }),
        ],
        judgeSkipped: { noFacts: [], overMax: [], overBudget: [], noDiff: [] },
      });
      expect(result?.data).not.toHaveProperty('preparedJudge');
      expect(result?.diagnostics).toContainEqual(expect.objectContaining({ code: 'SYNC_KEPT_BY_JUDGE', preserved: ['AUTH'] }));
      expect((await readDok(root, 'USER'))._meta['pending_change']).toMatchObject({ source: 'model', summary: 'The Dok must now say user is 2.' });
      expect((await readDok(root, 'AUTH')).status).toBe('active');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('skips the judge consent when every verdict is reused, and needs no regeneration consent when all hold', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok, calls } = stubJudge({ AUTH: 'accurate' });
      await syncThroughCommander(root, ['--judge', '--yes'], { ...regeneratingDeps().deps, judgeDok });

      const { lines, result, roles } = await syncThroughCommander(root, ['--judge', '--yes'], { ...regeneratingDeps().deps, judgeDok });

      expect(calls).toHaveLength(1);
      expect(roles).toEqual([]);
      expect(lines).not.toContain('<consent>');
      expect(lineWith(lines, '✓ AUTH — still accurate, verdict reused (anthropic/claude-sonnet-5)')).toBeGreaterThanOrEqual(0);
      expect(lineWith(lines, 'Judge: 1 still accurate, 0 need an update, 0 undecided (1 reused).')).toBeGreaterThanOrEqual(0);
      expect(result?.data).toMatchObject({ regenerated: [], judged: [expect.objectContaining({ cached: true })] });
      expect(result?.data).not.toHaveProperty('preparedJudge');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prints the verdict lines in Korean', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }, { prefix: 'TEAM', file: 'src/team.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'accurate', USER: 'needs_update', TEAM: 'fail' }, { AUTH: '그대로 맞습니다.', USER: '이제 값이 2라고 적어야 합니다.' });

      const { lines } = await syncThroughCommander(root, ['--judge', '--yes'], { ...regeneratingDeps().deps, judgeDok }, 'ko');

      expect(lines).toContain('  재생성하기 전에 드리프트된 Dok 3개를 판사에게 묻습니다.');
      expect(lines).toContain('  ✓ AUTH — 그대로 맞음 (anthropic/claude-sonnet-5): 그대로 맞습니다.');
      expect(lines).toContain('  ↻ USER — 고쳐야 함 (anthropic/claude-sonnet-5): 이제 값이 2라고 적어야 합니다.');
      expect(lines).toContain('  ? TEAM — 판사가 정하지 못함 (anthropic/claude-sonnet-5): 호출이 실패했습니다');
      expect(lineWith(lines, '판사: 그대로 맞음 1개, 고쳐야 함 1개, 정하지 못함 1개 (다시 쓴 판정 0개).')).toBeGreaterThanOrEqual(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('--json keeps stdout structured: two consent plans, the verdicts in the result envelope', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }, { prefix: 'USER', file: 'src/user.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'accurate', USER: 'needs_update' });

      const { lines, result } = await syncThroughCommander(root, ['--judge', '--yes', '--json'], { ...regeneratingDeps().deps, judgeDok });

      const printed = lines.filter((line) => line !== '' && line !== '<consent>');
      const stages = printed.map((line) => JSON.parse(line) as { stage: string; plan: { calls: Record<string, number>; model: string } });
      expect(stages.map((s) => s.stage)).toEqual(['consent-plan', 'consent-plan']);
      expect(stages[0]!.plan.calls).toMatchObject({ judgeMax: 2, generateMax: 0 });
      expect(stages[0]!.plan.model).toBe('anthropic/claude-sonnet-5');
      expect(stages[1]!.plan.calls).toMatchObject({ judgeMax: 0, generateMax: 1 });
      expect(result?.data).toMatchObject({
        judged: [
          { dokId: 'AUTH', verdict: 'accurate', cached: false, model: 'anthropic/claude-sonnet-5' },
          { dokId: 'USER', verdict: 'needs_update', cached: false, model: 'anthropic/claude-sonnet-5' },
        ],
        judgeSkipped: { noFacts: [], overMax: [], overBudget: [], noDiff: [] },
        plannedRegeneration: ['USER'],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('--check says “stale, judged accurate (unconfirmed)” with the model and the summary, in en and ko', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'accurate' });
      await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });

      const en = await syncThroughCommander(root, ['--check'], stubDeps);
      expect(en.lines).toContain('  1 stale Dok(s):');
      expect(en.lines).toContain('  ↳ AUTH — stale, judged accurate (unconfirmed) by anthropic/claude-sonnet-5: Only an internal value of AUTH moved; the Dok still holds.');
      expect(en.result?.status).toBe('partial');
      expect(en.result?.data?.judged).toEqual([expect.objectContaining({ dokId: 'AUTH', cached: true })]);
      expect(en.result?.diagnostics).toContainEqual(expect.objectContaining({ code: 'SYNC_STALE_DOK', nextCommand: 'doklo serve' }));

      const ko = await syncThroughCommander(root, ['--check'], stubDeps, 'ko');
      expect(ko.lines).toContain('  ↳ AUTH — 드리프트됨, 판사는 그대로 맞다고 함 (사람 확인 전) · anthropic/claude-sonnet-5: Only an internal value of AUTH moved; the Dok still holds.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('--judge with --check is a usage error; --judge-max needs --judge and a count', async () => {
    const root = await tmpInit();
    try {
      await expect(syncThroughCommander(root, ['--judge', '--check'], stubDeps)).rejects.toMatchObject({ code: 'SYNC_JUDGE_WITH_CHECK' });
      await expect(syncThroughCommander(root, ['--judge-max', '2', '--yes'], stubDeps)).rejects.toThrow('--judge-max requires --judge');
      await expect(syncThroughCommander(root, ['--judge', '--judge-max', 'two', '--yes'], stubDeps)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('`doklo show` prints the unconfirmed verdict beside the stale freshness line', async () => {
    const root = await tmpInit();
    try {
      await seed(root, [{ prefix: 'AUTH', file: 'src/auth.ts' }]);
      const { judgeDok } = stubJudge({ AUTH: 'accurate' });
      await judgeSync(root, {}, { ...regeneratingDeps().deps, judgeDok });

      const dok = await loadDok({ root, dokId: 'AUTH' });
      const staleness = await dokStaleness(root, dok);
      expect(staleness).toEqual({ stale: true, reason: 'changed' });
      const judged = await dokJudgeVerdict(root, dok);
      expect(judged).toMatchObject({ model: 'anthropic/claude-sonnet-5' });
      const out: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
      try {
        const { default: chalk } = await import('chalk');
        printDok(dok, chalk, staleness, judged);
      } finally { log.mockRestore(); }
      // eslint-disable-next-line no-control-regex
      const text = out.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
      expect(text).toContain('⚠ stale (changed) · standard');
      expect(text).toContain('judge stale, judged accurate (unconfirmed) · anthropic/claude-sonnet-5 — Only an internal value of AUTH moved; the Dok still holds.');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
