import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTemplate, TemplateParseError } from '../src/template-parser.js';
import { parseTemplateManifest } from '../src/template-manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (...p: string[]) => join(here, 'fixtures', 'templates', ...p);
const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function formatSpecificDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-format-specific-'));
  const templateDir = join(root, 'format-specific');
  testDirectories.push(root);
  await mkdir(templateDir);
  await writeFile(join(templateDir, 'doklo-template.json'), JSON.stringify({
    name: 'format-specific',
    version: '1.0.0',
    scope: 'workspace',
    default_format: 'markdown',
    outputs: {
      markdown: { entry: 'template.md.tpl', output_path: 'doc.md', source: 'markdown' },
      html: { entry: 'template.html.tpl', output_path: 'doc.html', source: 'html' },
    },
    supported_locales: ['en'],
    default_locale: 'en',
  }));
  await writeFile(join(templateDir, 'template.md.tpl'), '# Native Markdown\n');
  await writeFile(join(templateDir, 'template.html.tpl'), '<section>Native HTML</section>\n');
  return templateDir;
}

async function formatSpecificSingleFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-format-specific-single-'));
  const file = join(root, 'format-specific.tpl');
  testDirectories.push(root);
  await writeFile(file, `---\nname: format-specific-single\nversion: 1.0.0\nscope: workspace\ndefault_format: markdown\noutputs:\n  markdown:\n    output_path: doc.md\n    source: markdown\n  html:\n    output_path: doc.html\n    source: markdown\nsupported_locales: [en]\ndefault_locale: en\n---\n# Shared frontmatter body\n`);
  return file;
}
const baseManifest = {
  name: 'format-test',
  version: '1.0.0',
  scope: 'workspace' as const,
  supported_locales: ['en'],
  default_locale: 'en',
};

