import { afterEach, describe, it, expect, vi } from 'vitest';
import { access, mkdir, mkdtemp, writeFile, readFile, realpath, symlink } from 'node:fs/promises';
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
import { DOKLO_AGENT_SKILL, DOKLO_CLAUDE_RULE } from '../src/lib/agent-skill.js';

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
  it('normalizes dot, relative nested/parent, and absolute roots before inferring identity', async () => {
    const originalCwd = process.cwd();
    const parent = await mkdtemp(join(tmpdir(), 'doklo-init-relative-'));
    const cases: Array<{ name: string; cwd: string; spelling: string }> = [];
    try {
      for (const name of ['dot-app', 'dot-slash-app', 'nested-app', 'parent-app', 'absolute-app']) {
        const root = join(parent, name);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14.0.0' } }));
        await mkdir(join(root, 'app'));
        await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){ return null }');
      }
      await mkdir(join(parent, 'parent-app/child'));
      cases.push(
        { name: 'dot-app', cwd: join(parent, 'dot-app'), spelling: '.' },
        { name: 'dot-slash-app', cwd: join(parent, 'dot-slash-app'), spelling: './' },
        { name: 'nested-app', cwd: parent, spelling: 'nested-app' },
        { name: 'parent-app', cwd: join(parent, 'parent-app/child'), spelling: '..' },
        { name: 'absolute-app', cwd: parent, spelling: join(parent, 'absolute-app') },
      );

      for (const entry of cases) {
        process.chdir(entry.cwd);
        const program = new Command();
        registerInitCommand(program, createContext('en'));
        await program.parseAsync(['init', '--root', entry.spelling, '--yes', '--json', '--no-scan', '--no-agent-skills'], { from: 'user' });
        const root = join(parent, entry.name);
        const workspace = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
        expect(workspace).toMatchObject({ name: entry.name, workspace_id: entry.name });
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('falls back only the inferred ASCII slug and preserves display names and explicit ids', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doklo-init-slug-'));
    for (const [directory, args, expectedId, expectedName] of [
      ['한글-★', [], 'doklo-workspace', '한글-★'],
      ['named', ['--name', '기호 ★'], 'doklo-workspace', '기호 ★'],
      ['explicit', ['--name', '기호 ★', '--workspace-id', 'chosen-id'], 'chosen-id', '기호 ★'],
    ] as const) {
      const root = join(parent, directory);
      await mkdir(join(root, 'app'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '^14.0.0' } }));
      await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){ return null }');
      const program = new Command();
      registerInitCommand(program, createContext('en'));
      await program.parseAsync(['init', '--root', root, '--yes', '--json', '--no-scan', '--no-agent-skills', ...args], { from: 'user' });
      const workspace = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
      expect(workspace).toMatchObject({ name: expectedName, workspace_id: expectedId });
    }
  });

  it('detects repeated init across root spellings before touching agent paths', async () => {
    const originalCwd = process.cwd();
    const root = await nextjsTmp();
    try {
      process.chdir(root);
      const first = new Command();
      registerInitCommand(first, createContext('en'));
      await first.parseAsync(['init', '--root', '.', '--yes', '--json', '--no-scan', '--no-agent-skills'], { from: 'user' });
      await mkdir(join(root, '.agents/skills/doklo'), { recursive: true });
      await writeFile(join(root, '.agents/skills/doklo/SKILL.md'), 'keep me');

      const second = new Command();
      registerInitCommand(second, createContext('en'));
      await expect(second.parseAsync(['init', '--root', './', '--yes', '--json', '--no-scan'], { from: 'user' }))
        .rejects.toThrow(/already exists/i);
      expect(await readFile(join(root, '.agents/skills/doklo/SKILL.md'), 'utf8')).toBe('keep me');
    } finally {
      process.chdir(originalCwd);
    }
  });
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
    const preservedPath = await realpath(join(root, '.claude/skills/doklo/SKILL.md'));
    const result = await runInit({ root, workspaceId: 'demo', name: 'Demo', defaultLocale: 'en', supportedLocales: ['en'], serviceId: 'web' });
    expect(await readFile(join(root, '.claude/skills/doklo/SKILL.md'), 'utf8')).toBe('My own skill');
    expect(await readFile(join(root, '.agents/skills/doklo/SKILL.md'), 'utf8')).toBe(DOKLO_AGENT_SKILL);
    expect(result.agentSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'claude-code',
        status: 'preserved',
        code: 'conflict',
        path: preservedPath,
      }),
      expect.objectContaining({ target: 'codex', status: 'installed' }),
    ]));
    await access(join(root, 'workspace.json'));
  });

  it('skips agent path inspection and mutation when programmatic installation is disabled', async () => {
    const root = await nextjsTmp();
    const external = await mkdtemp(join(tmpdir(), 'doklo-init-agent-external-'));
    await writeFile(join(external, 'sentinel.txt'), 'outside');
    await symlink(external, join(root, '.claude'));
    await mkdir(join(root, '.agents/skills/doklo'), { recursive: true });
    await writeFile(join(root, '.agents/skills/doklo/SKILL.md'), 'My Codex skill');

    const result = await runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
      installAgentSkills: false,
    });

    expect(result).toMatchObject({
      agentSkillsRequested: false,
      agentSkillsStatus: 'skipped',
      agentSkillsPurpose: 'Expose existing Doklo Doks as project context to Claude Code and Codex.',
      agentSkills: [],
    });
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('outside');
    expect(await readFile(join(root, '.agents/skills/doklo/SKILL.md'), 'utf8')).toBe('My Codex skill');
  });

  it('reports exact managed files as unchanged during a fresh partial initialization', async () => {
    const root = await nextjsTmp();
    await mkdir(join(root, '.claude/skills/doklo'), { recursive: true });
    await mkdir(join(root, '.claude/rules'), { recursive: true });
    await mkdir(join(root, '.agents/skills/doklo'), { recursive: true });
    await writeFile(join(root, '.claude/skills/doklo/SKILL.md'), DOKLO_AGENT_SKILL);
    await writeFile(join(root, '.claude/rules/doklo.md'), DOKLO_CLAUDE_RULE);
    await writeFile(join(root, '.agents/skills/doklo/SKILL.md'), DOKLO_AGENT_SKILL);

    const result = await runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
    });

    expect(result).toMatchObject({
      agentSkillsRequested: true,
      agentSkillsStatus: 'completed',
      agentSkillsPurpose: 'Expose existing Doklo Doks as project context to Claude Code and Codex.',
    });
    const canonicalRoot = await realpath(root);
    expect(result.agentSkills.flatMap(skill => 'files' in skill ? skill.files : [])).toEqual([
      { path: join(canonicalRoot, '.claude/skills/doklo/SKILL.md'), status: 'unchanged' },
      { path: join(canonicalRoot, '.claude/rules/doklo.md'), status: 'unchanged' },
      { path: join(canonicalRoot, '.agents/skills/doklo/SKILL.md'), status: 'unchanged' },
    ]);
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
