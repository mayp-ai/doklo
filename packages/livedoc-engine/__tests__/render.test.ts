import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLivedoc, EngineError, type RenderLivedocInput } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ws = join(here, 'fixtures', 'render-ws');
const builtinRoot = join(here, '..', 'templates');

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'livedoc-render-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function input(over: Partial<RenderLivedocInput> = {}): RenderLivedocInput {
  return {
    workspaceRoot: ws,
    templateRef: 'hello',
    locale: 'ko',
    outDir: '/tmp/should-be-overridden',
    allFormats: true,
    ...over,
  };
}

async function writeFormatRecipeTemplate(templateRoot: string): Promise<void> {
  const templateDir = join(templateRoot, 'format-recipes');
  await mkdir(templateDir, { recursive: true });
  await writeFile(join(templateDir, 'doklo-template.json'), JSON.stringify({
    name: 'format-recipes',
    version: '1.0.0',
    default_format: 'markdown',
    outputs: {
      markdown: {
        entry: 'template.md.tpl',
        output_path: 'native-guide.md',
        source: 'markdown',
      },
      html: {
        entry: 'template.html.tpl',
        output_path: 'native-guide.html',
        source: 'html',
      },
    },
    scope: 'workspace',
    supported_locales: ['en'],
    default_locale: 'en',
  }));
  await writeFile(join(templateDir, 'template.md.tpl'), '# Native Markdown\n');
  await writeFile(
    join(templateDir, 'template.html.tpl'),
    '<section class="native-html">Native HTML</section>\n',
  );
}

