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

describe('framework-independent admission', () => {
  it.each(['unknown', 'express', 'nestjs', 'nextjs'] as const)('accepts %s without a specialist', framework => {
    expect(() => assertSupportedFramework(framework)).not.toThrow();
  });
  it.each([
    { 'main.py': 'def run(): return 1' },
    { 'package.json': '{"dependencies":{"next":"15.4.0"}}', 'pages/index.tsx': 'export default () => null;' },
  ])('initializes and scans a project without App Router', async files => {
    const root = await fixture(files);
    await runInit({ root, workspaceId: 'demo', name: 'Demo', defaultLocale: 'en', supportedLocales: ['en'], serviceId: 'app' });
    const scan = await runScan({ root });
    expect(scan.results[0]?.ir.analysis_units?.length).toBeGreaterThan(0);
    expect(scan.results[0]?.ir.routes).toEqual([]);
    expect(JSON.parse(await readFile(join(root, '.doklo/cache/app.scan.json'), 'utf8')).analysis_units.length).toBeGreaterThan(0);
  });
});
