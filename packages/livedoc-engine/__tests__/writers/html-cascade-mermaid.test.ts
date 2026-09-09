import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWriter as getPlannedWriter, type WriterContext } from '../../src/writers/index.js';
import { plannedRelativePath } from '../../src/output-plan.js';
import type { TemplateManifest } from '../../src/template-manifest.js';

function manifest(over: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    name: 't',
    version: '1.0.0',
    output_formats: ['markdown', 'html'],
    scope: 'workspace',
    output_path: 'out',
    entry: 'template.md.tpl',
    supported_locales: ['en'],
    default_locale: 'en',
    strings: {},
    requires_hub_layers: ['doks'],
    extends_default_css: true,
    ...over,
  } as TemplateManifest;
}

async function tmp<T>(fn: (d: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(join(tmpdir(), 'cascade-'));
  try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); }
}

function getWriter(format: string) {
  const writer = getPlannedWriter(format);
  return async (ctx: WriterContext & { outDir?: string; outputPath?: string }) => {
    const outputRoot = await realpath(ctx.outDir!);
    const relativePath = plannedRelativePath(ctx.outputPath!, format);
    return writer({
      ...ctx,
      outputRoot,
      plannedOutput: {
        path: join(outputRoot, relativePath),
        relative_path: relativePath,
        format,
        exists: false,
        action: 'create',
      },
    });
  };
}

describe('html cascade — template/workspace CSS overrides', () => {
  it('default-only when no template/workspace CSS exists', async () => {
    await tmp(async (outDir) => {
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('/* layer: doklo-default */');
      expect(html).not.toContain('/* layer: template */');
      expect(html).not.toContain('/* layer: workspace-branding */');
    });
  });

  it('template assets/style.css is concatenated when present', async () => {
    await tmp(async (outDir) => {
      const tmplDir = join(outDir, 'tmpl');
      await mkdir(join(tmplDir, 'assets'), { recursive: true });
      await writeFile(join(tmplDir, 'assets', 'style.css'), '.x { color: red; }');
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en', templateDir: tmplDir,
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('/* layer: template */');
      expect(html).toContain('.x { color: red; }');
    });
  });

  it('workspace .doklo/branding/livedoc.css cascades last (wins)', async () => {
    await tmp(async (outDir) => {
      const ws = join(outDir, 'ws');
      await mkdir(join(ws, '.doklo', 'branding'), { recursive: true });
      await writeFile(join(ws, '.doklo', 'branding', 'livedoc.css'), '.brand { color: blue; }');
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en', workspaceRoot: ws,
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      const defaultPos = html.indexOf('/* layer: doklo-default */');
      const brandPos = html.indexOf('/* layer: workspace-branding */');
      expect(brandPos).toBeGreaterThan(defaultPos);
      expect(html).toContain('.brand { color: blue; }');
    });
  });

  it('rejects a symlinked template assets/style.css without reading outside', async () => {
    await tmp(async (outDir) => {
      const tmplDir = join(outDir, 'tmpl');
      const external = join(outDir, 'external.css');
      await mkdir(join(tmplDir, 'assets'), { recursive: true });
      await writeFile(external, '.external { color: red; }');
      const before = await readFile(external, 'utf8');
      await symlink(external, join(tmplDir, 'assets', 'style.css'));
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en', templateDir: tmplDir,
      };

      await expect(getWriter('html')(ctx)).rejects.toThrow(/template stylesheet/);
      expect(await readFile(external, 'utf8')).toBe(before);
    });
  });

  it('rejects a symlinked workspace branding directory without reading outside', async () => {
    await tmp(async (outDir) => {
      const ws = join(outDir, 'ws');
      const externalBranding = join(outDir, 'external-branding');
      const external = join(externalBranding, 'livedoc.css');
      await mkdir(join(ws, '.doklo'), { recursive: true });
      await mkdir(externalBranding);
      await writeFile(external, '.external { color: blue; }');
      const before = await readFile(external, 'utf8');
      await symlink(externalBranding, join(ws, '.doklo', 'branding'));
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en', workspaceRoot: ws,
      };

      await expect(getWriter('html')(ctx)).rejects.toThrow(/workspace branding stylesheet/);
      expect(await readFile(external, 'utf8')).toBe(before);
    });
  });

  it('rejects a symlinked workspace livedoc.css leaf without reading outside', async () => {
    await tmp(async (outDir) => {
      const ws = join(outDir, 'ws');
      const external = join(outDir, 'external.css');
      await mkdir(join(ws, '.doklo', 'branding'), { recursive: true });
      await writeFile(external, '.external { color: blue; }');
      const before = await readFile(external, 'utf8');
      await symlink(external, join(ws, '.doklo', 'branding', 'livedoc.css'));
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en', workspaceRoot: ws,
      };

      await expect(getWriter('html')(ctx)).rejects.toThrow(/workspace branding stylesheet/);
      expect(await readFile(external, 'utf8')).toBe(before);
    });
  });

  it('propagates a non-missing template stylesheet read error', async () => {
    await tmp(async (outDir) => {
      const tmplDir = join(outDir, 'tmpl');
      await mkdir(join(tmplDir, 'assets', 'style.css'), { recursive: true });
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest(), locale: 'en', templateDir: tmplDir,
      };

      await expect(getWriter('html')(ctx)).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  it('extends_default_css: false skips the engine default layer', async () => {
    await tmp(async (outDir) => {
      const tmplDir = join(outDir, 'tmpl');
      await mkdir(join(tmplDir, 'assets'), { recursive: true });
      await writeFile(join(tmplDir, 'assets', 'style.css'), '.replace { color: green; }');
      const ctx: WriterContext = {
        outDir, outputPath: 'x', content: '# T\n',
        template: manifest({ extends_default_css: false } as Partial<TemplateManifest>),
        locale: 'en', templateDir: tmplDir,
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).not.toContain('/* layer: doklo-default */');
      expect(html).toContain('.replace { color: green; }');
    });
  });
});

describe('html mermaid integration', () => {
  it('converts ```mermaid blocks to <div class="mermaid"> + injects CDN script', async () => {
    await tmp(async (outDir) => {
      const md = '# Diagram\n\n```mermaid\ngraph LR\n  a-->b\n```\n';
      const ctx: WriterContext = {
        outDir, outputPath: 'd', content: md,
        template: manifest(), locale: 'en',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('<div class="mermaid">');
      expect(html).toContain('graph LR');
      expect(html).toContain('https://cdn.jsdelivr.net/npm/mermaid');
      // Non-mermaid code blocks unaffected
      expect(html).not.toContain('<div class="mermaid"></div>');
    });
  });

  it('does NOT inject CDN script when no mermaid blocks present', async () => {
    await tmp(async (outDir) => {
      const md = '# Plain\n\n```bash\necho hi\n```\n';
      const ctx: WriterContext = {
        outDir, outputPath: 'p', content: md,
        template: manifest(), locale: 'en',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).not.toContain('cdn.jsdelivr.net/npm/mermaid');
      expect(html).toContain('echo hi');
    });
  });
});
