import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failingStatPaths = vi.hoisted(() => new Map<string, string>());
const failingReaddirPaths = vi.hoisted(() => new Map<string, string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const code = failingStatPaths.get(String(args[0]));
      if (code) {
        throw Object.assign(new Error(`injected stat ${code}`), { code });
      }
      return actual.stat(...args);
    },
    readdir: async (...args: any[]) => {
      const code = failingReaddirPaths.get(String(args[0]));
      if (code) {
        throw Object.assign(new Error(`injected readdir ${code}`), { code });
      }
      return (actual.readdir as (...values: any[]) => any)(...args);
    },
  };
});

import { resolveTemplate } from '../src/template-loader.js';
import { listTemplateDirs, parseTemplate } from '../src/template-parser.js';

const testDirectories: string[] = [];

afterEach(async () => {
  failingStatPaths.clear();
  failingReaddirPaths.clear();
  await Promise.all(testDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('template registry existence errors', () => {
  it('propagates a non-missing stat error for an existing registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-template-loader-error-'));
    testDirectories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const registryRoot = join(workspaceRoot, '.doklo', 'templates');
    await mkdir(registryRoot, { recursive: true });
    failingStatPaths.set(await realpath(registryRoot), 'EACCES');

    await expect(resolveTemplate('safe-template', {
      workspaceRoot,
      userHome: join(root, 'missing-user'),
      builtinRoot: join(root, 'missing-builtin'),
    })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('propagates a non-missing stat error while checking optional template assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-template-parser-error-'));
    testDirectories.push(root);
    const template = join(root, 'safe-template');
    const assets = join(template, 'assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(template, 'doklo-template.json'), JSON.stringify({
      name: 'safe-template',
      version: '1.0.0',
      output_formats: ['markdown'],
      scope: 'workspace',
      output_path: 'output.md',
      entry: 'template.md.tpl',
      supported_locales: ['en'],
      default_locale: 'en',
    }));
    await writeFile(join(template, 'template.md.tpl'), 'body');
    failingStatPaths.set(await realpath(assets), 'EACCES');

    await expect(parseTemplate(template, { containmentRoot: root }))
      .rejects.toMatchObject({ code: 'EACCES' });
  });

  it('propagates a non-missing readdir error while listing template directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-template-parser-error-'));
    testDirectories.push(root);
    failingReaddirPaths.set(await realpath(root), 'EIO');

    await expect(listTemplateDirs(root)).rejects.toMatchObject({ code: 'EIO' });
  });

  it('propagates a non-missing manifest stat error while listing templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-template-parser-error-'));
    testDirectories.push(root);
    const template = join(root, 'safe-template');
    const manifest = join(template, 'doklo-template.json');
    await mkdir(template);
    await writeFile(manifest, '{}');
    failingStatPaths.set(await realpath(manifest), 'EIO');

    await expect(listTemplateDirs(root)).rejects.toMatchObject({ code: 'EIO' });
  });
});
