import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

const {
  consolidateProviderMock,
  generateProviderMock,
  lexiconProviderMock,
  resolveLlmForRoleMock,
} = vi.hoisted(() => ({
  consolidateProviderMock: vi.fn(),
  generateProviderMock: vi.fn(),
  lexiconProviderMock: vi.fn(),
  resolveLlmForRoleMock: vi.fn(async () => ({
    model: 'anthropic/claude-sonnet-5',
    providerKind: 'anthropic' as const,
    authSource: 'keychain' as const,
    apiKey: 'test-key',
  })),
}));

vi.mock('@doklo-beta/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/generator')>();
  return {
    ...actual,
    consolidateFeatures: consolidateProviderMock,
    generateDokForFeature: generateProviderMock,
    suggestLexiconTerms: lexiconProviderMock,
  };
});

vi.mock('../src/lib/llm-options.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/llm-options.js')>();
  return { ...actual, resolveLlmForRole: resolveLlmForRoleMock };
});

import { registerConsolidateCommand } from '../src/commands/consolidate.js';
import { registerGenerateCommand } from '../src/commands/generate.js';
import { registerLexiconSuggestCommand } from '../src/commands/lexicon-suggest.js';
import { registerSyncCommand } from '../src/commands/sync.js';
import { runScan } from '../src/commands/scan.js';
import { createContext } from '../src/lib/context.js';
import { computeLogicHash } from '@doklo-beta/core';

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-llm-contract-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
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
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { next: '15.4.0' } }),
  );
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){ return null }');
  await writeFile(
    join(root, '.doklo/hub/roles.json'),
    JSON.stringify({ roles: [], version: 1 }),
  );
  return root;
}

async function writeScan(root: string): Promise<void> {
  await writeFile(join(root, '.doklo/cache/web.scan.json'), JSON.stringify({
    framework: 'nextjs', root,
    files: ['app/page.tsx'],
    routes: [{ path: '/', kind: 'page', file: 'app/page.tsx' }],
    components: [], stores: [],
    framework_specific: {
      file_ledger: [{
        file: 'app/page.tsx', status: 'processed', stages: ['discovery', 'ast', 'routing'], reason: 'OK',
      }],
    },
  }));
}

async function writeConsolidated(root: string): Promise<void> {
  await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify({
    projectName: 'demo', basedOnFeaturesAt: 't', generatedAt: 't', model: 'm', userReviewed: false,
    originalFeatureIds: ['home'],
    stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
    groups: [{
      group_id: 'g', label: 'Group', excluded: [],
      features: [{
        canonical_id: 'f', label: 'Feature', decision: 'keep', members: ['home'],
        primary_route: '/', reason: '', user_reviewed: false, dok_id_prefix: 'AUTH',
        source_files: ['app/page.tsx'],
      }],
    }],
  }));
}

function makeDok(logicHash?: string): Record<string, unknown> {
  return {
    dok_id: 'AUTH', name: 'Auth', status: 'active', tags: ['auth'], surfaces: ['web'],
    description: 'Auth feature',
    user_actions: { steps: [{
      order: 1, actor: { kind: 'system' }, intent: 'Run', outcome: 'Done',
      variants: [{ platform: 'all', interaction: 'auto' }],
    }] },
    business_rules: { rules: [] }, acceptance_criteria: { criteria: [] },
    ...(logicHash === undefined ? {} : { _meta: {
      source_anchors: [{ file: 'app/page.tsx' }],
      anchor_service_id: 'web',
      logic_hash: logicHash,
      tracking_version: 2,
    } }),
  };
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);
  return { chunks, restore: () => spy.mockRestore() };
}

function consentPlan(chunks: string[]): Record<string, unknown> {
  const events = chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return events.find((event) => event.stage === 'consent-plan').plan as Record<string, unknown>;
}

function forceNonTTY(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  return () => {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  };
}

function commandOptions(
  register: (program: Command) => void,
  name: string,
): string[] {
  const program = new Command();
  register(program);
  return program.commands.find((command) => command.name() === name)?.options
    .map((option) => option.long) ?? [];
}

