import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLivedoc, type RenderLivedocInput } from '../src/index.js';
import { assertTemplateTreeHasNoSymlinks } from '../src/path-security.js';
import { resolveTheme } from '../src/theme.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureWorkspace = join(here, 'fixtures', 'render-ws');

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Canonicalized so the only symlink in a sandbox is the one a test creates on
// purpose — on macOS the temp path is itself symlinked (/var → /private/var).
async function testDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'doklo-output-escape-'));
  scratch.push(path);
  return realpath(path);
}

/**
 * A sandbox that mirrors the real layout an attacker faces: a workspace that
 * carries the hostile template, an output directory the operator named, and a
 * sibling directory holding files the render must never reach.
 */
type Sandbox = {
  root: string;
  workspaceRoot: string;
  outDir: string;
  outsideDir: string;
  sentinelPath: string;
  sentinelBytes: string;
};

async function sandbox(): Promise<Sandbox> {
  const root = await testDirectory();
  const workspaceRoot = join(root, 'workspace');
  // Mirror the shipped command: the output directory lives inside the
  // workspace and the workspace is the containment root, so these exercise the
  // same plan-level guard `doklo live-docs render` relies on.
  const outDir = join(workspaceRoot, '.doklo', 'output', 'escape');
  const outsideDir = join(root, 'outside');
  await cp(fixtureWorkspace, workspaceRoot, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const sentinelPath = join(outsideDir, 'sentinel.md');
  const sentinelBytes = 'untouched sentinel\n';
  await writeFile(sentinelPath, sentinelBytes);
  return { root, workspaceRoot, outDir, outsideDir, sentinelPath, sentinelBytes };
}

/** Install a hostile template into the sandbox workspace registry. */
async function installTemplate(
  box: Sandbox,
  name: string,
  manifest: Record<string, unknown>,
  body = '# {{dok.dok_id}}\n',
): Promise<string> {
  const dir = join(box.workspaceRoot, '.doklo', 'templates', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'doklo-template.json'), JSON.stringify({
    name,
    version: '1.0.0',
    output_formats: ['markdown'],
    scope: 'per_dok',
    entry: 'template.md.tpl',
    supported_locales: ['en'],
    default_locale: 'en',
    ...manifest,
  }));
  await writeFile(join(dir, 'template.md.tpl'), body);
  return dir;
}

/**
 * Escape cases pin a single Dok on purpose. A per-Dok template with a constant
 * output_path produces one identical path per Dok, which trips the
 * duplicate-output check and would let these pass without containment ever
 * being consulted.
 */
function renderInput(
  box: Sandbox,
  templateRef: string,
  dokIds: string[] = ['AUTH'],
): RenderLivedocInput {
  return {
    workspaceRoot: box.workspaceRoot,
    templateRef,
    locale: 'en',
    outDir: box.outDir,
    outputRoot: box.workspaceRoot,
    dokIds,
  };
}

/** Every escape must be fail-closed: it throws AND leaves the sentinel intact. */
async function expectContained(
  box: Sandbox,
  run: () => Promise<unknown>,
): Promise<void> {
  // The message check matters: without it a duplicate-output collision or an
  // unrelated template error would satisfy "it threw" and hide a real escape.
  await expect(run()).rejects.toThrow(/outside service root/);
  expect(await readFile(box.sentinelPath, 'utf8')).toBe(box.sentinelBytes);
  expect((await readdir(box.outsideDir)).sort()).toEqual(['sentinel.md']);
}

