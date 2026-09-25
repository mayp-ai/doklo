import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { parseTemplate } from '../src/template-parser.js';
import * as manifestModule from '../src/template-manifest.js';
import type { TemplateManifest } from '../src/template-manifest.js';
import { listTemplates } from '../src/template-loader.js';
import type { ListEntry, ResolveOptions } from '../src/template-loader.js';
import { renderLivedoc } from '../src/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const builtinRoot = join(here, '..', 'templates');
const stableBuiltins = [
  'feature-matrix',
  'github-onboarding',
  'help-index',
  'help-page',
  'keep-a-changelog',
  'permission-gap',
  'release-digest',
] as const;
const promotedStableBuiltins = stableBuiltins.filter((name) => name !== 'help-page');

async function builtIns() {
  const names = (await readdir(builtinRoot)).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    manifest: (await parseTemplate(join(builtinRoot, name))).manifest,
  })));
}

describe('built-in template publication contract', () => {
  it('publishes exactly the seven approved stable built-ins at release versions', async () => {
    const templates = await builtIns();

    const stable = templates.filter(({ manifest }) => manifest.stability === 'stable');
    expect(stable.map(({ name }) => name)).toEqual(stableBuiltins);
    for (const { manifest } of stable) {
      expect(Number(manifest.version.split('.')[0])).toBeGreaterThanOrEqual(1);
    }
    expect(
      templates
        .filter(({ manifest }) => manifest.stability === 'experimental')
        .map(({ name }) => name),
    ).toHaveLength(templates.length - stableBuiltins.length);
  });

  it('publishes audience, purpose, job, required input, variables, output, and stability for every built-in', async () => {
    const templates = await builtIns();

    for (const { manifest } of templates) {
      expect(manifest.audience).toMatchObject({ en: expect.any(String), ko: expect.any(String) });
      expect(manifest.purpose).toMatchObject({ en: expect.any(String), ko: expect.any(String) });
      expect(manifest.job).toMatchObject({ en: expect.any(String), ko: expect.any(String) });
      expect(manifest.required_input).toMatchObject({ en: expect.any(String), ko: expect.any(String) });
      expect(manifest.variables).toEqual(expect.any(Object));
      expect(manifest.output_formats.length).toBeGreaterThan(0);
      expect(['stable', 'experimental']).toContain(manifest.stability);
    }
  });

  it('declares every help-page publication variable with a strict definition', async () => {
    const helpPage = (await parseTemplate(join(builtinRoot, 'help-page'))).manifest;

    expect(helpPage.variables).toMatchObject({
      hide_screenshots: {
        type: 'boolean',
        required: false,
        description: expect.any(String),
        default: false,
      },
      support_url: {
        type: 'string',
        required: false,
        description: expect.any(String),
      },
    });
  });

  it('ships stable styles without empty-state or screenshot-placeholder scaffolding', async () => {
    const css = await readFile(join(builtinRoot, 'help-page', 'assets', 'style.css'), 'utf8');

    expect(css).toContain('.help-step-actor');
    expect(css).not.toMatch(/\.help-empty|\.help-screenshot-frame|\.help-screenshot-label|\.help-footer-sources/);
  });
});

describe('publication variable coercion', () => {
  const coerce = (manifestModule as unknown as {
    coerceTemplateVariables?: (
      manifest: TemplateManifest,
      raw: Record<string, string>,
    ) => Record<string, string | boolean | number>;
  }).coerceTemplateVariables;

  function manifest(): TemplateManifest {
    return manifestModule.parseTemplateManifest({
      name: 'publication-contract',
      version: '1.0.0',
      stability: 'experimental',
      audience: { en: 'Readers' },
      purpose: { en: 'Test coercion.' },
      job: { en: 'Publish a test.' },
      required_input: { en: 'Test values' },
      variables: {
        title: { type: 'string', required: true, description: 'Publication title.' },
        public: { type: 'boolean', required: false, description: 'Public flag.', default: false },
        count: { type: 'number', required: false, description: 'Item count.', default: 2 },
        ratio: { type: 'number', required: false, description: 'Optional ratio.' },
      },
      output_formats: ['markdown'],
      scope: 'workspace',
      output_path: 'publication.md',
      supported_locales: ['en'],
      default_locale: 'en',
    });
  }

  it('coerces strict Publication strings and applies declared defaults', () => {
    expect(typeof coerce).toBe('function');
    if (!coerce) return;

    expect(coerce(manifest(), { title: 'Release notes', public: 'true', count: '7.5' })).toEqual({
      title: 'Release notes',
      public: true,
      count: 7.5,
    });
    expect(coerce(manifest(), { title: 'Release notes' })).toEqual({
      title: 'Release notes',
      public: false,
      count: 2,
    });
  });

  it.each([
    [{ title: 'x', unknown: 'value' }, /unknown variable/i],
    [{}, /required variable 'title'/i],
    [{ title: '', public: 'TRUE' }, /boolean/i],
    [{ title: 'x', count: 'Infinity' }, /finite number/i],
  ])('rejects invalid Publication variables: %j', (raw, expected) => {
    expect(typeof coerce).toBe('function');
    if (!coerce) return;
    expect(() => coerce(manifest(), raw)).toThrow(expected);
  });

  it('rejects a missing required variable even when its declaration has a default', () => {
    expect(typeof coerce).toBe('function');
    if (!coerce) return;
    const base = manifest();
    const withRequiredDefault = manifestModule.parseTemplateManifest({
      ...base,
      variables: {
        ...base.variables,
        approval: {
          type: 'boolean',
          required: true,
          description: 'Explicit approval.',
          default: false,
        },
      },
    });

    expect(() => coerce(withRequiredDefault, { title: 'Release notes' })).toThrow(
      /required variable 'approval'/i,
    );
  });

  it('treats empty optional numbers as absent and applies only a declared default', () => {
    expect(typeof coerce).toBe('function');
    if (!coerce) return;

    expect(coerce(manifest(), { title: 'Release notes', count: '', ratio: '' })).toEqual({
      title: 'Release notes',
      public: false,
      count: 2,
    });
  });
});