describe('LLM command registration contract', () => {
  it('registers --json and --yes on every LLM-capable command', () => {
    const ctx = createContext('en');
    const commands = [
      commandOptions((program) => registerGenerateCommand(program, ctx), 'generate'),
      commandOptions((program) => registerConsolidateCommand(program, ctx), 'consolidate'),
      commandOptions((program) => registerLexiconSuggestCommand(program, ctx), 'lexicon-suggest'),
      commandOptions((program) => registerSyncCommand(program, ctx), 'sync'),
    ];

    for (const options of commands) {
      expect(options).toEqual(expect.arrayContaining(['--json', '--yes']));
      expect(options).not.toContain('--api-key');
    }
  });

  it('documents both exact hosted runtime-trust routes', () => {
    const ctx = createContext('en');
    for (const register of [registerGenerateCommand, registerConsolidateCommand]) {
      const program = new Command();
      register(program, ctx);
      const help = program.helpInformation();
      expect(help).toContain('runtime-trust');
      expect(help).toContain('anthropic/claude-sonnet-5');
      expect(help).toContain('openai/gpt-5.6-terra');
      expect(help).not.toContain('via direct Anthropic');
      expect(help).not.toContain('claude-code" (default');
    }
  });

  it.each([
    ['lexicon-suggest', registerLexiconSuggestCommand],
    ['sync', registerSyncCommand],
  ] as const)('%s rejects non-TTY execution before credential resolution or mutation', async (
    commandName,
    register,
  ) => {
    const root = await workspace();
    const program = new Command();
    register(program, createContext('en'));
    resolveLlmForRoleMock.mockClear();
    const restoreTTY = forceNonTTY();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(
        program.parseAsync([commandName, '--root', root], { from: 'user' }),
      ).rejects.toMatchObject({
        exitCode: 2,
        result: { command: commandName, status: 'cancelled' },
      });
      expect(resolveLlmForRoleMock).not.toHaveBeenCalled();
      await expect(
        access(join(root, '.doklo/cache/lexicon-suggestions.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(join(root, '.doklo/cache/web.consolidated.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      consoleLog.mockRestore();
      restoreTTY();
    }
  });

  it('consolidate rejects non-TTY execution before credentials or cache writes', async () => {
    const root = await workspace();
    await writeFile(
      join(root, '.doklo/cache/web.scan.json'),
      JSON.stringify({
        framework: 'nextjs',
        root,
        files: [],
        routes: [],
        components: [],
        stores: [],
      }),
    );
    const program = new Command();
    registerConsolidateCommand(program, createContext('en'));
    resolveLlmForRoleMock.mockClear();
    const restoreTTY = forceNonTTY();

    try {
      await expect(
        program.parseAsync(['consolidate', '--root', root], { from: 'user' }),
      ).rejects.toMatchObject({
        exitCode: 2,
        result: { command: 'consolidate', status: 'cancelled' },
      });
      expect(resolveLlmForRoleMock).not.toHaveBeenCalled();
      await expect(
        access(join(root, '.doklo/cache/web.consolidated.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      restoreTTY();
    }
  });

  it('runs consolidate through real Commander and worker boundaries with an exact durable plan', async () => {
    const root = await workspace();
    await writeScan(root);
    consolidateProviderMock.mockResolvedValueOnce({
      success: true, prompt: 'p', estimatedInputTokens: 1, estimatedOutputTokens: 32_768,
      usage: null,
      config: {
        projectName: 'demo', basedOnFeaturesAt: 't', generatedAt: 't', model: 'm',
        originalFeatureIds: [],
        userReviewed: false,
        stats: { originalFeatures: 0, consolidatedFeatures: 0, excluded: 0, merges: 0 },
        groups: [],
      },
    });
    const program = new Command();
    registerConsolidateCommand(program, createContext('en'));
    const stdout = captureStdout();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['consolidate', '--root', root, '--yes', '--json'], { from: 'user' });
      expect(consolidateProviderMock).toHaveBeenCalledOnce();
      expect(consentPlan(stdout.chunks)).toMatchObject({
        providerKind: 'anthropic', route: 'anthropic-default',
        workItems: [{ phase: 'consolidate', serviceId: 'web', id: 'web' }],
      });
      await expect(access(join(root, '.doklo/cache/llm-token-ledger.json'))).resolves.toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
      stdout.restore();
      consolidateProviderMock.mockReset();
    }
  });

  it('runs lexicon-suggest through real Commander and worker boundaries with its exact payload', async () => {
    const root = await workspace();
    await writeConsolidated(root);
    await mkdir(join(root, 'messages'), { recursive: true });
    await writeFile(join(root, 'messages/en.json'), JSON.stringify({ domain: 'Milestone' }));
    lexiconProviderMock.mockResolvedValueOnce({
      success: true, suggestions: [], prompt: 'p', rawResponse: '{}', usage: null,
    });
    const program = new Command();
    registerLexiconSuggestCommand(program, createContext('en'));
    const stdout = captureStdout();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['lexicon-suggest', '--root', root, '--yes', '--json'], { from: 'user' });
      expect(lexiconProviderMock).toHaveBeenCalledOnce();
      expect(consentPlan(stdout.chunks)).toMatchObject({
        providerKind: 'anthropic', route: 'anthropic-default',
        workItems: [{ phase: 'lexicon', serviceId: 'workspace', id: 'code' }],
        transmissions: expect.arrayContaining([
          expect.objectContaining({ phase: 'lexicon', file: 'messages/en.json' }),
        ]),
      });
    } finally {
      consoleSpy.mockRestore();
      stdout.restore();
      lexiconProviderMock.mockReset();
    }
  });

  it('runs sync through real Commander and generation worker boundaries for the stale worklist', async () => {
    const root = await workspace();
    await writeConsolidated(root);
    await runScan({ root });
    const oldHash = computeLogicHash([{ file: 'app/page.tsx', content: 'old' }]);
    await writeFile(join(root, '.doklo/hub/doks/AUTH.json'), JSON.stringify(makeDok(oldHash)));
    generateProviderMock.mockImplementation(async () => ({
      success: true, dok: makeDok(), prompt: 'p', rawResponse: '{}',
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const program = new Command();
    registerSyncCommand(program, createContext('en'));
    const stdout = captureStdout();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['sync', '--root', root, '--yes', '--json'], { from: 'user' });
      expect(generateProviderMock).toHaveBeenCalledOnce();
      expect(consentPlan(stdout.chunks)).toMatchObject({
        providerKind: 'anthropic', route: 'anthropic-default',
        workItems: [{ phase: 'generate', serviceId: 'web', id: 'AUTH' }],
      });
    } finally {
      consoleSpy.mockRestore();
      stdout.restore();
      generateProviderMock.mockReset();
    }
  });
});
