import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
const {
  authenticateProviderMock,
  autocompletePromptMock,
  loadModelsDbMock,
  selectPromptMock,
  textPromptMock,
} = vi.hoisted(() => ({
  authenticateProviderMock: vi.fn(),
  autocompletePromptMock: vi.fn(async () => 'anthropic/test-model'),
  loadModelsDbMock: vi.fn(),
  selectPromptMock: vi.fn(async (options: { options: Array<{ value: string }> }) =>
    options.options[0]?.value,
  ),
  textPromptMock: vi.fn(async (options: { initialValue?: string }) => options.initialValue),
}));
vi.mock('@doklo-beta/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/generator')>();
  return { ...actual, loadModelsDb: loadModelsDbMock };
});
vi.mock('../src/lib/authenticate.js', () => ({
  authenticateProvider: authenticateProviderMock,
}));
vi.mock('@clack/prompts', () => ({
  autocomplete: autocompletePromptMock,
  cancel: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  outro: vi.fn(),
  select: selectPromptMock,
  text: textPromptMock,
}));
import { registerGenerateCommand } from '../src/commands/generate.js';
import { registerInitCommand, runInit } from '../src/commands/init.js';
import { runScan } from '../src/commands/scan.js';
import { createContext } from '../src/lib/context.js';
import {
  assertSupportedFramework,
  assertSupportedNode,
} from '../src/lib/runtime-support.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-runtime-support-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  return root;
}

describe('assertSupportedNode', () => {
  it('enforces the Node >=20.9.0 runtime floor', () => {
    expect(() => assertSupportedNode('20.8.9')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_RUNTIME' }),
    );
    expect(() => assertSupportedNode('20.9.0')).not.toThrow();
  });

  it('requires a complete numeric major.minor.patch version', () => {
    for (const version of ['21', '21.x', '21..0', '20.9.0.1']) {
      expect(() => assertSupportedNode(version)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_RUNTIME' }),
      );
    }

    expect(() => assertSupportedNode('21.0.0')).not.toThrow();
    expect(() => assertSupportedNode('22.0.0')).not.toThrow();
  });
});

describe('assertSupportedFramework', () => {
  it.each([
    [
      'en',
      'express',
      'Detected framework: Express. Doklo 0.1.0 analyzes Next.js (App Router) projects only. NestJS and Express adapters, and an AI-draft analysis mode for other frameworks, are next on the roadmap. Updates and early access: https://doklo.io/contact',
    ],
    [
      'ko',
      'express',
      '감지된 프레임워크: Express. Doklo 0.1.0은 Next.js(App Router) 프로젝트만 분석할 수 있습니다. NestJS와 Express 어댑터, 그리고 다른 프레임워크를 위한 AI 초안 분석 기능을 다음 순서로 준비하고 있습니다. 진행 소식과 사전 이용 신청은 https://doklo.io/contact 에서 확인하실 수 있습니다.',
    ],
    [
      'en',
      'nestjs',
      'Detected framework: NestJS. Doklo 0.1.0 analyzes Next.js (App Router) projects only. NestJS and Express adapters, and an AI-draft analysis mode for other frameworks, are next on the roadmap. Updates and early access: https://doklo.io/contact',
    ],
    [
      'ko',
      'nestjs',
      '감지된 프레임워크: NestJS. Doklo 0.1.0은 Next.js(App Router) 프로젝트만 분석할 수 있습니다. NestJS와 Express 어댑터, 그리고 다른 프레임워크를 위한 AI 초안 분석 기능을 다음 순서로 준비하고 있습니다. 진행 소식과 사전 이용 신청은 https://doklo.io/contact 에서 확인하실 수 있습니다.',
    ],
    [
      'en',
      'unknown',
      'Could not detect a supported framework in package.json. Doklo 0.1.0 analyzes Next.js (App Router) projects only. NestJS and Express adapters, and an AI-draft analysis mode for other frameworks, are next on the roadmap. Updates and early access: https://doklo.io/contact',
    ],
    [
      'ko',
      'unknown',
      'package.json에서 지원 대상 프레임워크를 찾지 못했습니다. Doklo 0.1.0은 Next.js(App Router) 프로젝트만 분석할 수 있습니다. NestJS와 Express 어댑터, 그리고 다른 프레임워크를 위한 AI 초안 분석 기능을 다음 순서로 준비하고 있습니다. 진행 소식과 사전 이용 신청은 https://doklo.io/contact 에서 확인하실 수 있습니다.',
    ],
  ] as const)('uses the %s unsupported-framework guidance for %s', (locale, framework, expected) => {
    vi.stubEnv('DOKLO_LOCALE', locale);

    expect(() => assertSupportedFramework(framework)).toThrow(expected);
  });
});

