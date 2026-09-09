import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PublicationExportNotFoundError,
  readPublicationExport,
} from '../lib/publication-download';
import type { PublicationWorkspaceModel } from '../lib/publication-read-model';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    (root) => rm(root, { recursive: true, force: true }),
  ));
});

describe('Publication export download', () => {
  it('reads only the default exported zip for the requested Publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-studio-export-'));
    roots.push(root);
    const path = join(
      root,
      '.doklo',
      'output',
      'workspace-guide',
      'review-guide.zip',
    );
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.from('PK-safe-archive'));

    const result = await readPublicationExport({
      root,
      name: 'review-guide',
      model: model(),
    });

    expect(result.filename).toBe('review-guide.zip');
    expect(result.bytes.toString('utf8')).toBe('PK-safe-archive');
  });

  it('does not invent a path for an unknown Publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-studio-export-'));
    roots.push(root);

    await expect(readPublicationExport({
      root,
      name: 'missing',
      model: model(),
    })).rejects.toBeInstanceOf(PublicationExportNotFoundError);
  });
});

function model(): PublicationWorkspaceModel {
  return {
    locale: 'en',
    workspace_default_locale: 'en',
    templates: [],
    doks: [],
    errors: [],
    publications: [{
      publication: {
        schema_version: 1,
        name: 'review-guide',
        display_name: 'Review Guide',
        template: 'workspace-guide',
        selection: { mode: 'explicit', dok_ids: ['AUTH'] },
        selected_dok_ids: ['AUTH'],
        format: 'html',
        locale: 'en',
        vars: {},
        output_dir: 'workspace-guide/review-guide',
        created_at: '2026-07-17T03:04:05.678Z',
      },
      effective_update_mode: 'manual',
      definition_path: join(
        '/workspace',
        '.doklo',
        'publications',
        'review-guide.json',
      ),
      definition_sha256: 'definition',
      template: {
        name: 'workspace-guide',
        version: '1.0.0',
        source: 'builtin',
        stability: 'stable',
        display_name: 'Workspace Guide',
        description: 'Guide',
        audience: 'Teams',
        purpose: 'Guide',
        job: 'Read',
        required_input: 'Doks',
        scope: 'workspace',
        default_format: 'html',
        output_formats: ['html'],
        supported_locales: ['en', 'ko'],
        default_locale: 'en',
        variables: {},
        selection: {
          scope: 'workspace',
          eligible_dok_ids: ['AUTH'],
          default_kind: 'all_eligible',
          allowed_kinds: ['all_eligible', 'filter', 'explicit'],
          excluded: [],
        },
      },
      status: {
        render_state: 'current',
        publish_state: 'no_destination',
        freshness: 'proven',
        template_update_available: false,
        reasons: [],
        resolved_dok_ids: ['AUTH'],
        input_fingerprint: 'fingerprint',
      },
    }],
  };
}
