import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authenticateProviderMock,
  autocompletePromptMock,
  handoffMock,
  loadConfigMock,
  loadModelsDbMock,
  logInfoMock,
  logSuccessMock,
  runScanMock,
  saveConfigMock,
  selectPromptMock,
  setRoleModelMock,
} = vi.hoisted(() => ({
  authenticateProviderMock: vi.fn(),
  autocompletePromptMock: vi.fn(),
  handoffMock: vi.fn(),
  loadConfigMock: vi.fn(),
  loadModelsDbMock: vi.fn(),
  logInfoMock: vi.fn(),
  logSuccessMock: vi.fn(),
  runScanMock: vi.fn(),
  saveConfigMock: vi.fn(),
  selectPromptMock: vi.fn(),
  setRoleModelMock: vi.fn(),
}));

vi.mock('@doklo-beta/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/generator')>();
  return { ...actual, loadModelsDb: loadModelsDbMock };
});

vi.mock('../src/lib/authenticate.js', () => ({
  authenticateProvider: authenticateProviderMock,
}));

vi.mock('../src/lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config.js')>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
    saveConfig: saveConfigMock,
    setRoleModel: setRoleModelMock,
  };
});

vi.mock('../src/commands/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands/scan.js')>();
  return { ...actual, runScan: runScanMock };
});

vi.mock('@clack/prompts', () => ({
  autocomplete: autocompletePromptMock,
  cancel: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: logInfoMock,
    step: vi.fn(),
    success: logSuccessMock,
    warn: vi.fn(),
  },
  outro: vi.fn(),
  select: selectPromptMock,
  text: vi.fn((options: { initialValue?: string }) => options.initialValue),
}));

import { registerInitCommand } from '../src/commands/init.js';
import { takeCommandResult } from '../src/lib/command-result.js';
import { createContext } from '../src/lib/context.js';

async function nextjsTmp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-init-handoff-command-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'demo-app',
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    }),
    'utf8',
  );
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){ return null }', 'utf8');
  return root;
}

function setInteractiveTty(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  return () => {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  };
}

beforeEach(() => {
  authenticateProviderMock.mockReset();
  authenticateProviderMock.mockResolvedValue({ profileId: 'openai:default' });
  autocompletePromptMock.mockReset();
  autocompletePromptMock.mockImplementation(async (options: { options: Array<{ value: string }> }) =>
    options.options[0]?.value,
  );
  handoffMock.mockReset();
  loadConfigMock.mockReset();
  loadConfigMock.mockResolvedValue({ models: {} });
  loadModelsDbMock.mockReset();
  loadModelsDbMock.mockResolvedValue({
    openai: {
      name: 'OpenAI',
      models: { 'test-model': { id: 'test-model', name: 'Test model' } },
    },
  });
  logInfoMock.mockReset();
  logSuccessMock.mockReset();
  runScanMock.mockReset();
  runScanMock.mockResolvedValue({
    results: [{ serviceId: 'web', counts: { routes: 1, components: 1, stores: 0 } }],
    skipped: [],
  });
  saveConfigMock.mockReset();
  selectPromptMock.mockReset();
  selectPromptMock.mockImplementation(async (options: { options: Array<{ value: string }> }) =>
    options.options[0]?.value,
  );
  setRoleModelMock.mockReset();
  setRoleModelMock.mockImplementation((config, role, model) => ({
    ...config,
    models: { ...config.models, [role]: { primary: model } },
  }));
});

describe('registerInitCommand terminal-only completion', () => {
  it.each(['en', 'ko'] as const)('finishes interactive init with CLI guidance and no browser choice (%s)', async (locale) => {
    const root = await nextjsTmp();
    execFileSync('git', ['init', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'add', 'package.json', 'app']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
    const serve = vi.fn();
    const restoreTty = setInteractiveTty();
    const program = new Command();
    registerInitCommand(program, createContext(locale), { handoff: handoffMock, serve });
    try {
      await program.parseAsync(['init', '--root', root, '--no-scan'], { from: 'user' });
    } finally { restoreTty(); }
    expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).recording_branch).toBe('main');
    await access(join(root, '.claude/rules/doklo.md'));
    expect(logInfoMock).toHaveBeenCalledWith(createContext(locale).t('init.next_step_cli'));
    expect(selectPromptMock.mock.calls.flatMap(call => call[0].options ?? []).some(option => option.value === 'browser')).toBe(false);
    expect(handoffMock).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(takeCommandResult(program)).toMatchObject({ command: 'init', status: 'success' });
  });

  it('prints only the CLI next step for --yes', async () => {
    const root = await nextjsTmp();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: handoffMock, serve: vi.fn() });
    await program.parseAsync(['init', '--root', root, '--yes', '--no-scan'], { from: 'user' });
    expect(selectPromptMock).not.toHaveBeenCalled();
    expect(handoffMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith(createContext('en').t('init.next_step_cli'));
    expect(logInfoMock.mock.calls.flat().join(' ')).not.toMatch(/onboarding|serve --open|Studio/);
  });

  it('keeps --yes --json silent and includes installed skills', async () => {
    const root = await nextjsTmp();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: handoffMock, serve: vi.fn() });
    await program.parseAsync(['init', '--root', root, '--yes', '--json', '--no-scan'], { from: 'user' });
    expect(selectPromptMock).not.toHaveBeenCalled();
    expect(logInfoMock).not.toHaveBeenCalled();
    expect(handoffMock).not.toHaveBeenCalled();
    expect(takeCommandResult(program)).toMatchObject({
      command: 'init',
      status: 'success',
      data: {
        agentSkillsRequested: true,
        agentSkillsStatus: 'completed',
        agentSkillsPurpose: 'Expose existing Doklo Doks as project context to Claude Code and Codex.',
        agentSkills: expect.any(Array),
      },
    });
    expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).services[0].service_id).toBe('web');
  });

  it('supports --no-agent-skills with --yes and reports an intentional skip', async () => {
    const root = await nextjsTmp();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: handoffMock, serve: vi.fn() });

    await program.parseAsync(
      ['init', '--root', root, '--yes', '--json', '--no-scan', '--no-agent-skills'],
      { from: 'user' },
    );

    expect(takeCommandResult(program)).toMatchObject({
      command: 'init',
      status: 'success',
      data: {
        agentSkillsRequested: false,
        agentSkillsStatus: 'skipped',
        agentSkillsPurpose: 'Expose existing Doklo Doks as project context to Claude Code and Codex.',
        agentSkills: [],
      },
    });
    await expect(access(join(root, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains the skipped paths in human output without printing discovery guidance', async () => {
    const root = await nextjsTmp();
    const output: string[] = [];
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: handoffMock, serve: vi.fn() });

    try {
      await program.parseAsync(
        ['init', '--root', root, '--yes', '--no-scan', '--no-agent-skills'],
        { from: 'user' },
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(output.join('\n')).toContain(
      'Project agent integration exposes existing Doklo Doks as product context to Claude Code and Codex.',
    );
    expect(output.join('\n')).toContain('No .claude or .agents paths were inspected.');
    expect(output.join('\n')).not.toContain('Restart or refresh the client');
  });
});
