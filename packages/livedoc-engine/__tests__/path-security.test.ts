import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeTemplateSegment,
  assertTemplateTreeHasNoSymlinks,
  resolveTemplatePath,
} from '../src/path-security.js';
import {
  listTemplates,
  resolveTemplate,
  TemplateNotFoundError,
} from '../src/template-loader.js';
import { parseTemplate, TemplateParseError } from '../src/template-parser.js';
import { resolveTheme } from '../src/theme.js';
import { collectScreenshots } from '../src/screenshots.js';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function testDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'doklo-template-path-'));
  testDirectories.push(path);
  return path;
}

async function writeManifest(
  dir: string,
  manifest: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(dir, 'doklo-template.json'),
    JSON.stringify({
      name: dir.slice(dir.lastIndexOf('/') + 1),
      version: '1.0.0',
      output_formats: ['markdown'],
      scope: 'workspace',
      output_path: 'output.md',
      supported_locales: ['en'],
      default_locale: 'en',
      ...manifest,
    }),
  );
}

async function writeDirectoryTemplate(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeManifest(dir);
  await writeFile(join(dir, 'template.md.tpl'), 'body');
}

async function writeSingleFileTemplate(path: string): Promise<void> {
  await writeFile(path, `---
name: single-file
version: 1.0.0
output_formats: [markdown]
scope: workspace
output_path: output.md
supported_locales: [en]
default_locale: en
---
# Single file
`);
}

