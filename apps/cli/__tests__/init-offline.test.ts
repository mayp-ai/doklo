// Honest first run: `doklo init --yes` must bootstrap a workspace with no
// network. The model registry (models.dev) only backs the *interactive*
// provider/model picker, so a non-interactive init that never shows a picker
// must not touch it — an offline or firewalled machine still gets a workspace.

import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  authenticateProviderMock,
  autocompletePromptMock,
  loadConfigMock,
  loadModelsDbMock,
  logWarnMock,
  saveConfigMock,
  selectPromptMock,
  setRoleModelMock,
} = vi.hoisted(() => ({
  authenticateProviderMock: vi.fn(),
  autocompletePromptMock: vi.fn(),
  loadConfigMock: vi.fn(),
  loadModelsDbMock: vi.fn(),
  logWarnMock: vi.fn(),
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

vi.mock('@clack/prompts', () => ({
  autocomplete: autocompletePromptMock,
  cancel: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: logWarnMock },
  outro: vi.fn(),
  select: selectPromptMock,
  text: vi.fn((options: { initialValue?: string }) => options.initialValue),
}));

import { registerInitCommand } from '../src/commands/init.js';
import { takeCommandResult } from '../src/lib/command-result.js';
import { createContext } from '../src/lib/context.js';

async function nextjsTmp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-init-offline-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'offline-app', dependencies: { next: '^14.0.0', react: '^18.0.0' } }),
    'utf8',
  );
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){ return null }', 'utf8');
  return root;
}

const OFFLINE = new Error('fetch failed: getaddrinfo ENOTFOUND models.dev');

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
  autocompletePromptMock.mockReset();
  logWarnMock.mockReset();
  authenticateProviderMock.mockResolvedValue({ profileId: 'openai:default' });
  loadConfigMock.mockReset();
  loadConfigMock.mockResolvedValue({ models: {} });
  loadModelsDbMock.mockReset();
  loadModelsDbMock.mockRejectedValue(OFFLINE);
  saveConfigMock.mockReset();
  selectPromptMock.mockReset();
  setRoleModelMock.mockReset();
  setRoleModelMock.mockImplementation((config, role, model) => ({
    ...config,
    models: { ...config.models, [role]: { primary: model } },
  }));
});

describe('offline `doklo init --yes`', () => {
  it('bootstraps the workspace without reaching the model registry', async () => {
    const root = await nextjsTmp();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: vi.fn(), serve: vi.fn() });

    await program.parseAsync(['init', '--root', root, '--yes', '--no-scan'], { from: 'user' });

    await expect(access(join(root, 'workspace.json'))).resolves.toBeUndefined();
    expect(takeCommandResult(program)).toMatchObject({ command: 'init', status: 'success' });
    expect(loadModelsDbMock).not.toHaveBeenCalled();
  });

  it('still records an explicit --model default while offline', async () => {
    const root = await nextjsTmp();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: vi.fn(), serve: vi.fn() });

    await program.parseAsync(
      ['init', '--root', root, '--yes', '--no-scan', '--model', 'anthropic/claude-sonnet-4-5'],
      { from: 'user' },
    );

    expect(loadModelsDbMock).not.toHaveBeenCalled();
    expect(setRoleModelMock).toHaveBeenCalledWith(
      { models: {} },
      'default',
      'anthropic/claude-sonnet-4-5',
    );
    expect(saveConfigMock).toHaveBeenCalledOnce();
  });

  it('keeps `--yes --json` offline-clean and machine-readable', async () => {
    const root = await nextjsTmp();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: vi.fn(), serve: vi.fn() });

    await program.parseAsync(['init', '--root', root, '--yes', '--json', '--no-scan'], { from: 'user' });

    expect(loadModelsDbMock).not.toHaveBeenCalled();
    expect(takeCommandResult(program)).toMatchObject({ command: 'init', status: 'success' });
  });
});

describe('offline interactive `doklo init`', () => {
  it('still creates the workspace when the model registry is unreachable', async () => {
    const root = await nextjsTmp();
    const handoff = vi.fn();
    const restoreTty = setInteractiveTty();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff, serve: vi.fn() });

    try {
      await program.parseAsync(['init', '--root', root, '--no-scan'], { from: 'user' });
    } finally {
      restoreTty();
    }

    await expect(access(join(root, 'workspace.json'))).resolves.toBeUndefined();
    expect(takeCommandResult(program)).toMatchObject({ command: 'init', status: 'success' });
    expect(handoff).not.toHaveBeenCalled();
  });

  it('skips the model and auth steps instead of failing, and says how to finish later', async () => {
    const root = await nextjsTmp();
    const restoreTty = setInteractiveTty();
    const program = new Command();
    registerInitCommand(program, createContext('en'), { handoff: vi.fn(), serve: vi.fn() });

    try {
      await program.parseAsync(['init', '--root', root, '--no-scan'], { from: 'user' });
    } finally {
      restoreTty();
    }

    // No provider/model choice can be offered without the registry, and
    // authenticating a provider nobody picked would be a guess.
    expect(autocompletePromptMock).not.toHaveBeenCalled();
    expect(authenticateProviderMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
    const providerPrompts = selectPromptMock.mock.calls.filter(
      ([options]: [{ message?: string }]) => options.message?.includes('provider'),
    );
    expect(providerPrompts).toEqual([]);
    // …and the user is told what is missing and how to finish it.
    const warnings = logWarnMock.mock.calls.map(([message]: [string]) => message).join('\n');
    expect(warnings).toContain('doklo model');
    expect(warnings).toContain('doklo auth');
  });

  it('localizes the degraded model-setup notice', async () => {
    const root = await nextjsTmp();
    const restoreTty = setInteractiveTty();
    const program = new Command();
    registerInitCommand(program, createContext('ko'), { handoff: vi.fn(), serve: vi.fn() });

    try {
      await program.parseAsync(['init', '--root', root, '--no-scan'], { from: 'user' });
    } finally {
      restoreTty();
    }

    const warnings = logWarnMock.mock.calls.map(([message]: [string]) => message).join('\n');
    expect(warnings).toMatch(/모델|나중에/);
    expect(warnings).toContain('doklo model');
  });
});