describe('template discovery stability gate', () => {
  const list = listTemplates as (
    opts: ResolveOptions & { includeExperimental?: boolean },
  ) => Promise<ListEntry[]>;
  const opts = {
    workspaceRoot: join(here, 'fixtures', 'no-workspace-templates'),
    userHome: join(here, 'fixtures', 'no-user-templates'),
    builtinRoot,
    preferredSource: 'builtin' as const,
  };

  it('lists only stable templates by default with truthful publication fields', async () => {
    const entries = await list(opts);

    expect(entries.map((entry) => entry.name)).toEqual(stableBuiltins);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        stability: 'stable',
        audience: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        purpose: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        job: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        requiredInput: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        variables: expect.any(Object),
      });
      expect(entry.outputFormats.length).toBeGreaterThan(0);
    }
  });

  it('retains experimental discoverability only behind explicit opt-in', async () => {
    const entries = await list({ ...opts, includeExperimental: true });

    expect(entries).toHaveLength(16);
    expect(entries.filter((entry) => entry.stability === 'experimental')).toHaveLength(9);
    expect(entries.map((entry) => entry.name)).toContain('help-index');
    expect(entries.map((entry) => entry.name)).toContain('release-digest');
  });
});

describe('stable rendering boundary', () => {
  const renderWorkspace = join(here, 'fixtures', 'render-ws');

  async function tempDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'livedoc-stable-'));
  }

  it('renders only reviewed active Doks by default and rejects an explicit draft', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const draftPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const draft = JSON.parse(await readFile(draftPath, 'utf8')) as Record<string, unknown>;
      draft['status'] = 'draft';
      await writeFile(draftPath, JSON.stringify(draft));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        noHtml: true,
      });
      expect(result.plan.inputs.dok_ids).toEqual(['BILL']);

      await expect(renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'draft-out'),
        dokIds: ['AUTH'],
        noHtml: true,
      })).rejects.toMatchObject({ code: 'UNREVIEWED_DOK', dokId: 'AUTH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes draft Doks from every stable workspace template context', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const draftPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const draft = JSON.parse(await readFile(draftPath, 'utf8')) as Record<string, unknown>;
      draft['status'] = 'draft';
      await writeFile(draftPath, JSON.stringify(draft));
      await writeBuiltin(
        root,
        'stable-workspace-context',
        '{{#each doks}}{{name}}|{{/each}}::{{#each hub.doks}}{{name}}|{{/each}}',
      );

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'stable-workspace-context',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir: join(root, 'out'),
      });

      expect(result.plan.inputs.dok_ids).toEqual(['BILL']);
      expect(await readFile(join(root, 'out', 'publication.md'), 'utf8')).toBe(
        'Charge card|::Charge card|',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(promotedStableBuiltins)(
    'enforces the stable active-only, explicit-draft, and lint boundary for %s',
    async (templateRef) => {
      const root = await tempDirectory();
      try {
        const workspaceRoot = join(root, 'workspace');
        await cp(renderWorkspace, workspaceRoot, { recursive: true });
        const draftPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
        const draft = JSON.parse(await readFile(draftPath, 'utf8')) as Record<string, unknown>;
        draft['status'] = 'draft';
        await writeFile(draftPath, JSON.stringify(draft));

        const result = await renderLivedoc({
          workspaceRoot,
          templateRef,
          source: 'builtin',
          builtinRoot,
          locale: 'en',
          outDir: join(root, 'out'),
          format: 'markdown',
        });

        expect(result.plan.inputs.dok_ids).toEqual(['BILL']);
        expect(result.outputs.length).toBeGreaterThan(0);

        await expect(renderLivedoc({
          workspaceRoot,
          templateRef,
          source: 'builtin',
          builtinRoot,
          locale: 'en',
          outDir: join(root, 'draft-out'),
          dokIds: ['AUTH'],
          format: 'markdown',
        })).rejects.toMatchObject({ code: 'UNREVIEWED_DOK', dokId: 'AUTH' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('skips lint-failing Doks and renders the rest of a stable workspace template', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const unsafePath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'BILL.json');
      const unsafe = JSON.parse(await readFile(unsafePath, 'utf8')) as Record<string, unknown>;
      unsafe['description'] = 'Read packages/billing/src/charge.ts before continuing.';
      await writeFile(unsafePath, JSON.stringify(unsafe));
      await writeBuiltin(
        root,
        'stable-workspace-guide',
        '{{#each doks}}{{name}} — {{description}}\n{{/each}}',
      );

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'stable-workspace-guide',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir: join(root, 'out'),
      });

      expect(result.plan.inputs.dok_ids).toEqual(['AUTH']);
      const markdown = await readFile(join(root, 'out', 'publication.md'), 'utf8');
      expect(markdown).toContain('Email login');
      expect(markdown).not.toContain('packages/');
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: 'SKIPPED_STABLE_DOK',
        dok_id: 'BILL',
        message: expect.stringContaining('SOURCE_PATH'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders release-digest without a Dok containing the four customer-copy identifiers', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const unsafePath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const unsafe = JSON.parse(await readFile(unsafePath, 'utf8')) as Record<string, unknown>;
      unsafe['description'] = 'chatId programId projectId isInternalTest';
      await writeFile(unsafePath, JSON.stringify(unsafe));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'release-digest',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        format: 'markdown',
      });

      expect(result.plan.inputs.dok_ids).toEqual(['BILL']);
      const markdown = await readFile(join(root, 'out', 'release-digest.md'), 'utf8');
      expect(markdown).toContain('Charge card');
      expect(markdown).not.toMatch(/chatId|programId|projectId|isInternalTest/);
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: 'SKIPPED_STABLE_DOK',
        dok_id: 'AUTH',
        message: expect.stringContaining('INTERNAL_IDENTIFIER (4)'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function writeBuiltin(
    root: string,
    name: string,
    body: string,
    options: {
      stability?: 'stable' | 'experimental';
      variables?: Record<string, unknown>;
      scope?: 'workspace' | 'per_dok';
      renderer?: 'handlebars' | 'pptx' | 'xlsx';
      outputFormats?: string[];
      outputPath?: string;
    } = {},
  ): Promise<void> {
    const directory = join(root, 'templates', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'doklo-template.json'), JSON.stringify({
      name,
      version: '1.0.0',
      stability: options.stability ?? 'stable',
      audience: { en: 'Customers' },
      purpose: { en: 'Explain a product task.' },
      job: { en: 'Complete the task.' },
      required_input: { en: 'Reviewed product context' },
      variables: options.variables ?? {},
      output_formats: options.outputFormats ?? ['markdown'],
      renderer: options.renderer ?? 'handlebars',
      scope: options.scope ?? 'workspace',
      output_path: options.outputPath ?? 'publication.md',
      entry: 'template.md.tpl',
      supported_locales: ['en'],
      default_locale: 'en',
    }));
    await writeFile(join(directory, 'template.md.tpl'), body);
  }

  async function stageStableBuiltin(root: string, name: string): Promise<void> {
    const directory = join(root, 'templates', name);
    await cp(join(builtinRoot, name), directory, { recursive: true });
    const manifestPath = join(directory, 'doklo-template.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['stability'] = 'stable';
    await writeFile(manifestPath, JSON.stringify(manifest));
  }

  async function writeScreenshotWorkspace(
    root: string,
    actors: Array<'external' | 'system'>,
  ): Promise<string> {
    const workspace = join(root, 'workspace');
    await cp(renderWorkspace, workspace, { recursive: true });
    const dokPath = join(workspace, '.doklo', 'hub', 'doks', 'AUTH.json');
    const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
    dok['user_actions'] = {
      steps: actors.map((kind, index) => ({
        order: index + 1,
        actor: kind === 'system' ? { kind: 'system' } : { kind: 'external', label: 'Customer' },
        intent: `Complete customer step ${index + 1}`,
        outcome: `Customer result ${index + 1} is visible`,
        variants: [],
      })),
    };
    await writeFile(dokPath, JSON.stringify(dok));
    const screenshots = join(workspace, '.doklo', 'screenshots', 'AUTH');
    await mkdir(screenshots, { recursive: true });
    for (const index of actors.keys()) {
      await writeFile(join(screenshots, `step-${index + 1}.png`), 'screenshot');
    }
    return workspace;
  }

  it('runs stable lint after planning and before the first write', async () => {
    const root = await tempDirectory();
    try {
      const outDir = join(root, 'out');
      await mkdir(outDir);
      await writeBuiltin(root, 'unsafe-publication', '<p>Generated from packages/core/src/x.ts</p>');

      await expect(renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'unsafe-publication',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir,
      })).rejects.toMatchObject({
        code: 'STABLE_LINT_FAILED',
        violations: expect.arrayContaining([
          expect.objectContaining({ code: 'SOURCE_PATH' }),
        ]),
      });
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders public photo formats through the actual stable pipeline without workspace allowlisting', async () => {
    const root = await tempDirectory();
    try {
      const sentence = 'JPEG, PNG, WebP, HEIC, HEIF 형식이며 파일당 10MB까지 첨부할 수 있습니다.';
      await writeBuiltin(root, 'public-photo-formats', sentence);

      await renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'public-photo-formats',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'ko',
        outDir: join(root, 'out'),
        format: 'markdown',
      });

      expect(await readFile(join(root, 'out', 'publication.md'), 'utf8')).toBe(sentence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['recordId', 'WebPEncoder'])(
    'still rejects the internal identifier %s through the actual stable pipeline',
    async (identifier) => {
      const root = await tempDirectory();
      try {
        const outDir = join(root, 'out');
        await writeBuiltin(root, 'internal-photo-identifier', `${identifier}를 확인합니다.`);

        await expect(renderLivedoc({
          workspaceRoot: renderWorkspace,
          templateRef: 'internal-photo-identifier',
          source: 'builtin',
          builtinRoot: join(root, 'templates'),
          locale: 'ko',
          outDir,
          format: 'markdown',
        })).rejects.toMatchObject({
          code: 'STABLE_LINT_FAILED',
          violations: expect.arrayContaining([
            expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
          ]),
        });
        expect(await stat(outDir).then(() => true).catch(() => false)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('skips a lint-failing Dok and renders the remaining per-Dok outputs', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const unsafePath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'BILL.json');
      const unsafe = JSON.parse(await readFile(unsafePath, 'utf8')) as Record<string, unknown>;
      unsafe['description'] = 'Read packages/billing/src/charge.ts before continuing.';
      await writeFile(unsafePath, JSON.stringify(unsafe));
      await writeBuiltin(root, 'per-dok-guide', '{{dok.name}} — {{dok.description}}', {
        scope: 'per_dok',
        outputPath: '{{dok.dok_id}}.md',
      });

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'per-dok-guide',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir: join(root, 'out'),
      });

      expect(result.outputs.map((output) => output.dokId)).toEqual(['AUTH']);
      expect(result.plan.inputs.dok_ids).toEqual(['AUTH']);
      expect(await readdir(join(root, 'out'))).toEqual(['AUTH.md', 'livedoc-manifest.json']);
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: 'SKIPPED_STABLE_DOK',
        dok_id: 'BILL',
        message: expect.stringContaining('SOURCE_PATH'),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects structural raw HTML in stable Markdown before the first write', async () => {
    const root = await tempDirectory();
    try {
      const outDir = join(root, 'out');
      await mkdir(outDir);
      await writeBuiltin(root, 'structural-markdown', '<section>Customer guidance</section>');

      await expect(renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'structural-markdown',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir,
      })).rejects.toMatchObject({
        code: 'STABLE_LINT_FAILED',
        violations: expect.arrayContaining([
          expect.objectContaining({ code: 'STRUCTURAL_RAW_HTML' }),
        ]),
      });
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows structural HTML only for a stable HTML recipe and still sanitizes it', async () => {
    const root = await tempDirectory();
    try {
      const templateDir = join(root, 'templates', 'stable-html');
      await mkdir(templateDir, { recursive: true });
      await writeFile(join(templateDir, 'doklo-template.json'), JSON.stringify({
        name: 'stable-html',
        version: '1.0.0',
        stability: 'stable',
        audience: { en: 'Customers' },
        purpose: { en: 'Explain a product task.' },
        job: { en: 'Complete the task.' },
        required_input: { en: 'Reviewed product context' },
        variables: {},
        default_format: 'html',
        outputs: {
          html: {
            entry: 'template.html.tpl',
            output_path: 'publication.html',
            source: 'html',
          },
        },
        scope: 'workspace',
        supported_locales: ['en'],
        default_locale: 'en',
      }));
      await writeFile(
        join(templateDir, 'template.html.tpl'),
        '<section class="customer-help">Customer guidance<script>alert("unsafe")</script></section>',
      );

      await renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'stable-html',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir: join(root, 'out'),
        format: 'html',
      });
      const html = await readFile(join(root, 'out', 'publication.html'), 'utf8');

      expect(html).toContain('<section class="customer-help">Customer guidance</section>');
      expect(html).not.toContain('<script>alert("unsafe")</script>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supplies selected Dok IDs to stable lint before writing', async () => {
    const root = await tempDirectory();
    try {
      const outDir = join(root, 'out');
      await mkdir(outDir);
      await writeBuiltin(root, 'known-id-publication', '<p>{{dok.dok_id}}</p>', {
        scope: 'per_dok',
      });

      await expect(renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'known-id-publication',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir,
        dokIds: ['AUTH'],
      })).rejects.toMatchObject({
        code: 'STABLE_LINT_FAILED',
        violations: expect.arrayContaining([
          expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
        ]),
      });
      expect(await readdir(outDir)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { format: 'pptx', template: 'korean-public-ppt' },
    { format: 'xlsx', template: 'rtm-trace' },
    { format: 'hwpx', template: 'stable-hwpx' },
  ] as const)('forbids stable $format before any output-directory mutation', async ({ format, template }) => {
    const root = await tempDirectory();
    try {
      if (format === 'hwpx') {
        await writeBuiltin(root, template, '# Customer guidance', {
          outputFormats: ['hwpx'],
        });
      } else {
        await stageStableBuiltin(root, template);
      }
      const outDir = join(root, 'out');

      await expect(renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: template,
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: format === 'pptx' ? 'ko' : 'en',
        outDir,
        ...(format === 'pptx' ? { dokIds: ['AUTH'] } : {}),
      })).rejects.toMatchObject({ code: 'OUTPUT_FORMAT_REJECTED' });
      expect(await stat(outDir).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses coerced values in the template context instead of truthy raw strings', async () => {
    const root = await tempDirectory();
    try {
      const outDir = join(root, 'out');
      await mkdir(outDir);
      await writeBuiltin(
        root,
        'typed-publication',
        '{{#if variables.show}}shown{{else}}hidden{{/if}} {{variables.count}}',
        {
          stability: 'experimental',
          variables: {
            show: { type: 'boolean', required: true, description: 'Visibility flag.' },
            count: { type: 'number', required: true, description: 'Count.' },
          },
        },
      );

      await renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'typed-publication',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir,
        variables: { show: 'false', count: '3' },
      });

      expect(await readFile(join(outDir, 'publication.md'), 'utf8')).toBe('hidden 3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when hide_screenshots removes otherwise available user screenshots', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = await writeScreenshotWorkspace(root, ['external']);
      await writeBuiltin(root, 'help-page', 'Customer guidance', {
        scope: 'per_dok',
        variables: {
          hide_screenshots: {
            type: 'boolean',
            required: false,
            description: 'Hide screenshots.',
            default: false,
          },
        },
      });

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        variables: { hide_screenshots: 'true' },
      });

      expect(result.manifest.warnings).toContainEqual(
        expect.objectContaining({ code: 'OMITTED_SCREENSHOTS', dok_id: 'AUTH' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normalizes only developer clauses and preserves sign-in success, failure, and duplicate prevention', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      await writeFile(dokPath, JSON.stringify({
        dok_id: 'AUTH',
        name: 'User Sign In with Credentials',
        status: 'active',
        tags: ['authentication'],
        surfaces: [],
        description: 'Allows a registered user to sign in using email and password credentials via a server-side authenticated form. On success the user is redirected to a protected area; on failure the user remains on the login page to retry.',
        user_actions: {
          steps: [
            {
              order: 1,
              actor: { kind: 'external', label: 'Customer' },
              intent: 'View the sign-in page and access the login form',
              outcome: 'Login form with email and password fields is displayed',
              variants: [],
            },
            {
              order: 2,
              actor: { kind: 'external', label: 'Customer' },
              intent: 'Enter email and password credentials',
              outcome: "Email and password fields are populated with the user's input",
              variants: [],
              preconditions: ['User has a registered account with email and password'],
            },
            {
              order: 3,
              actor: { kind: 'external', label: 'Customer' },
              intent: 'Submit the login form to authenticate',
              outcome: 'Form data is sent to the server-side sign-in action and submit button enters a pending/loading state',
              variants: [],
            },
            {
              order: 4,
              actor: { kind: 'system' },
              intent: 'Validate provided credentials against stored user data',
              outcome: 'Matching user record is retrieved and password hash is compared',
              variants: [],
            },
            {
              order: 5,
              actor: { kind: 'system' },
              intent: 'Grant access when credentials are valid',
              outcome: 'Authenticated session is established and user is redirected to the protected route',
              variants: [],
              preconditions: [
                'Email exists in the user database',
                'Password matches the stored hashed password',
              ],
            },
            {
              order: 6,
              actor: { kind: 'system' },
              intent: 'Reject access when credentials are invalid',
              outcome: 'Authentication fails and the user remains on the login page without a session',
              variants: [],
              preconditions: ['Email does not exist or password does not match'],
            },
            {
              order: 7,
              actor: { kind: 'external', label: 'Customer' },
              intent: 'Navigate to registration if no account exists',
              outcome: 'User is redirected to the sign-up page',
              variants: [],
            },
          ],
        },
        business_rules: {
          rules: [
            {
              id: 'BR-AUTH-01',
              description: 'Both email and password fields are required and must be filled before form submission is allowed.',
              type: 'validation',
            },
            {
              id: 'BR-AUTH-02',
              description: 'Authentication succeeds only if a user record exists for the given email and the provided password matches the stored bcrypt-hashed password.',
              type: 'policy',
            },
            {
              id: 'BR-AUTH-03',
              description: 'On successful authentication, the user is redirected to the /protected route.',
              type: 'policy',
            },
            {
              id: 'BR-AUTH-04',
              description: 'The submit control must be disabled (pending) while the sign-in request is being processed to prevent duplicate submissions.',
              type: 'restriction',
            },
          ],
        },
        acceptance_criteria: {
          criteria: [
            {
              id: 'AC-AUTH-01',
              statement: 'Given a user is on the login page, when they submit the form without entering an email or password, then the form must not be submitted due to required field validation.',
              related_rules: ['BR-AUTH-01'],
            },
            {
              id: 'AC-AUTH-02',
              statement: 'Given a user enters a valid email and matching password, when they submit the login form, then they are authenticated and redirected to /protected.',
              related_rules: ['BR-AUTH-02', 'BR-AUTH-03'],
            },
            {
              id: 'AC-AUTH-03',
              statement: 'Given a user enters an email that does not exist or a password that does not match, when they submit the login form, then authentication fails and no session is created.',
              related_rules: ['BR-AUTH-02'],
            },
            {
              id: 'AC-AUTH-04',
              statement: 'Given a user has submitted the login form, when the request is pending, then the submit button shows a loading indicator and is disabled from re-submission.',
              related_rules: ['BR-AUTH-04'],
            },
            {
              id: 'AC-AUTH-05',
              statement: 'Given a user without an account is on the login page, when they click the sign-up link, then they are navigated to the /register page.',
              related_rules: [],
            },
          ],
        },
        _meta: { version: 1, history: [] },
      }));
      const sourceBeforeRender = await readFile(dokPath, 'utf8');

      const outDir = join(root, 'out');
      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir,
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(outDir, 'AUTH.md'), 'utf8');

      expect(output.match(/^### \d+\. /gm)).toHaveLength(4);
      expect(output.match(/^### Automatic step$/gm)).toHaveLength(2);
      expect(output.match(/^- \*\*(?:Access permission|Input requirement|Operating policy|Usage limit):\*\*/gm)).toHaveLength(4);
      expect(output.match(/^- \[ \] /gm)).toHaveLength(5);
      const flow = [
        '### 1. Customer — View the sign-in page and access the login form',
        '### 2. Customer — Enter email and password credentials',
        '### 3. Customer — Submit the login form to authenticate',
        '### Automatic step',
        'The user is redirected to the protected area',
        '### Automatic step',
        'Authentication fails and the user remains on the login page',
        '### 4. Customer — Navigate to registration if no account exists',
      ];
      let flowCursor = -1;
      for (const fragment of flow) {
        flowCursor = output.indexOf(fragment, flowCursor + 1);
        expect(flowCursor).toBeGreaterThanOrEqual(0);
      }
      expect(output).toContain('redirected to the protected area');
      expect(output).not.toContain('redirected to protected area');
      expect(output).toContain('navigated to the sign-up page');
      expect(output).toMatch(/authentication fails.+remains signed out|authentication fails.+remains on the login page/is);
      expect(output).toContain('prevent duplicate submissions');
      expect(output).toContain('disabled from re-submission');
      expect(output).not.toMatch(/server-side|bcrypt|database|pending\/loading|request is pending|\/protected|\/register|protected route/i);
      expect(result.manifest.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'NORMALIZED_DEVELOPER_COPY', field: 'description' }),
        expect.objectContaining({ code: 'NORMALIZED_DEVELOPER_COPY', field: 'actions.steps[2].outcome' }),
        expect.objectContaining({ code: 'NORMALIZED_DEVELOPER_COPY', field: 'rules[1].description' }),
        expect.objectContaining({ code: 'NORMALIZED_DEVELOPER_COPY', field: 'checks[3].statement' }),
      ]));
      expect(JSON.stringify(result.manifest.warnings)).not.toMatch(
        /server-side|bcrypt|database|pending\/loading|request is pending|\/protected|\/register|protected route/i,
      );
      expect(await readFile(dokPath, 'utf8')).toBe(sourceBeforeRender);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps ordinary session and route language that is not an implementation phrase', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = 'The delivery route stays visible after the customer session expires.';
      await writeFile(dokPath, JSON.stringify(dok));

      const outDir = join(root, 'out');
      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir,
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(outDir, 'AUTH.md'), 'utf8');

      expect(output).toContain('The delivery route stays visible after the customer session expires.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits an unknown raw app-route clause and records a field-only warning', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = 'Open /admin/settings; Customers can retry from the account page.';
      await writeFile(dokPath, JSON.stringify(dok));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      expect(output).toContain('Customers can retry from the account page.');
      expect(output).not.toContain('/admin/settings');
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: 'NORMALIZED_DEVELOPER_COPY',
        field: 'description',
      }));
      expect(JSON.stringify(result.manifest.warnings)).not.toContain('/admin/settings');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    'Open "/admin/settings"; Customers can retry from the account page.',
    'Open “/admin/settings”; Customers can retry from the account page.',
    'Open [/admin/settings]; Customers can retry from the account page.',
    'Open `/admin/settings`; Customers can retry from the account page.',
    'Route=/admin/settings; Customers can retry from the account page.',
  ])('removes a delimited unknown app route without removing the safe clause: %s', async (description) => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = description;
      await writeFile(dokPath, JSON.stringify(dok));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      expect(output).toContain('Customers can retry from the account page.');
      expect(output).not.toContain('/admin/settings');
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: 'NORMALIZED_DEVELOPER_COPY',
        field: 'description',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the useful acceptance criterion when removing an application route', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const workspacePath = join(workspaceRoot, 'workspace.json');
      const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
      await writeFile(workspacePath, JSON.stringify({ ...workspace, korean_customer_tone: 'plain' }));
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['acceptance_criteria'] = {
        criteria: [{
          id: 'AC-AUTH-01',
          statement: '관리자가 /admin/settings에 접근하면 계정 설정이 화면에 표시되어야 한다.',
          related_rules: [],
        }],
      };
      await writeFile(dokPath, JSON.stringify(dok));

      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'ko',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      expect(output).toContain('- [ ] 관리자가 해당 페이지에 접근하면 계정 설정이 화면에 표시되어야 한다.');
      expect(output).not.toContain('/admin/settings');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not disguise an absolute source path as an application route', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = 'Generated from /Users/dev/project/auth.ts.';
      await writeFile(dokPath, JSON.stringify(dok));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      expect(output).not.toMatch(/Users\/dev|the page\.ts|^Ts\.$/mu);
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: 'OMITTED_DEVELOPER_COPY',
        field: 'description',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['Open /protected.', 'Open the protected area.'],
    ['Stay inside /protected.', 'Stay inside the protected area.'],
    ['Go to the /protected route.', 'Go to the protected area.'],
    ['Open /register.', 'Open the sign-up page.'],
    ['Use the /register page.', 'Use the sign-up page.'],
    ['Follow the link to open /protected.', 'Follow the link to open the protected area.'],
    ['Open a /protected route.', 'Open the protected area.'],
    ['Open an /protected route.', 'Open the protected area.'],
    ['Open a /register page.', 'Open the sign-up page.'],
  ])('normalizes a known route with one definite article: %s', async (description, expected) => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = description;
      await writeFile(dokPath, JSON.stringify(dok));

      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      expect(output).toContain(expected);
      expect(output).not.toMatch(/the the|\/protected|\/register|protected route/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows a complete URL path in customer copy', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = 'Read https://example.com/admin/settings for customer help.';
      await writeFile(dokPath, JSON.stringify(dok));

      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      expect(await readFile(join(root, 'out', 'AUTH.md'), 'utf8')).toContain(
        'https://example.com/admin/settings',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    'Read https://example.com/protected for customer help.',
    'Read https://example.com/register for customer help.',
  ])('does not rewrite a known-route token inside a complete URL: %s', async (description) => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = description;
      await writeFile(dokPath, JSON.stringify(dok));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      expect(await readFile(join(root, 'out', 'AUTH.md'), 'utf8')).toContain(description);
      expect(result.manifest.warnings).not.toContainEqual(expect.objectContaining({
        field: 'description',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      description: '사용자는 로그인하고 React 컴포넌트가 요청을 처리합니다.',
      expected: undefined,
      code: 'OMITTED_DEVELOPER_COPY',
    },
    {
      description: '사용자는 로그인하고\nReact 컴포넌트가 요청을 처리합니다.',
      expected: undefined,
      code: 'OMITTED_DEVELOPER_COPY',
    },
    {
      description: '가입 절차를 시작하고\nAPI를 호출합니다.',
      expected: undefined,
      code: 'OMITTED_DEVELOPER_COPY',
    },
    {
      description: 'React 컴포넌트가 요청을 처리하고 사용자는 로그인합니다.',
      expected: '사용자는 로그인합니다.',
      code: 'NORMALIZED_DEVELOPER_COPY',
    },
  ])('keeps only complete Korean clauses for mixed implementation copy', async (fixture) => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['description'] = fixture.description;
      await writeFile(dokPath, JSON.stringify(dok));

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'ko',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      if (fixture.expected) expect(output).toContain(fixture.expected);
      else expect(output).not.toContain(fixture.description);
      expect(output).not.toContain('사용자는 로그인.');
      expect(output).not.toContain('사용자는 로그인하고');
      expect(output).not.toContain('가입 절차를 시작하고');
      expect(output).not.toMatch(/React\s*컴포넌트|요청을 처리/iu);
      expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
        code: fixture.code,
        field: 'description',
      }));
      expect(JSON.stringify(result.manifest.warnings)).not.toMatch(/React|요청을 처리/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      locale: 'en',
      name: 'API Sign-in Help',
      actor: 'Customer useAuth hook',
      description: 'The API checks credentials; the React component handles the request, and customers see the account page.',
      safeTitle: 'Sign-in Help',
      safeActor: 'Customer',
      safeDescription: 'Customers see the account page',
      removedDetail: /checks credentials|handles the request/iu,
      forbidden: /\bAPI\b|React\s+component|useAuth\s+hook|server-side/iu,
    },
    {
      locale: 'ko',
      name: 'API 로그인 도움말',
      actor: 'useAuth 훅 고객',
      description: '서버사이드 API가 자격 증명을 확인하고 React 컴포넌트가 요청을 처리하고 사용자는 계정 화면을 봅니다.',
      safeTitle: '로그인 도움말',
      safeActor: '고객',
      safeDescription: '사용자는 계정 화면을 봅니다',
      removedDetail: /자격 증명을 확인|요청을 처리/iu,
      forbidden: /\bAPI\b|React\s*컴포넌트|useAuth\s*훅|서버\s*사이드/iu,
    },
  ])('applies the public-copy boundary to $locale title, actor, and free text', async (fixture) => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      await writeFile(dokPath, JSON.stringify({
        dok_id: 'AUTH',
        name: fixture.name,
        status: 'active',
        tags: [],
        surfaces: [],
        description: fixture.description,
        user_actions: {
          steps: [{
            order: 1,
            actor: { kind: 'external', label: fixture.actor },
            intent: fixture.locale === 'ko' ? '로그인 양식을 제출합니다.' : 'Submit the sign-in form.',
            outcome: fixture.locale === 'ko' ? '계정 화면이 열립니다.' : 'The account page opens.',
            variants: [],
          }],
        },
        _meta: { version: 1, history: [] },
      }));

      const outDir = join(root, 'out');
      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: fixture.locale,
        outDir,
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const output = await readFile(join(outDir, 'AUTH.md'), 'utf8');

      expect(output).toContain(fixture.safeTitle);
      expect(output).toContain(fixture.safeActor);
      expect(output).toContain(fixture.safeDescription);
      expect(output).not.toMatch(fixture.forbidden);
      expect(output).not.toMatch(fixture.removedDetail);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails a stable render before writing when the title has no safe customer wording', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['name'] = 'useAuth hook';
      await writeFile(dokPath, JSON.stringify(dok));
      const outDir = join(root, 'out');

      await expect(renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir,
        dokIds: ['AUTH'],
        noHtml: true,
      })).rejects.toMatchObject({ code: 'STABLE_COPY_UNSAFE' });
      expect(await stat(outDir).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when system-step screenshots are excluded from the actual rendered set', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = await writeScreenshotWorkspace(root, ['external', 'system']);
      await writeBuiltin(root, 'help-page', 'Customer guidance', { scope: 'per_dok' });

      const result = await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot: join(root, 'templates'),
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
      });

      expect(result.manifest.warnings).toContainEqual(
        expect.objectContaining({ code: 'OMITTED_SCREENSHOTS', dok_id: 'AUTH' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps 10+ step details and screenshot captions in their CommonMark step sections', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = join(root, 'workspace');
      await cp(renderWorkspace, workspaceRoot, { recursive: true });
      const dokPath = join(workspaceRoot, '.doklo', 'hub', 'doks', 'AUTH.json');
      const dok = JSON.parse(await readFile(dokPath, 'utf8')) as Record<string, unknown>;
      dok['user_actions'] = {
        steps: Array.from({ length: 11 }, (_, index) => ({
          order: index + 1,
          actor: { kind: 'external', label: 'Customer' },
          intent: `Complete customer step ${index + 1}`,
          outcome: `Customer result ${index + 1} is visible`,
          preconditions: [`Prerequisite ${index + 1} is met`],
          variants: [],
        })),
      };
      await writeFile(dokPath, JSON.stringify(dok));
      const screenshots = join(
        workspaceRoot,
        '.doklo',
        'screenshots',
        'AUTH',
        'desktop',
      );
      await mkdir(screenshots, { recursive: true });
      for (let index = 1; index <= 11; index += 1) {
        await writeFile(join(screenshots, `step-${index}.png`), 'screenshot');
      }

      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const markdown = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');
      const stepHeadings = [...markdown.matchAll(
        /^### (\d+)\. Customer — Complete customer step (\d+)$/gm,
      )];
      const expectedStepNumbers = [
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11',
      ];

      expect(stepHeadings.map((match) => match[1])).toEqual(expectedStepNumbers);
      expect(stepHeadings.map((match) => match[2])).toEqual(expectedStepNumbers);
      for (let index = 0; index < stepHeadings.length; index += 1) {
        const number = index + 1;
        const start = stepHeadings[index]!.index;
        const end = stepHeadings[index + 1]?.index ?? markdown.length;
        const section = markdown.slice(start, end);
        const html = marked.parse(section) as string;

        expect(html).toContain(
          `<li><strong>Before you start:</strong> Prerequisite ${number} is met</li>`,
        );
        expect(html).toContain(
          `<li><strong>What you see:</strong> Customer result ${number} is visible</li>`,
        );
        expect(html).toContain(
          `<img src="_assets/screenshots/AUTH/desktop/step-${number}.png" alt="Complete customer step ${number} — Desktop">`,
        );
        expect(html).toContain(
          `<em>Desktop — Complete customer step ${number}</em>`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('localizes screenshot platform labels for Korean help pages', async () => {
    const root = await tempDirectory();
    try {
      const workspaceRoot = await writeScreenshotWorkspace(root, ['external']);
      const desktopDir = join(workspaceRoot, '.doklo', 'screenshots', 'AUTH', 'desktop');
      await mkdir(desktopDir, { recursive: true });
      await writeFile(join(desktopDir, 'step-1.png'), 'screenshot');

      await renderLivedoc({
        workspaceRoot,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'ko',
        outDir: join(root, 'out'),
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const markdown = await readFile(join(root, 'out', 'AUTH.md'), 'utf8');

      expect(markdown).toContain('*데스크톱 — Complete customer step 1*');
      expect(markdown).not.toContain('*desktop —');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('omits unavailable help sections and records one warning for each omission', async () => {
    const root = await tempDirectory();
    try {
      const result = await renderLivedoc({
        workspaceRoot: renderWorkspace,
        templateRef: 'help-page',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: root,
        dokIds: ['AUTH'],
        noHtml: true,
      });
      const markdown = await readFile(join(root, 'AUTH.md'), 'utf8');

      expect(markdown.split(/\r?\n/u).filter((line) => line.trim()).slice(0, 2)).toEqual([
        '# Email login',
        '**Render Test · User guide**',
      ]);
      expect(markdown).not.toMatch(/id="(?:how|tips|done)"|help-toc|help-empty|screenshot coming soon/i);
      expect(markdown).not.toMatch(
        /<(?:header|section|article|aside|nav|div|ol|ul|li|table|h[1-6]|p)\b/i,
      );
      expect(markdown).not.toContain('AUTH');
      expect(markdown).not.toMatch(/Feature ID|Source files|source_anchors/i);
      expect(markdown).not.toMatch(/Generated from reviewed product context|Did this help|Contact support/iu);
      expect(result.manifest.template).toMatchObject({
        stability: 'stable',
        audience: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        purpose: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        job: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        required_input: expect.objectContaining({ en: expect.any(String), ko: expect.any(String) }),
        variables: expect.any(Object),
        output_formats: ['markdown', 'html'],
      });
      expect(result.manifest.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining([
          'OMITTED_ACTIONS',
          'OMITTED_RULES',
          'OMITTED_CHECKS',
          'OMITTED_SCREENSHOTS',
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