describe('template path security', () => {
  it.each(['../help-page', '/tmp/help-page', 'a/b', 'a\\b', '.', '..', ''])('rejects segment %j', (value) => {
    expect(() => assertSafeTemplateSegment(value, 'template name')).toThrow(/template name/);
  });

  it('rejects an escaping relative path through the core resolver', async () => {
    const root = await testDirectory();
    await expect(resolveTemplatePath(root, '../outside.hbs', 'entry')).rejects.toThrow(/entry/);
  });

  it('rejects a symlink anywhere in an imported template tree', async () => {
    const root = await testDirectory();
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'outside.txt'), 'sentinel');
    await symlink(join(root, 'outside.txt'), join(root, 'assets', 'linked.txt'));
    await expect(assertTemplateTreeHasNoSymlinks(join(root, 'assets'), 'template source')).rejects.toThrow(/symlink/i);
  });

  it('rejects an escaping template name before loader reads', async () => {
    const root = await testDirectory();
    const escaped = join(root, '.doklo', 'outside');
    await mkdir(escaped, { recursive: true });
    await writeManifest(escaped);
    await writeFile(join(escaped, 'template.md.tpl'), 'outside');

    await expect(resolveTemplate('../outside', { workspaceRoot: root })).rejects.toThrow(/template name/);
  });

  it('rejects a symlinked workspace registry parent before stat', async () => {
    const root = await testDirectory();
    const workspaceRoot = join(root, 'workspace');
    const externalDoklo = join(root, 'external-doklo');
    const sentinel = join(externalDoklo, 'sentinel.txt');
    await mkdir(workspaceRoot);
    await writeDirectoryTemplate(join(externalDoklo, 'templates', 'safe-template'));
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');
    await symlink(externalDoklo, join(workspaceRoot, '.doklo'));

    await expect(resolveTemplate('safe-template', {
      workspaceRoot,
      userHome: join(root, 'missing-user'),
      builtinRoot: join(root, 'missing-builtin'),
    })).rejects.toThrow(/workspace template registry/);
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it('rejects a symlinked user templates registry before readdir', async () => {
    const root = await testDirectory();
    const workspaceRoot = join(root, 'workspace');
    const userHome = join(root, 'user');
    const externalTemplates = join(root, 'external-templates');
    const sentinel = join(externalTemplates, 'sentinel.txt');
    await mkdir(workspaceRoot);
    await mkdir(join(userHome, '.doklo'), { recursive: true });
    await writeDirectoryTemplate(join(externalTemplates, 'safe-template'));
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');
    await symlink(externalTemplates, join(userHome, '.doklo', 'templates'));

    await expect(listTemplates({
      workspaceRoot,
      userHome,
      builtinRoot: join(root, 'missing-builtin'),
    })).rejects.toThrow(/user template registry/);
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it('uses a custom builtin registry while missing workspace and user registries are skipped', async () => {
    const root = await testDirectory();
    const workspaceRoot = join(root, 'workspace');
    const userHome = join(root, 'user');
    const builtinRoot = join(root, 'custom-builtins');
    await mkdir(workspaceRoot);
    await mkdir(userHome);
    await writeDirectoryTemplate(join(builtinRoot, 'safe-template'));

    const resolved = await resolveTemplate('safe-template', {
      workspaceRoot,
      userHome,
      builtinRoot,
    });
    expect(resolved.source).toBe('builtin');
    expect(resolved.parsed.body).toBe('body');
  });

  it('reports not found and lists nothing when every custom registry is missing', async () => {
    const root = await testDirectory();
    const workspaceRoot = join(root, 'workspace');
    const userHome = join(root, 'user');
    const builtinRoot = join(root, 'missing-builtins');
    await mkdir(workspaceRoot);
    await mkdir(userHome);

    await expect(resolveTemplate('safe-template', {
      workspaceRoot,
      userHome,
      builtinRoot,
    })).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(listTemplates({ workspaceRoot, userHome, builtinRoot })).resolves.toEqual([]);
  });

  it('skips registries whose declared roots are themselves missing', async () => {
    const root = await testDirectory();
    const workspaceRoot = join(root, 'missing-workspace');
    const userHome = join(root, 'missing-user');
    const builtinRoot = join(root, 'missing-builtin-parent', 'templates');

    await expect(resolveTemplate('safe-template', {
      workspaceRoot,
      userHome,
      builtinRoot,
    })).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(listTemplates({ workspaceRoot, userHome, builtinRoot })).resolves.toEqual([]);
  });

  it('rejects a symlinked custom built-in registry before reading it', async () => {
    const root = await testDirectory();
    const externalBuiltins = join(root, 'external-builtins');
    const builtinRoot = join(root, 'linked-builtins');
    const sentinel = join(externalBuiltins, 'sentinel.txt');
    await writeDirectoryTemplate(join(externalBuiltins, 'safe-template'));
    await writeFile(sentinel, 'sentinel');
    const before = await readFile(sentinel, 'utf8');
    await symlink(externalBuiltins, builtinRoot);

    await expect(resolveTemplate('safe-template', {
      workspaceRoot: join(root, 'missing-workspace'),
      userHome: join(root, 'missing-user'),
      builtinRoot,
    })).rejects.toThrow(/builtin template registry/);
    expect(await readFile(sentinel, 'utf8')).toBe(before);
  });

  it('rejects an escaping manifest entry before parser reads', async () => {
    const root = await testDirectory();
    const template = join(root, 'unsafe');
    await mkdir(template);
    await writeFile(join(root, 'outside.tpl'), 'sentinel');
    await writeManifest(template, { entry: '../outside.tpl' });

    await expect(parseTemplate(template, { containmentRoot: root })).rejects.toThrow(/template entry/);
  });

  it('rejects a symlinked format-specific entry before parser reads', async () => {
    const root = await testDirectory();
    const template = join(root, 'unsafe');
    const external = join(root, 'outside.tpl');
    await mkdir(template);
    await writeFile(join(template, 'template.md.tpl'), 'body');
    await writeFile(external, 'sentinel');
    await symlink(external, join(template, 'template.html.tpl'));
    await writeManifest(template, {
      default_format: 'markdown',
      outputs: {
        markdown: { entry: 'template.md.tpl', output_path: 'output.md', source: 'markdown' },
        html: { entry: 'template.html.tpl', output_path: 'output.html', source: 'html' },
      },
    });

    await expect(parseTemplate(template, { containmentRoot: root })).rejects.toThrow(/template entry/);
  });

  it('rejects a traversing binary entry before parser reads', async () => {
    const root = await testDirectory();
    const template = join(root, 'unsafe');
    await mkdir(template);
    await writeManifest(template, {
      renderer: 'pptx',
      scope: 'per_dok',
      default_format: 'pptx',
      outputs: {
        pptx: { entry: '../outside.pptx', output_path: 'deck.pptx', source: 'binary' },
      },
    });

    await expect(parseTemplate(template, { containmentRoot: root })).rejects.toThrow(/template entry/);
  });

  it('rejects a symlinked binary entry before parser reads', async () => {
    const root = await testDirectory();
    const template = join(root, 'unsafe');
    const external = join(root, 'outside.pptx');
    await mkdir(template);
    await writeFile(external, 'sentinel');
    await symlink(external, join(template, 'deck.pptx'));
    await writeManifest(template, {
      renderer: 'pptx',
      scope: 'per_dok',
      default_format: 'pptx',
      outputs: {
        pptx: { entry: 'deck.pptx', output_path: 'deck.pptx', source: 'binary' },
      },
    });

    await expect(parseTemplate(template, { containmentRoot: root })).rejects.toThrow(/template entry/);
  });

  it('rejects an escaping manifest partial before parser reads', async () => {
    const root = await testDirectory();
    const template = join(root, 'unsafe');
    await mkdir(template);
    await writeFile(join(template, 'template.md.tpl'), 'body');
    await writeFile(join(root, 'outside.tpl'), 'sentinel');
    await writeManifest(template, { partials: { footer: '../outside.tpl' } });

    await expect(parseTemplate(template, { containmentRoot: root })).rejects.toThrow(/template partial 'footer'/);
  });

  it('rejects a symlinked single-file template leaf before reading', async () => {
    const root = await testDirectory();
    const external = join(root, 'external.tpl');
    const linked = join(root, 'linked.tpl');
    await writeSingleFileTemplate(external);
    const before = await readFile(external, 'utf8');
    await symlink(external, linked);

    await expect(parseTemplate(linked, { containmentRoot: root })).rejects.toThrow(/template path/);
    expect(await readFile(external, 'utf8')).toBe(before);
  });

  it('rejects a single-file template below a symlinked directory before reading', async () => {
    const root = await testDirectory();
    const externalDir = join(root, 'external-dir');
    const linkedDir = join(root, 'linked-dir');
    const external = join(externalDir, 'single.tpl');
    await mkdir(externalDir);
    await writeSingleFileTemplate(external);
    const before = await readFile(external, 'utf8');
    await symlink(externalDir, linkedDir);

    await expect(parseTemplate(
      join(linkedDir, 'single.tpl'),
      { containmentRoot: root },
    )).rejects.toThrow(/template path/);
    expect(await readFile(external, 'utf8')).toBe(before);
  });

  it('rejects a single-file template below a deeper symlinked ancestor supplied under a trusted root', async () => {
    const root = await testDirectory();
    const externalDir = join(root, 'external-dir');
    const external = join(externalDir, 'nested', 'single.tpl');
    const linkedDir = join(root, 'linked');
    await mkdir(join(externalDir, 'nested'), { recursive: true });
    await writeSingleFileTemplate(external);
    const before = await readFile(external, 'utf8');
    await symlink(externalDir, linkedDir);

    await expect(parseTemplate(
      join(linkedDir, 'nested', 'single.tpl'),
      { containmentRoot: root },
    )).rejects.toThrow(/template path/);
    expect(await readFile(external, 'utf8')).toBe(before);
  });

  it('classifies a path below multiple missing parent segments as a missing template', async () => {
    const root = await testDirectory();
    const missing = join(root, 'missing', 'nested', 'single.tpl');

    await expect(parseTemplate(missing, { containmentRoot: root })).rejects.toMatchObject({
      name: 'TemplateParseError',
      message: expect.stringContaining('Template path does not exist'),
    });
    await expect(parseTemplate(missing, { containmentRoot: root })).rejects.toBeInstanceOf(
      TemplateParseError,
    );
  });

  it('resolves a relative template path from its caller-provided containment root', async () => {
    const root = await testDirectory();
    const relativePath = join('nested', 'single.tpl');
    await mkdir(join(root, 'nested'));
    await writeSingleFileTemplate(join(root, relativePath));

    const parsed = await parseTemplate(relativePath, { containmentRoot: root });
    expect(parsed.manifest.name).toBe('single-file');
  });

  it('parses an absolute directory template outside cwd with the one-argument API', async () => {
    const root = await testDirectory();
    const template = join(root, 'absolute-template');
    await writeDirectoryTemplate(template);

    const parsed = await parseTemplate(template);
    expect(parsed.manifest.name).toBe('absolute-template');
    expect(parsed.singleFile).toBe(false);
  });

  it('parses an absolute single-file template outside cwd with the one-argument API', async () => {
    const root = await testDirectory();
    const template = join(root, 'absolute.tpl');
    await writeSingleFileTemplate(template);

    const parsed = await parseTemplate(template);
    expect(parsed.manifest.name).toBe('single-file');
    expect(parsed.singleFile).toBe(true);
  });

  it('rejects a symlinked directory-template root before reading its manifest', async () => {
    const root = await testDirectory();
    const externalDir = join(root, 'external-template');
    const linkedDir = join(root, 'linked-template');
    await mkdir(externalDir);
    await writeManifest(externalDir, { name: 'linked-template' });
    await writeFile(join(externalDir, 'template.md.tpl'), 'external body');
    const before = await readFile(join(externalDir, 'doklo-template.json'), 'utf8');
    await symlink(externalDir, linkedDir);

    await expect(parseTemplate(linkedDir, { containmentRoot: root })).rejects.toThrow(/template path/);
    expect(await readFile(join(externalDir, 'doklo-template.json'), 'utf8')).toBe(before);
  });

  it('rejects an escaping theme asset before checking the file', async () => {
    const root = await testDirectory();
    const template = join(root, 'theme-template');
    await mkdir(template);
    await writeFile(join(root, 'outside.png'), 'sentinel');
    await writeFile(join(template, 'theme.yaml'), 'logo:\n  asset: "../outside.png"\n');

    await expect(resolveTheme({
      templateDir: template,
      workspaceRoot: root,
      locale: 'en',
      defaultLocale: 'en',
    })).rejects.toThrow(/logo asset/);
  });

  it('rejects an escaping screenshot DOK ID before copying', async () => {
    const root = await testDirectory();
    const escaped = join(root, '.doklo', 'outside');
    await mkdir(escaped, { recursive: true });
    await writeFile(join(escaped, 'step-1.png'), 'sentinel');

    await expect(collectScreenshots({
      workspaceRoot: root,
      dokId: '../outside',
      outDir: join(root, 'out'),
      stepCount: 1,
    })).rejects.toThrow(/screenshot DOK ID/);
  });

  it('rejects a symlinked screenshot before copying', async () => {
    const root = await testDirectory();
    const source = join(root, '.doklo', 'screenshots', 'DOK');
    await mkdir(source, { recursive: true });
    await writeFile(join(root, 'outside.png'), 'sentinel');
    await symlink(join(root, 'outside.png'), join(source, 'step-1.png'));

    await expect(collectScreenshots({
      workspaceRoot: root,
      dokId: 'DOK',
      outDir: join(root, 'out'),
      stepCount: 1,
    })).rejects.toThrow(/screenshot/);
  });
});