describe('renderLivedoc', () => {
  it('renders per-Dok template across all active Doks in markdown + html', async () => {
    await withTmp(async (outDir) => {
      const r = await renderLivedoc(input({ outDir }));
      const files = await readdir(outDir);
      expect(files.sort()).toEqual(['AUTH.html', 'AUTH.md', 'BILL.html', 'BILL.md', 'livedoc-manifest.json']);

      const md = await readFile(join(outDir, 'AUTH.md'), 'utf-8');
      expect(md).toContain('# Email login');
      expect(md).toContain('## 소개');
      expect(md).toContain('User signs in');

      const html = await readFile(join(outDir, 'AUTH.html'), 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('lang="ko"');
      expect(html).toContain('Email login');

      expect(r.manifest.template.name).toBe('hello');
      expect(r.manifest.outputs).toHaveLength(4);
      expect(r.manifest.translation.resolved).toBeGreaterThan(0);
    });
  });

  it('dry-run produces no files but returns a manifest', async () => {
    await withTmp(async (outDir) => {
      const r = await renderLivedoc(input({ outDir, dryRun: true }));
      const files = await readdir(outDir);
      expect(files).toEqual([]);
      expect(r.manifest.outputs).toEqual([]);
      expect(r.plan.outputs.map((output) => [output.relative_path, output.format, output.action])).toEqual([
        ['AUTH.html', 'html', 'create'],
        ['AUTH.md', 'markdown', 'create'],
        ['BILL.html', 'html', 'create'],
        ['BILL.md', 'markdown', 'create'],
        ['livedoc-manifest.json', 'manifest', 'create'],
      ]);
      expect(r.plan.inputs).toMatchObject({
        template_ref: 'hello',
        template_source: 'workspace',
        dok_ids: ['AUTH', 'BILL'],
      });
      expect(r.plan.inputs.template_path).toContain('.doklo/templates/hello');
      expect(r.plan.inputs.source_paths).toEqual(expect.arrayContaining([
        expect.stringContaining('.doklo/templates/hello'),
        expect.stringContaining('.doklo/hub/doks/AUTH.json'),
        expect.stringContaining('.doklo/hub/doks/BILL.json'),
      ]));
      expect(r.plan.warnings).toEqual(r.manifest.warnings);
    });
  });

  it('fails before its first write when any planned output already exists', async () => {
    await withTmp(async (outDir) => {
      await writeFile(join(outDir, 'AUTH.md'), 'original');

      await expect(renderLivedoc(input({ outDir }))).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });

      expect((await readdir(outDir)).sort()).toEqual(['AUTH.md']);
      expect(await readFile(join(outDir, 'AUTH.md'), 'utf8')).toBe('original');
    });
  });

  it('replaces every existing planned output only with explicit overwrite', async () => {
    await withTmp(async (outDir) => {
      await writeFile(join(outDir, 'AUTH.md'), 'original');

      const r = await renderLivedoc(input({ outDir, overwrite: true }));

      expect(await readFile(join(outDir, 'AUTH.md'), 'utf8')).toContain('# Email login');
      expect(r.plan.outputs.find((output) => output.relative_path === 'AUTH.md')).toMatchObject({
        exists: true,
        action: 'overwrite',
      });
    });
  });

  it('produces canonical-identical plans and output bytes for identical inputs', async () => {
    await withTmp(async (outDir) => {
      const first = await renderLivedoc(input({ outDir }));
      const names = (await readdir(outDir)).sort();
      const firstBytes = await Promise.all(names.map((name) => readFile(join(outDir, name))));

      const second = await renderLivedoc(input({ outDir, overwrite: true }));
      const secondBytes = await Promise.all(names.map((name) => readFile(join(outDir, name))));

      expect(first.plan.outputs.map(({ exists: _exists, action: _action, ...output }) => output)).toEqual(
        second.plan.outputs.map(({ exists: _exists, action: _action, ...output }) => output),
      );
      expect(secondBytes).toEqual(firstBytes);
    });
  });

  it('dry-run does not create a missing nested output directory', async () => {
    await withTmp(async (parent) => {
      const outDir = join(parent, 'missing', 'nested');

      const result = await renderLivedoc(input({ outDir, dryRun: true }));

      expect(await readdir(parent)).toEqual([]);
      const canonicalParent = await realpath(parent);
      expect(result.plan.outputs.every((output) => output.path.startsWith(`${canonicalParent}/`))).toBe(true);
    });
  });

  it('dry-run includes warnings discovered while preparing an xlsx output', async () => {
    await withTmp(async (workspaceRoot) => {
      const doksDir = join(workspaceRoot, '.doklo', 'hub', 'doks');
      await mkdir(doksDir, { recursive: true });
      await writeFile(join(workspaceRoot, 'workspace.json'), JSON.stringify({
        workspace_id: 'xlsx-warning-test',
        name: 'XLSX warning test',
        services: [],
        default_locale: 'en',
        supported_locales: ['en'],
      }));
      await writeFile(join(doksDir, 'AUTH.json'), JSON.stringify({
        dok_id: 'AUTH',
        name: { term_ref: 'TERM-MISSING' },
        description: 'Description',
        status: 'active',
        tags: [],
        surfaces: [],
        _meta: { version: 1, history: [] },
      }));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'rtm-trace',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(workspaceRoot, 'out'),
        dryRun: true,
      });

      expect(result.plan.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'UNRESOLVED_TRANSLATABLE', field: 'TERM-MISSING' }),
      ]));
      expect(await readdir(workspaceRoot)).not.toContain('out');
    });
  });

  it('--no-html skips html writer', async () => {
    await withTmp(async (outDir) => {
      await renderLivedoc(input({ outDir, noHtml: true, allFormats: undefined }));
      const files = await readdir(outDir);
      expect(files.filter((f) => f.endsWith('.html'))).toEqual([]);
      expect(files.filter((f) => f.endsWith('.md')).length).toBe(2);
    });
  });

  it('requires explicit fan-out intent and renders each selected output recipe', async () => {
    await withTmp(async (root) => {
      const templateRoot = join(root, 'templates');
      await writeFormatRecipeTemplate(templateRoot);
      const base: RenderLivedocInput = {
        workspaceRoot: ws,
        templateRef: 'format-recipes',
        source: 'builtin',
        builtinRoot: templateRoot,
        locale: 'en',
        outDir: join(root, 'missing-intent'),
      };

      const missingIntentError = await renderLivedoc(base).catch((error: unknown) => error);
      expect(missingIntentError).toBeInstanceOf(EngineError);
      expect(missingIntentError).toMatchObject({ code: 'OUTPUT_FORMAT_REQUIRED' });
      expect((missingIntentError as Error).message).toContain('markdown');
      expect((missingIntentError as Error).message).toContain('html');
      expect(await readdir(root)).toEqual(['templates']);

      const markdown = await renderLivedoc({
        ...base,
        outDir: join(root, 'markdown'),
        format: 'markdown',
      });
      expect(markdown.outputs.map((output) => output.format)).toEqual(['markdown']);
      expect(await readFile(markdown.outputs[0]!.path, 'utf8')).toContain('Native Markdown');

      const all = await renderLivedoc({
        ...base,
        outDir: join(root, 'all'),
        allFormats: true,
      });
      expect(all.outputs.map((output) => output.format)).toEqual(['markdown', 'html']);
      expect(await readFile(all.outputs[1]!.path, 'utf8')).toContain(
        '<section class="native-html">Native HTML</section>',
      );
    });
  });

  it('dry-run plans explicit recipe outputs without writing files', async () => {
    await withTmp(async (root) => {
      const templateRoot = join(root, 'templates');
      await writeFormatRecipeTemplate(templateRoot);
      const outDir = join(root, 'dry-run');

      const result = await renderLivedoc({
        workspaceRoot: ws,
        templateRef: 'format-recipes',
        source: 'builtin',
        builtinRoot: templateRoot,
        locale: 'en',
        outDir,
        allFormats: true,
        dryRun: true,
      });

      expect(result.outputs).toEqual([]);
      expect(result.plan.outputs.map((output) => [output.relative_path, output.format])).toEqual([
        ['dry-run/livedoc-manifest.json', 'manifest'],
        ['dry-run/native-guide.html', 'html'],
        ['dry-run/native-guide.md', 'markdown'],
      ]);
      expect(await readdir(root)).toEqual(['templates']);
    });
  });

  it.each([
    { format: 'markdown' as const, allFormats: true },
    { format: 'markdown' as const, noHtml: true },
    { allFormats: true, noHtml: true },
  ])('rejects incompatible render intent %# before writing', async (renderIntent) => {
    await withTmp(async (root) => {
      const templateRoot = join(root, 'templates');
      await writeFormatRecipeTemplate(templateRoot);

      await expect(renderLivedoc({
        workspaceRoot: ws,
        templateRef: 'format-recipes',
        source: 'builtin',
        builtinRoot: templateRoot,
        locale: 'en',
        outDir: join(root, 'rejected'),
        ...renderIntent,
      })).rejects.toMatchObject({ code: 'OUTPUT_FORMAT_REJECTED' });
      expect(await readdir(root)).toEqual(['templates']);
    });
  });

  it('dokIds override selects only matching Doks', async () => {
    await withTmp(async (outDir) => {
      await renderLivedoc(input({ outDir, dokIds: ['AUTH'] }));
      const files = await readdir(outDir);
      expect(files.filter((f) => f.startsWith('AUTH')).length).toBe(2);
      expect(files.filter((f) => f.startsWith('BILL')).length).toBe(0);
    });
  });

  it('throws TEMPLATE_NOT_FOUND for missing template', async () => {
    await withTmp(async (outDir) => {
      await expect(
        renderLivedoc(input({ outDir, templateRef: 'nope' })),
      ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    });
  });

  it('throws MISSING_HUB_LAYER when workspace.json absent but template resolvable', async () => {
    await withTmp(async (outDir) => {
      // Use the fixture's templates dir as builtinRoot so template resolves,
      // but point workspaceRoot at an empty tmp dir so hub loading fails.
      try {
        await renderLivedoc(input({
          outDir,
          workspaceRoot: outDir,
          builtinRoot: join(ws, '.doklo', 'templates'),
        }));
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe('MISSING_HUB_LAYER');
      }
    });
  });
});