describe('runtime project support gates', () => {
  it('rejects interactive Pages-only init before prompts, model data, or authentication', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'pages/index.tsx': 'export default function Page(){ return null }',
    });
    loadModelsDbMock.mockReset();
    loadModelsDbMock.mockResolvedValue({
      anthropic: {
        name: 'Anthropic',
        models: { 'test-model': { id: 'test-model', name: 'Test model' } },
      },
    });
    authenticateProviderMock.mockReset();
    authenticateProviderMock.mockRejectedValue(
      new Error('authentication reached before support validation'),
    );
    textPromptMock.mockClear();
    const program = new Command();
    registerInitCommand(program, createContext('en'));

    await expect(program.parseAsync([
      'init',
      '--root', root,
    ], { from: 'user' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_NEXTJS_PROJECT',
    });
    expect(loadModelsDbMock).not.toHaveBeenCalled();
    expect(textPromptMock).not.toHaveBeenCalled();
    expect(authenticateProviderMock).not.toHaveBeenCalled();
    await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Pages-only projects before init creates .doklo', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'pages/index.tsx': 'export default function Page(){ return null }',
    });

    await expect(runInit({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      serviceId: 'web',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_NEXTJS_PROJECT' });
    await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects Pages-only services before scan extraction', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'pages/index.tsx': 'export default function Page(){ return null }',
      'workspace.json': JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [{
          service_id: 'web',
          type: 'frontend',
          framework: 'nextjs',
          code_root: '.',
        }],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      '.doklo/cache/web.scan.json': 'existing cache',
    });
    const extractIR = vi.fn(async () => ({
      framework: 'nextjs' as const,
      root,
      files: [],
      routes: [],
      components: [],
      stores: [],
    }));

    await expect(runScan({ root }, { extractIR })).rejects.toMatchObject({
      code: 'UNSUPPORTED_NEXTJS_PROJECT',
    });
    expect(extractIR).not.toHaveBeenCalled();
    expect(await readFile(join(root, '.doklo/cache/web.scan.json'), 'utf8')).toBe('existing cache');
  });

  it('rejects Pages-only services before generate starts auto-scan', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'pages/index.tsx': 'export default function Page(){ return null }',
      'workspace.json': JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [{
          service_id: 'web',
          type: 'frontend',
          framework: 'nextjs',
          code_root: '.',
        }],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      '.doklo/hub/roles.json': JSON.stringify({ roles: [], version: 1 }),
      '.doklo/hub/doks/.gitkeep': '',
      '.doklo/cache/.gitkeep': '',
      '.doklo/debug/.gitkeep': '',
    });
    const resolveLlmForRole = vi.fn(async () => ({
      model: 'anthropic/test-model',
      providerKind: 'anthropic' as const,
      apiKey: 'test-key',
    }));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerGenerateCommand(program, createContext('en'), { resolveLlmForRole });

    try {
      await expect(program.parseAsync([
        'generate',
        '--root', root,
        '--yes',
        '--no-lexicon',
        '--no-roles',
        '--no-ia',
        '--no-code-mapping',
      ], { from: 'user' })).rejects.toMatchObject({
        code: 'UNSUPPORTED_NEXTJS_PROJECT',
      });
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(resolveLlmForRole).not.toHaveBeenCalled();
      await expect(access(join(root, '.doklo/cache/web.scan.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
