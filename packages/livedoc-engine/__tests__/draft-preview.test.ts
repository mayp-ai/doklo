import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHubModel } from '@doklo-beta/core';
import { renderLivedoc, type RenderLivedocInput } from '../src/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<{ input: RenderLivedocInput; dokPath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'doklo-draft-preview-'));
  directories.push(workspaceRoot);
  await cp(join(here, 'fixtures/render-ws'), workspaceRoot, { recursive: true });
  const dokPath = join(workspaceRoot, '.doklo/hub/doks/AUTH.json');
  const dok = JSON.parse(await readFile(dokPath, 'utf8'));
  dok.status = 'draft';
  await writeFile(dokPath, JSON.stringify(dok));
  return { dokPath, input: {
    workspaceRoot, templateRef: 'help-page', source: 'builtin',
    builtinRoot: join(here, '../templates'), locale: 'en',
    outDir: join(workspaceRoot, 'preview'), dokIds: ['AUTH'], allFormats: true,
    preview: true,
  } };
}

describe('explicit draft preview', () => {
  it('marks Markdown, HTML, and manifest while preserving the original Hub and official gate', async () => {
    const { input, dokPath } = await fixture();
    const before = await readFile(dokPath, 'utf8');
    const result = await renderLivedoc(input);
    expect(result.manifest).toMatchObject({ render_mode: 'draft-preview' });
    expect(result.manifest.warnings).toContainEqual(expect.objectContaining({ code: 'DRAFT_PREVIEW' }));
    expect(result.outputs.map((output) => output.format).sort()).toEqual(['html', 'markdown']);
    for (const output of result.outputs) {
      const content = await readFile(output.path, 'utf8');
      expect(content).toContain('Draft preview');
      expect(content).toContain('Not reviewed or approved for publication');
      expect(content).toContain('Email login');
      if (output.format === 'html') expect(content).toContain('data-doklo-preview="draft"');
    }
    expect(JSON.parse(await readFile(result.manifestPath!, 'utf8')).render_mode).toBe('draft-preview');
    expect(await readFile(dokPath, 'utf8')).toBe(before);
    expect((await loadHubModel(input.workspaceRoot)).doks.find((dok) => dok.dok_id === 'AUTH')?.status).toBe('draft');
    await expect(renderLivedoc({ ...input, preview: false, outDir: join(input.workspaceRoot, 'official') }))
      .rejects.toMatchObject({ code: 'UNREVIEWED_DOK', dokId: 'AUTH' });
    expect(await readdir(input.outDir)).not.toContain('publication-evidence.json');
  });

  it.each(['help-page', 'help-index'])('includes draft and active Doks by default for %s', async (templateRef) => {
    const { input } = await fixture();
    const result = await renderLivedoc({ ...input, templateRef, dokIds: undefined, dryRun: true });
    expect(result.plan.inputs.dok_ids).toEqual(['AUTH', 'BILL']);
    expect(result.plan.warnings).toContainEqual(expect.objectContaining({ code: 'DRAFT_PREVIEW' }));
    expect(result.manifest.render_mode).toBe('draft-preview');
    expect(await readdir(input.workspaceRoot)).not.toContain('preview');
  });

  it.each(['planned', 'deprecated', 'archived'])('does not silently expand preview to %s Doks', async (status) => {
    const { input, dokPath } = await fixture();
    const dok = JSON.parse(await readFile(dokPath, 'utf8'));
    dok.status = status;
    await writeFile(dokPath, JSON.stringify(dok));
    await expect(renderLivedoc(input)).rejects.toMatchObject({ code: 'UNREVIEWED_DOK' });
  });

  it('still rejects unsafe internal identifiers before writing preview files', async () => {
    const { input, dokPath } = await fixture();
    const dok = JSON.parse(await readFile(dokPath, 'utf8'));
    dok.name = 'Read sourceAnchors to continue';
    await writeFile(dokPath, JSON.stringify(dok));
    await expect(renderLivedoc({ ...input, templateRef: 'help-index' }))
      .rejects.toMatchObject({ code: 'STABLE_LINT_FAILED' });
    expect(await readdir(input.workspaceRoot)).not.toContain('preview');
  });

  it('rejects experimental binary preview instead of emitting unmarked output', async () => {
    const { input } = await fixture();
    await expect(renderLivedoc({ ...input, templateRef: 'rtm-trace', allFormats: undefined }))
      .rejects.toMatchObject({ code: 'OUTPUT_FORMAT_REJECTED' });
    expect(await readdir(input.workspaceRoot)).not.toContain('preview');
  });
});
