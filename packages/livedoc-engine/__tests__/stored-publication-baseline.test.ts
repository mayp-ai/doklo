import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { publicationDigest, serializePublication, type PublicationV1 } from '../src/publication.js';
import { renderPublication } from '../src/render.js';

it('uses explicit stored baselines, including an empty baseline, without prior filesystem evidence', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'stored-publication-baseline-'));
  try {
    await cp(new URL('./fixtures/render-ws', import.meta.url), temporary, { recursive: true });
    const root = await realpath(temporary);
    const dokPath = join(root, '.doklo/hub/doks/AUTH.json');
    const dok = JSON.parse(await readFile(dokPath, 'utf8'));
    dok._meta.logic_hash = 'current-source';
    await writeFile(dokPath, JSON.stringify(dok));

    const templateRoot = join(root, '.doklo/templates/changes-probe');
    await mkdir(templateRoot, { recursive: true });
    await writeFile(join(templateRoot, 'doklo-template.json'), JSON.stringify({
      name: 'changes-probe', version: '0.1.0', stability: 'experimental',
      output_formats: ['markdown'], scope: 'workspace', output_path: 'probe.md',
      entry: 'template.md.tpl', supported_locales: ['en'], default_locale: 'en',
      strings: {}, requires_hub_layers: ['doks'],
    }));
    await writeFile(join(templateRoot, 'template.md.tpl'), [
      'baseline={{changes.baseline_found}}',
      'added={{#each changes.added}}{{this.dok_id}},{{/each}}',
      'changed={{#each changes.changed}}{{this.dok_id}},{{/each}}',
    ].join('\n'));
    const publication: PublicationV1 = {
      schema_version: 1, name: 'stored-changes', display_name: 'Stored changes',
      template: 'changes-probe', selection: { mode: 'explicit', dok_ids: ['AUTH'] },
      selected_dok_ids: ['AUTH'], format: 'markdown', locale: 'en', vars: {},
      output_dir: 'changes-probe/stored-changes', created_at: '2026-10-08T00:00:00.000Z',
    };
    const definitions = join(root, '.doklo/livedocs/publications');
    await mkdir(definitions, { recursive: true });
    const definitionPath = join(definitions, 'stored-changes.json');
    await writeFile(definitionPath, serializePublication(publication));
    const input = { workspaceRoot: root, publication,
      definition: { path: definitionPath, sha256: publicationDigest(publication) } };
    const previousDokSnapshots = [{ dok_id: 'AUTH', name: 'Email login',
      logic_hash: 'previous-source', status: 'active' as const }];
    const first = await renderPublication({ ...input, previousDokSnapshots });
    expect(first.status, JSON.stringify(first)).toBe('success');
    const output = join(root, '.doklo/output/changes-probe/stored-changes/probe.md');
    expect(await readFile(output, 'utf8')).toContain('changed=AUTH,');

    const second = await renderPublication({ ...input, overwrite: true, previousDokSnapshots: [] });
    expect(second.status, JSON.stringify(second)).toBe('success');
    const text = await readFile(output, 'utf8');
    expect(text).toContain('baseline=true');
    expect(text).toContain('added=AUTH,');
    expect(text).not.toContain('changed=AUTH,');
    if (first.status === 'success' && second.status === 'success') {
      expect(first.data.render_input_sha256).not.toBe(second.data.render_input_sha256);
    }
    expect(previousDokSnapshots[0]!.logic_hash).toBe('previous-source');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