describe('template manifest output_path containment', () => {
  it('rejects a traversing manifest output_path before writing outside the output root', async () => {
    const box = await sandbox();
    await installTemplate(box, 'escape-relative', {
      output_path: '../../../../outside/sentinel.md',
    });
    await expectContained(box, () => renderLivedoc(renderInput(box, 'escape-relative')));
  });

  it('rejects an absolute manifest output_path', async () => {
    const box = await sandbox();
    await installTemplate(box, 'escape-absolute', {
      output_path: join(box.outsideDir, 'sentinel.md'),
    });
    await expectContained(box, () => renderLivedoc(renderInput(box, 'escape-absolute')));
  });

  it('rejects a traversing per-format output_path recipe', async () => {
    const box = await sandbox();
    await installTemplate(box, 'escape-recipe', {
      output_formats: undefined,
      default_format: 'markdown',
      outputs: {
        markdown: {
          entry: 'template.md.tpl',
          output_path: '../../../../outside/sentinel.md',
          source: 'markdown',
        },
      },
    });
    await expectContained(box, () => renderLivedoc(renderInput(box, 'escape-recipe')));
  });

  it('rejects an output_path whose traversal is produced by Handlebars expansion', async () => {
    // output_path is compiled as a Handlebars template, so containment has to
    // hold on the *expanded* string — not just on the literal in the manifest.
    const box = await sandbox();
    await installTemplate(box, 'escape-expanded', {
      output_path: '{{t "escape"}}/sentinel.md',
      strings: { en: { escape: '../../../../outside' } },
    });
    await expectContained(box, () => renderLivedoc(renderInput(box, 'escape-expanded')));
  });

  it('rejects an output_path that escapes through a backslash separator', async () => {
    const box = await sandbox();
    await installTemplate(box, 'escape-backslash', {
      output_path: '..\\..\\..\\..\\outside\\sentinel.md',
    });
    await expectContained(box, () => renderLivedoc(renderInput(box, 'escape-backslash')));
  });

  it('rejects an output_path that targets a symlink escaping the output root', async () => {
    const box = await sandbox();
    await symlink(box.sentinelPath, join(box.outDir, 'linked.md'));
    await installTemplate(box, 'escape-symlink', { output_path: 'linked.md' });
    await expectContained(box, () => renderLivedoc(renderInput(box, 'escape-symlink')));
  });

  it('still renders a well-formed template into the output root', async () => {
    const box = await sandbox();
    await installTemplate(box, 'safe-template', { output_path: '{{dok.dok_id}}.md' });
    const result = await renderLivedoc(renderInput(box, 'safe-template', ['AUTH', 'BILL']));
    expect(result.manifest.outputs.length).toBeGreaterThan(0);
    expect((await readdir(box.outDir)).sort()).toEqual([
      'AUTH.md',
      'BILL.md',
      'livedoc-manifest.json',
    ]);
    expect(await readFile(box.sentinelPath, 'utf8')).toBe(box.sentinelBytes);
  });
});

describe('theme asset containment', () => {
  it('rejects a traversing cover background image', async () => {
    const box = await sandbox();
    const templateDir = await installTemplate(box, 'theme-cover', {});
    await writeFile(
      join(templateDir, 'theme.yaml'),
      'cover:\n  background_image: "../../../outside/sentinel.md"\n',
    );
    await expect(resolveTheme({
      templateDir,
      workspaceRoot: box.workspaceRoot,
      locale: 'en',
      defaultLocale: 'en',
    })).rejects.toThrow(/cover image/);
  });

  it('hands downstream readers the exact asset path containment approved', async () => {
    // pptx opens theme.logo.assetPath raw (addImage / readFileSync), so the
    // string resolveTheme returns must be the one the contained-path resolver
    // proved — not a lexically rebuilt sibling of it.
    //
    // The template is reached through a symlink the test creates, so lexical
    // and canonical differ on every platform. Leaning on the temp directory to
    // supply that difference would make this pass on a Linux runner even with
    // the lexical return restored.
    const box = await sandbox();
    const realTemplateDir = await installTemplate(box, 'theme-logo', {});
    const templateDir = join(box.root, 'linked-template');
    await mkdir(join(realTemplateDir, 'assets'), { recursive: true });
    await writeFile(join(realTemplateDir, 'assets', 'logo.png'), 'png');
    await writeFile(
      join(realTemplateDir, 'theme.yaml'),
      'logo:\n  asset: "assets/logo.png"\n  position: top-left\n',
    );
    await symlink(realTemplateDir, templateDir);
    const { theme } = await resolveTheme({
      templateDir,
      workspaceRoot: box.workspaceRoot,
      locale: 'en',
      defaultLocale: 'en',
    });
    expect(theme.logo.assetPath).toBe(join(realTemplateDir, 'assets', 'logo.png'));
    expect(theme.logo.assetPath).not.toBe(join(templateDir, 'assets', 'logo.png'));
    expect(await readFile(theme.logo.assetPath!, 'utf8')).toBe('png');
  });
});

describe('imported template tree symlink rejection', () => {
  it('rejects a symlinked directory inside an imported template tree', async () => {
    const root = await testDirectory();
    const source = join(root, 'source');
    const outside = join(root, 'outside');
    await mkdir(join(source, 'assets'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(source, 'assets', 'linked-dir'));
    await expect(assertTemplateTreeHasNoSymlinks(source, 'template source'))
      .rejects.toThrow(/symlink/i);
  });

  it('rejects a dangling symlink inside an imported template tree', async () => {
    const root = await testDirectory();
    const source = join(root, 'source');
    await mkdir(source, { recursive: true });
    await symlink(join(root, 'does-not-exist'), join(source, 'dangling'));
    await expect(assertTemplateTreeHasNoSymlinks(source, 'template source'))
      .rejects.toThrow(/symlink/i);
  });

  it('accepts a symlink-free template tree', async () => {
    const root = await testDirectory();
    const source = join(root, 'source');
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'assets', 'style.css'), 'body{}');
    await expect(assertTemplateTreeHasNoSymlinks(source, 'template source'))
      .resolves.toBeUndefined();
  });
});
