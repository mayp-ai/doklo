import { afterEach, describe, it, expect, vi } from 'vitest';
import { access, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
const { loadModelsDbMock } = vi.hoisted(() => ({
  loadModelsDbMock: vi.fn(),
}));
vi.mock('@doklo-beta/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/generator')>();
  return { ...actual, loadModelsDb: loadModelsDbMock };
});
import { registerInitCommand, runInit } from '../src/commands/init.js';
import { createContext } from '../src/lib/context.js';
import { DOKLO_AGENT_SKILL } from '../src/lib/agent-skill.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function nextjsTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doklo-init-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'demo-app', dependencies: { next: '^14.0.0', react: '^18.0.0' } }),
    'utf-8',
  );
  await mkdir(join(dir, 'app'), { recursive: true });
  await writeFile(
    join(dir, 'app/page.tsx'),
    'export default function Page(){ return null }',
    'utf-8',
  );
  return dir;
}

describe('runInit', () => {
  it('installs both project skills during CLI init without changing user instructions', async () => {
    const root = await nextjsTmp();
    await writeFile(join(root, 'CLAUDE.md'), 'Keep my instructions');
    await writeFile(join(root, 'AGENTS.md'), 'Keep my other instructions');
    const program = new Command();
    registerInitCommand(program, createContext('en'));
    await program.parseAsync(['init', '--root', root, '--yes', '--no-scan', '--json'], { from: 'user' });
    for (const directory of ['.claude', '.agents']) {
      expect(await readFile(join(root, directory, 'skills/doklo/SKILL.md'), 'utf8')).toBe(DOKLO_AGENT_SKILL);
    }
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('Keep my instructions');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('Keep my other instructions');
  });

  it('reports a skill conflict while preserving the workspace and installing the other client', async () => {
    const root = await nextjsTmp();
    await mkdir(join(root, '.claude/skills/doklo'), { recursive: true });
    await writeFile(join(root, '.claude/skills/doklo/SKILL.md'), 'My own skill');
    const result = await runInit({ root, workspaceId: 'demo', name: 'Demo', defaultLocale: 'en', supportedLocales: ['en'], serviceId: 'web' });
    expect(await readFile(join(root, '.claude/skills/doklo/SKILL.md'), 'utf8')).toBe('My own skill');
    expect(await readFile(join(root, '.agents/skills/doklo/SKILL.md'), 'utf8')).toBe(DOKLO_AGENT_SKILL);
    expect(result.agentSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'claude-code', status: 'failed', code: 'conflict' }),
      expect.objectContaining({ target: 'codex', status: 'installed' }),
    ]));
    await access(join(root, 'workspace.json'));
  });

  it('requires --yes in non-TTY mode before model resolution or workspace mutation', async () => {
    const root = await nextjsTmp();
    loadModelsDbMock.mockReset();
    loadModelsDbMock.mockRejectedValue(new Error('model resolution must not run'));
    const program = new Command();
    registerInitCommand(program, createContext('en'));
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      await expect(
        program.parseAsync(['init', '--root', root], { from: 'user' }),
      ).rejects.toMatchObject({
        exitCode: 2,
        result: {
          command: 'init',
          status: 'cancelled',
        },
      });
      expect(loadModelsDbMock).not.toHaveBeenCalled();
      await expect(access(join(root, 'workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it('writes workspace.json with the auto-detected framework', async () => {
    const root = await nextjsTmp();
    const result = await runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
    });

    expect(result.framework).toBe('nextjs');
    const ws = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf-8'));
    expect(ws.services[0].framework).toBe('nextjs');
    expect(ws.services[0].service_id).toBe('web');
    expect(ws.services[0].type).toBe('frontend');
    expect(ws.services[0].code_root).toBe('.');
  });

  it('classifies the service type from the framework (nextjs → frontend)', async () => {
    const root = await nextjsTmp();
    await runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
    });
    const ws = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf-8'));
    expect(ws.services[0].type).toBe('frontend');
  });

  it('initializes a non-Next project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-init-empty-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { react: '19.0.0' } }),
      'utf-8',
    );

    await expect(runInit({
      root,
      workspaceId: 'plain',
      name: 'Plain',
      defaultLocale: 'ko',
      supportedLocales: ['ko', 'en'],
      serviceId: 'web',
    })).resolves.toMatchObject({ framework: 'unknown' });
    await access(join(root, '.doklo'));
  });

  it('preserves the declared framework as metadata', async () => {
    const root = await nextjsTmp();

    await expect(runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
      framework: 'react-native',
    })).resolves.toMatchObject({ framework: 'react-native' });
    await access(join(root, '.doklo'));
  });

  it.each(['en', 'ko'] as const)('initializes Express with locale %s', async locale => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-init-express-'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^5.0.0' } }));
    const program = new Command();
    registerInitCommand(program, createContext(locale));
    await program.parseAsync(['init', '--root', root, '--yes', '--no-scan'], { from: 'user' });
    expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).services[0].framework).toBe('express');
  });

  it('returns the resolved workspace paths (so the CLI can print them)', async () => {
    const root = await nextjsTmp();
    const result = await runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
    });
    expect(result.paths.workspaceFile).toBe(join(root, 'workspace.json'));
  });
});