describe('parseTemplateManifest', () => {
  it('normalizes canonical output recipes with the default first', () => {
    const manifest = parseTemplateManifest({
      ...baseManifest,
      default_format: 'markdown',
      outputs: {
        html: { entry: 'template.html.tpl', output_path: 'doc.html', source: 'html' },
        markdown: { entry: 'template.md.tpl', output_path: 'doc.md', source: 'markdown' },
      },
    });

    expect(manifest.default_format).toBe('markdown');
    expect(manifest.output_formats).toEqual(['markdown', 'html']);
    expect(manifest.outputs.html?.source).toBe('html');
  });

  it('normalizes a legacy markdown/html manifest as shared Markdown source', () => {
    const manifest = parseTemplateManifest({
      ...baseManifest,
      output_formats: ['markdown', 'html'],
      entry: 'template.md.tpl',
      output_path: 'doc',
    });

    expect(manifest.default_format).toBe('markdown');
    expect(manifest.outputs).toEqual({
      markdown: { entry: 'template.md.tpl', output_path: 'doc', source: 'markdown' },
      html: { entry: 'template.md.tpl', output_path: 'doc', source: 'markdown' },
    });
  });

  it('rejects ambiguous legacy output families', () => {
    expect(() => parseTemplateManifest({
      ...baseManifest,
      output_formats: ['markdown', 'json'],
      entry: 'template.md.tpl',
      output_path: 'doc',
    })).toThrow(/explicit output recipes/i);
  });

  it('rejects an incompatible canonical source and final-format pair', () => {
    expect(() => parseTemplateManifest({
      ...baseManifest,
      outputs: {
        markdown: { entry: 'template.html.tpl', output_path: 'doc.md', source: 'html' },
      },
    })).toThrow(/source 'html'.*final format 'markdown'/i);
  });

  it('requires default_format for canonical multi-output manifests', () => {
    expect(() => parseTemplateManifest({
      ...baseManifest,
      outputs: {
        markdown: { entry: 'template.md.tpl', output_path: 'doc.md', source: 'markdown' },
        html: { entry: 'template.md.tpl', output_path: 'doc.html', source: 'markdown' },
      },
    })).toThrow(/default_format/i);
  });

  it('derives the default and compatibility views for canonical single-output manifests', () => {
    const manifest = parseTemplateManifest({
      ...baseManifest,
      outputs: {
        html: { entry: 'template.html.tpl', output_path: 'doc.html', source: 'html' },
      },
    });

    expect(manifest.default_format).toBe('html');
    expect(manifest.output_formats).toEqual(['html']);
    expect(manifest.entry).toBe('template.html.tpl');
    expect(manifest.output_path).toBe('doc.html');
  });

  it('retains the canonical PPTX and XLSX renderer invariants', () => {
    expect(() => parseTemplateManifest({
      ...baseManifest,
      renderer: 'pptx',
      scope: 'per_dok',
      default_format: 'pptx',
      outputs: {
        pptx: { output_path: 'doc.pptx', source: 'binary' },
        markdown: { entry: 'template.md.tpl', output_path: 'doc.md', source: 'markdown' },
      },
    })).toThrow(/renderer:'pptx'.*only declare output formats/i);

    expect(() => parseTemplateManifest({
      ...baseManifest,
      renderer: 'xlsx',
      default_format: 'xlsx',
      outputs: {
        xlsx: { output_path: 'doc.xlsx', source: 'binary' },
        markdown: { entry: 'template.md.tpl', output_path: 'doc.md', source: 'markdown' },
      },
    })).toThrow(/renderer:'xlsx'.*only declare output formats/i);
  });

  it('accepts a minimal valid manifest', () => {
    const m = parseTemplateManifest({
      name: 'x',
      version: '1.0.0',
      output_formats: ['markdown'],
      scope: 'workspace',
      output_path: 'x.md',
      supported_locales: ['en'],
      default_locale: 'en',
    });
    expect(m.name).toBe('x');
    expect(m.entry).toBe('template.md.tpl');
  });

  it('rejects pptx in output_formats without renderer:pptx', () => {
    expect(() =>
      parseTemplateManifest({
        name: 'x',
        version: '1.0.0',
        output_formats: ['pptx'],
        scope: 'workspace',
        output_path: 'x.pptx',
        supported_locales: ['en'],
        default_locale: 'en',
      }),
    ).toThrow();
  });

  it('accepts pptx with renderer:pptx + per_dok', () => {
    const m = parseTemplateManifest({
      name: 'ppt',
      version: '1.0.0',
      renderer: 'pptx',
      output_formats: ['pptx'],
      scope: 'per_dok',
      output_path: '{{dok.dok_id}}',
      supported_locales: ['ko'],
      default_locale: 'ko',
    });
    expect(m.renderer).toBe('pptx');
  });

  it('rejects renderer:pptx with non-per_dok scope', () => {
    expect(() =>
      parseTemplateManifest({
        name: 'ppt',
        version: '1.0.0',
        renderer: 'pptx',
        output_formats: ['pptx'],
        scope: 'workspace',
        output_path: 'x',
        supported_locales: ['ko'],
        default_locale: 'ko',
      }),
    ).toThrow(/per_dok/);
  });

  it('rejects renderer:pptx mixing pptx with text formats', () => {
    expect(() =>
      parseTemplateManifest({
        name: 'ppt',
        version: '1.0.0',
        renderer: 'pptx',
        output_formats: ['pptx', 'markdown'],
        scope: 'per_dok',
        output_path: 'x',
        supported_locales: ['ko'],
        default_locale: 'ko',
      }),
    ).toThrow();
  });

  it.each([
    { format: 'pptx', renderer: 'pptx', scope: 'per_dok' },
    { format: 'xlsx', renderer: 'xlsx', scope: 'workspace' },
    { format: 'hwpx', renderer: 'handlebars', scope: 'workspace' },
  ] as const)('rejects unvalidated $format output for a stable template', ({ format, renderer, scope }) => {
    expect(() => parseTemplateManifest({
      name: `stable-${format}`,
      version: '1.0.0',
      stability: 'stable',
      audience: { en: 'Customers' },
      purpose: { en: 'Explain a product task.' },
      job: { en: 'Complete the product task.' },
      required_input: { en: 'Reviewed product context' },
      variables: {},
      renderer,
      output_formats: [format],
      scope,
      output_path: `publication.${format}`,
      supported_locales: ['en'],
      default_locale: 'en',
    })).toThrow(/stable.*validated|validated.*stable/i);
  });

  it('rejects selected_doks scope without selector', () => {
    expect(() =>
      parseTemplateManifest({
        name: 'x',
        version: '1.0.0',
        output_formats: ['markdown'],
        scope: 'selected_doks',
        output_path: 'x.md',
        supported_locales: ['en'],
        default_locale: 'en',
      }),
    ).toThrow(/selector/);
  });

  it('rejects default_locale not in supported_locales', () => {
    expect(() =>
      parseTemplateManifest({
        name: 'x',
        version: '1.0.0',
        output_formats: ['markdown'],
        scope: 'workspace',
        output_path: 'x.md',
        supported_locales: ['en'],
        default_locale: 'ko',
      }),
    ).toThrow();
  });

  it('rejects non-kebab name', () => {
    expect(() =>
      parseTemplateManifest({
        name: 'Bad Name',
        version: '1.0.0',
        output_formats: ['markdown'],
        scope: 'workspace',
        output_path: 'x.md',
        supported_locales: ['en'],
        default_locale: 'en',
      }),
    ).toThrow();
  });
});

