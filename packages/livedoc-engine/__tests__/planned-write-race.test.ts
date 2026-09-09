import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRenderOutputs } from '../src/output-plan.js';
import { getWriter, type WriterContext } from '../src/writers/index.js';
import type { TemplateManifest } from '../src/template-manifest.js';
import { writeManifest, type LivedocManifest } from '../src/manifest.js';

const template = {
  name: 'race-test',
  version: '1.0.0',
  output_formats: ['markdown'],
  scope: 'workspace',
  output_path: 'race.md',
  entry: 'template.md.tpl',
  supported_locales: ['en'],
  default_locale: 'en',
  strings: {},
  requires_hub_layers: ['doks'],
} as TemplateManifest;

const renderedManifest = {
  engine_version: 'test',
  template: { name: 'race-test', version: '1.0.0', source: 'workspace' },
  locale: 'en',
  primary_locale: 'en',
  workspace_root: '/workspace',
  generated_at: '1970-01-01T00:00:00.000Z',
  scope: 'workspace',
  selector_applied: false,
  outputs: [],
  translation: {
    resolved: 0,
    fallback_to_primary: 0,
    fallback_to_first_available: 0,
    unresolved_terms: [],
  },
  strings: { missing_keys: [] },
  warnings: [],
  errors: [],
} as LivedocManifest;

async function withTmp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'livedoc-planned-race-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('planned output write authorization', () => {
  it('does not clobber a text target that appears after an overwrite-enabled plan marked create', async () => {
    await withTmp(async (root) => {
      const plan = await planRenderOutputs({
        outputRoot: root,
        outputDir: '',
        overwrite: true,
        targets: [{ relativePath: 'race.md', format: 'markdown' }],
        screenshots: [],
      });
      const planned = plan.outputs.find((output) => output.format === 'markdown')!;
      expect(planned.action).toBe('create');
      await writeFile(planned.path, 'appeared-after-plan');

      const context = {
        outputRoot: plan.output_root,
        plannedOutput: planned,
        content: '# replacement\n',
        template,
        locale: 'en',
      } as WriterContext;

      await expect(getWriter('markdown')(context)).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
      expect(await readFile(planned.path, 'utf8')).toBe('appeared-after-plan');
    });
  });

  it('does not clobber the manifest when it appears after an overwrite-enabled plan marked create', async () => {
    await withTmp(async (root) => {
      const plan = await planRenderOutputs({
        outputRoot: root,
        outputDir: '',
        overwrite: true,
        targets: [],
        screenshots: [],
      });
      const planned = plan.outputs.find((output) => output.format === 'manifest')!;
      expect(planned.action).toBe('create');
      await writeFile(planned.path, 'appeared-after-plan');

      await expect(writeManifest(plan.output_root, planned, renderedManifest)).rejects.toMatchObject({
        code: 'OUTPUT_EXISTS',
      });
      expect(await readFile(planned.path, 'utf8')).toBe('appeared-after-plan');
    });
  });
});
