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

  it('rejects a non-Next project before creating .doklo', async () => {
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
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_NEXTJS_PROJECT' });
    await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a declared non-Next framework before inspecting a valid App Router project', async () => {
    const root = await nextjsTmp();

    await expect(runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
      framework: 'react-native',
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FRAMEWORK',
      details: { framework: 'react-native' },
    });
    await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [
      'en',
      'Detected framework: Express. Doklo 0.1.0 analyzes Next.js (App Router) projects only. NestJS and Express adapters, and an AI-draft analysis mode for other frameworks, are next on the roadmap. Updates and early access: https://doklo.io/contact',
    ],
    [
      'ko',
      '감지된 프레임워크: Express. Doklo 0.1.0은 Next.js(App Router) 프로젝트만 분석할 수 있습니다. NestJS와 Express 어댑터, 그리고 다른 프레임워크를 위한 AI 초안 분석 기능을 다음 순서로 준비하고 있습니다. 진행 소식과 사전 이용 신청은 https://doklo.io/contact 에서 확인하실 수 있습니다.',
    ],
  ] as const)('reports a detected Express project with the %s guidance', async (locale, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-init-express-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { express: '^5.0.0' } }),
      'utf-8',
    );
    vi.stubEnv('DOKLO_LOCALE', locale);
    const program = new Command();
    registerInitCommand(program, createContext(locale));

    await expect(
      program.parseAsync(['init', '--root', root, '--yes'], { from: 'user' }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_FRAMEWORK',
      message: expected,
      details: { framework: 'express' },
    });
    await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
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
