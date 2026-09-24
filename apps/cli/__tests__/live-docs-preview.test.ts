import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLiveDocsCommand, registerLiveDocsRenderCommand } from '../src/commands/live-docs-render.js';
import { registerPublicationCommands } from '../src/commands/live-docs-publication.js';
import { createContext } from '../src/lib/context.js';
import { takeCommandResult } from '../src/lib/command-result.js';

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace(status = 'draft'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-cli-preview-'));
  roots.push(root);
  await cp(join(here, '../../../packages/livedoc-engine/__tests__/fixtures/render-ws'), root, { recursive: true });
  const path = join(root, '.doklo/hub/doks/AUTH.json');
  const dok = JSON.parse(await readFile(path, 'utf8'));
  dok.status = status;
  await writeFile(path, JSON.stringify(dok));
  return root;
}
async function run(root: string, args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerLiveDocsRenderCommand(program, createContext('en'));
  registerPublicationCommands(ensureLiveDocsCommand(program));
  await program.parseAsync(['live-docs', ...args, '--root', root, '--json'], { from: 'user' });
  return takeCommandResult(program);
}

describe('draft preview CLI', () => {
  it('renders an explicitly requested draft in a separate default directory with an observable preview result', async () => {
    const root = await workspace();
    const before = await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf8');
    const result = await run(root, ['render', 'help-page', '--dok', 'AUTH', '--format', 'html', '--preview']);
    expect(result).toMatchObject({ status: 'success', data: { manifest: { render_mode: 'draft-preview' } } });
    expect(result?.diagnostics).toContainEqual(expect.objectContaining({ code: 'DRAFT_PREVIEW' }));
    expect(await readFile(join(root, '.doklo/output/preview/AUTH.html'), 'utf8')).toContain('Draft preview');
    expect(await readFile(join(root, '.doklo/hub/doks/AUTH.json'), 'utf8')).toBe(before);
    expect(await readdir(join(root, '.doklo/output'))).toEqual(['preview']);
    await expect(run(root, ['render', 'help-page', '--dok', 'AUTH', '--format', 'html']))
      .rejects.toMatchObject({ result: { diagnostics: [expect.objectContaining({ code: 'UNREVIEWED_DOK' })] } });
  });

  it.each(['publish', 'export', 'render'])('rejects a preview-marked manifest as saved Publication %s evidence even with matching hashes', async (operation) => {
    const root = await workspace('active');
    expect(await run(root, ['publication', 'create', 'review', '--template', 'help-page', '--dok-id', 'AUTH', '--format', 'markdown', '--destination', 'public/help', '--output-dir', 'review']))
      .toMatchObject({ status: 'success' });
    expect(await run(root, ['publication', 'render', 'review'])).toMatchObject({ status: 'success' });
    const directory = join(root, '.doklo/output/review');
    const evidencePath = join(directory, 'publication-evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    const claim = evidence.outputs.find((output: { format: string }) => output.format === 'manifest');
    const manifestPath = join(root, claim.relative_path);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.render_mode = 'draft-preview';
    const bytes = JSON.stringify(manifest);
    await writeFile(manifestPath, bytes);
    claim.bytes = Buffer.byteLength(bytes);
    claim.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(evidencePath, JSON.stringify(evidence));
    if (operation === 'render') {
      expect(await run(root, ['publication', operation, 'review', '--overwrite']))
        .toMatchObject({ status: 'failed', diagnostics: [expect.objectContaining({ code: 'PUBLICATION_EVIDENCE_INVALID' })] });
    } else {
      await expect(run(root, ['publication', operation, 'review']))
        .rejects.toMatchObject({ code: 'PUBLICATION_EVIDENCE_INVALID' });
    }
    expect(await readdir(root)).not.toContain('public');
    expect(await readdir(join(root, '.doklo/output'))).not.toContain('review.zip');
  });
});
