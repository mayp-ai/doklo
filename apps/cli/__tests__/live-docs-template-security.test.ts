import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockedOs = vi.hoisted(() => ({ userHome: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => mockedOs.userHome };
});

import { addAction } from '../src/commands/template-add.js';
import { removeAction } from '../src/commands/template-remove.js';
import { scaffoldAction } from '../src/commands/template-scaffold.js';
import { validateAction } from '../src/commands/template-validate.js';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'doklo-cli-template-security-'));
  testDirectories.push(path);
  mockedOs.userHome = join(path, 'home');
  await mkdir(mockedOs.userHome, { recursive: true });
  return path;
}

async function writeTemplate(root: string, name = 'safe-template'): Promise<string> {
  const source = join(root, name);
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'doklo-template.json'), JSON.stringify({
    name,
    version: '1.0.0',
    output_formats: ['markdown'],
    scope: 'workspace',
    output_path: 'output.md',
    entry: 'template.md.tpl',
    supported_locales: ['en'],
    default_locale: 'en',
  }));
  await writeFile(join(source, 'template.md.tpl'), 'body');
  return source;
}

describe('Live Docs template mutation security', () => {
  it('installs a local template from a relative source path', async () => {
    const root = await testDirectory();
    await writeTemplate(root, 'my-template');
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      await addAction({
        src: './my-template',
        yes: true,
        userHome: mockedOs.userHome,
      });
    } finally {
      process.chdir(previousCwd);
    }

    await expect(readFile(
      join(mockedOs.userHome, '.doklo', 'templates', 'my-template', 'template.md.tpl'),
      'utf8',
    )).resolves.toBe('body');
  });

  it('validates an absolute template directory outside cwd without changing cwd', async () => {
    const root = await testDirectory();
    const source = await writeTemplate(root, 'absolute-template');
    const previousCwd = process.cwd();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      await expect(validateAction({ path: source })).resolves.toBe(true);
      expect(process.cwd()).toBe(previousCwd);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('rejects an imported template tree containing a symlink', async () => {
    const root = await testDirectory();
    const source = await writeTemplate(root);
    await writeFile(join(root, 'outside.txt'), 'sentinel');
    await symlink(join(root, 'outside.txt'), join(source, 'assets', 'linked.txt'));

    await expect(addAction({
      src: source,
      yes: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/symlink/i);
    await expect(stat(join(mockedOs.userHome, '.doklo', 'templates', 'safe-template'))).rejects.toThrow();
  });

  it('leaves the external sentinel unchanged when add receives an escaping name', async () => {
    const root = await testDirectory();
    const source = await writeTemplate(root);
    const sentinel = join(mockedOs.userHome, '.doklo', 'sentinel');
    await mkdir(join(mockedOs.userHome, '.doklo'), { recursive: true });
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');

    await expect(addAction({
      src: source,
      name: '../sentinel',
      yes: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template name/);
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it('rejects an absolute add name', async () => {
    const root = await testDirectory();
    const source = await writeTemplate(root);

    await expect(addAction({
      src: source,
      name: join(root, 'absolute-template'),
      yes: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template name/);
  });

  it('rejects a symlinked add destination leaf without changing its target', async () => {
    const root = await testDirectory();
    const source = await writeTemplate(root);
    const templatesRoot = join(mockedOs.userHome, '.doklo', 'templates');
    const external = join(root, 'external-destination');
    await mkdir(templatesRoot, { recursive: true });
    await mkdir(external);
    await writeFile(join(external, 'sentinel.txt'), 'sentinel');
    const before = await readFile(join(external, 'sentinel.txt'), 'utf8');
    await symlink(external, join(templatesRoot, 'safe-template'));

    await expect(addAction({
      src: source,
      yes: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template destination/);
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe(before);
  });

  it('rejects a symlinked .doklo destination parent before add', async () => {
    const root = await testDirectory();
    const source = await writeTemplate(root);
    const externalDoklo = join(root, 'external-doklo');
    const sentinel = join(externalDoklo, 'sentinel.txt');
    await mkdir(externalDoklo);
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');
    await symlink(externalDoklo, join(mockedOs.userHome, '.doklo'));

    await expect(addAction({
      src: source,
      yes: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it('leaves the external sentinel unchanged when remove receives an escaping name', async () => {
    await testDirectory();
    const sentinel = join(mockedOs.userHome, '.doklo', 'sentinel');
    await mkdir(join(mockedOs.userHome, '.doklo'), { recursive: true });
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');

    await expect(removeAction({ name: '../sentinel', userHome: mockedOs.userHome })).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it('rejects an absolute remove name as a template-name error', async () => {
    const root = await testDirectory();

    await expect(removeAction({
      name: join(root, 'absolute-template'),
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template name/);
  });

  it('rejects a symlinked installed destination before remove', async () => {
    const root = await testDirectory();
    const templatesRoot = join(mockedOs.userHome, '.doklo', 'templates');
    const external = join(root, 'external');
    await mkdir(templatesRoot, { recursive: true });
    await mkdir(external);
    await writeFile(join(external, 'sentinel.txt'), 'sentinel');
    await symlink(external, join(templatesRoot, 'linked-template'));

    await expect(removeAction({
      name: 'linked-template',
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template destination/);
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('sentinel');
  });

  it('rejects a symlinked installed templates parent before remove', async () => {
    const root = await testDirectory();
    const dokloRoot = join(mockedOs.userHome, '.doklo');
    const externalTemplates = join(root, 'external-templates');
    const sentinel = join(externalTemplates, 'sentinel.txt');
    await mkdir(dokloRoot);
    await mkdir(externalTemplates);
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');
    await symlink(externalTemplates, join(dokloRoot, 'templates'));

    await expect(removeAction({
      name: 'safe-template',
      userHome: mockedOs.userHome,
    })).rejects.toThrow();
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it.each(['../sentinel', '/tmp/sentinel'])('rejects scaffold name %j', async (name) => {
    const root = await testDirectory();

    await expect(scaffoldAction({
      name,
      scope: 'workspace',
      dest: 'workspace',
      root,
      force: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template name/);
  });

  it('rejects a symlinked scaffold destination without changing its target', async () => {
    const root = await testDirectory();
    const templatesRoot = join(root, '.doklo', 'templates');
    const external = join(root, 'external');
    await mkdir(templatesRoot, { recursive: true });
    await mkdir(external);
    await writeFile(join(external, 'sentinel.txt'), 'sentinel');
    await symlink(external, join(templatesRoot, 'linked-template'));

    await expect(scaffoldAction({
      name: 'linked-template',
      scope: 'workspace',
      dest: 'workspace',
      root,
      force: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template destination/);
    expect(await readFile(join(external, 'sentinel.txt'), 'utf8')).toBe('sentinel');
  });

  it('rejects a symlinked scaffold assets parent without changing its target', async () => {
    const root = await testDirectory();
    const templateDir = join(root, '.doklo', 'templates', 'safe-template');
    const externalAssets = join(root, 'external-assets');
    const sentinel = join(externalAssets, 'sentinel.txt');
    await mkdir(templateDir, { recursive: true });
    await mkdir(externalAssets);
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');
    await symlink(externalAssets, join(templateDir, 'assets'));

    await expect(scaffoldAction({
      name: 'safe-template',
      scope: 'workspace',
      dest: 'workspace',
      root,
      force: true,
      userHome: mockedOs.userHome,
    })).rejects.toThrow(/template assets/);
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });
});