describe('parseTemplate (directory)', () => {
  it('parses a minimal directory template', async () => {
    const t = await parseTemplate(fix('minimal'));
    expect(t.manifest.name).toBe('minimal');
    expect(t.body).toContain('{{translate dok.name}}');
    expect(t.partials.size).toBe(0);
    expect(t.singleFile).toBe(false);
  });

  it('throws when directory name does not match manifest.name', async () => {
    await expect(parseTemplate(fix('bad-name-mismatch'))).rejects.toBeInstanceOf(
      TemplateParseError,
    );
  });

  it('throws on nonexistent path', async () => {
    await expect(parseTemplate(fix('does-not-exist'))).rejects.toBeInstanceOf(
      TemplateParseError,
    );
  });

  it('loads every canonical directory entry by final format', async () => {
    const parsed = await parseTemplate(await formatSpecificDirectory());

    expect(parsed.outputs.get('markdown')?.body).toBe('# Native Markdown\n');
    expect(parsed.outputs.get('html')?.body).toBe('<section>Native HTML</section>\n');
    expect(parsed.body).toBe('# Native Markdown\n');
  });

  it('rejects a missing unselected declared entry', async () => {
    const templateDir = await formatSpecificDirectory();
    await rm(join(templateDir, 'template.html.tpl'));

    await expect(parseTemplate(templateDir)).rejects.toThrow(/template\.html\.tpl/);
  });
});

describe('parseTemplate (single file)', () => {
  it('parses a single-file template with frontmatter', async () => {
    const t = await parseTemplate(fix('single-file.md.tpl'));
    expect(t.singleFile).toBe(true);
    expect(t.manifest.name).toBe('single-file');
    expect(t.body).toContain('# Single file template');
  });

  it('shares the frontmatter body across compatible single-file outputs', async () => {
    const parsed = await parseTemplate(await formatSpecificSingleFile());

    expect(parsed.outputs.get('markdown')?.body).toBe('# Shared frontmatter body\n');
    expect(parsed.outputs.get('html')?.body).toBe(parsed.outputs.get('markdown')?.body);
    expect(parsed.body).toBe(parsed.outputs.get('markdown')?.body);
  });

  it('rejects an explicit output entry in single-file frontmatter', async () => {
    const file = await formatSpecificSingleFile();
    const raw = await readFile(file, 'utf8');
    await writeFile(file, raw.replace('output_path: doc.md', 'entry: template.md.tpl\n    output_path: doc.md'));

    await expect(parseTemplate(file)).rejects.toThrow(/entry/i);
  });
});
