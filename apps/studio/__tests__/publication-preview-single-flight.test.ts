import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PublicationTemplateReadModel,
  PublicationWorkspaceModel,
} from '../lib/publication-read-model';

const harness = vi.hoisted(() => ({
  renderLivedoc: vi.fn(),
  gate: undefined as ReturnType<typeof deferred> | undefined,
}));

vi.mock('@doklo-beta/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/core')>();
  return {
    ...actual,
    loadHubModel: vi.fn(async () => ({
      workspace: { default_locale: 'en' },
      doks: [{
        dok_id: 'AUTH',
        name: 'Authentication',
        status: 'active',
        tags: [],
        surfaces: ['web'],
      }],
      codeMappings: [],
      ia: [],
      lexicon: { terms: [] },
      roles: [],
    })),
  };
});

vi.mock('@doklo-beta/livedoc-engine', () => ({
  classifyDokChanges: vi.fn(() => ({
    added: [],
    changed: [],
    removed: [],
  })),
  loadWorkspaceAudienceDictionary: vi.fn(async () => ({})),
  renderLivedoc: harness.renderLivedoc,
}));

describe('renderPublicationCandidateSingleFlight', () => {
  beforeEach(() => {
    harness.gate = deferred<void>();
    harness.renderLivedoc.mockReset();
    harness.renderLivedoc.mockImplementation(async (input: {
      outDir: string;
      signal?: AbortSignal;
    }) => {
      await harness.gate!.promise;
      if (input.signal?.aborted) {
        throw new DOMException('Candidate preview was cancelled.', 'AbortError');
      }
      await mkdir(input.outDir, { recursive: true });
      const output = join(input.outDir, 'AUTH.html');
      await writeFile(output, '<html><body>Shared candidate</body></html>');
      return {
        outputs: [{ format: 'html', path: await realpath(output) }],
      };
    });
  });

  it('lets one caller abort without cancelling a shared render for another caller', async () => {
    const { renderPublicationCandidateSingleFlight } = await import(
      '../lib/publication-preview'
    );
    const model = previewModel();
    const entry = model.publications[0]!;
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = renderPublicationCandidateSingleFlight({
      root: '/workspace',
      entry,
      model,
      signal: firstController.signal,
    });
    const second = renderPublicationCandidateSingleFlight({
      root: '/workspace',
      entry,
      model,
      signal: secondController.signal,
    });
    const firstOutcome = first.then(
      () => undefined,
      (error: unknown) => error,
    );
    firstController.abort();
    harness.gate!.resolve(undefined);

    await expect(firstOutcome).resolves.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({
      kind: 'html',
      html: '<html><body>Shared candidate</body></html>',
    });
    expect(harness.renderLivedoc).toHaveBeenCalledTimes(1);
  });
});

function previewModel(): PublicationWorkspaceModel {
  const template: PublicationTemplateReadModel = {
    name: 'help-page',
    version: '1.1.0',
    source: 'builtin' as const,
    stability: 'stable' as const,
    display_name: 'Help Page',
    description: 'Customer help',
    audience: 'Customers',
    purpose: 'Explain a task',
    job: 'Complete a task',
    required_input: 'Active Doks',
    scope: 'per_dok' as const,
    default_format: 'html',
    output_formats: ['html' as const],
    supported_locales: ['en'],
    default_locale: 'en',
    variables: {},
    selection: {
      scope: 'per_dok' as const,
      eligible_dok_ids: ['AUTH'],
      default_kind: 'explicit' as const,
      allowed_kinds: ['all_eligible', 'filter', 'explicit'],
      excluded: [],
    },
  };
  return {
    locale: 'en',
    workspace_default_locale: 'en',
    templates: [template],
    doks: [{
      dok_id: 'AUTH',
      name: 'Authentication',
      status: 'active',
      tags: [],
      surfaces: ['web'],
    }],
    errors: [],
    publications: [{
      publication: {
        schema_version: 1,
        name: 'review-help',
        display_name: 'Review Help',
        template: 'help-page',
        selection: { mode: 'explicit', dok_ids: ['AUTH'] },
        selected_dok_ids: ['AUTH'],
        format: 'html',
        locale: 'en',
        vars: {},
        output_dir: 'help-page/review-help',
        update_mode: 'review',
        created_at: '2026-07-17T03:04:05.678Z',
      },
      effective_update_mode: 'review',
      definition_path: '/workspace/review-help.json',
      definition_sha256: 'definition',
      template,
      status: {
        render_state: 'update_available',
        publish_state: 'no_destination',
        freshness: 'proven',
        template_update_available: false,
        reasons: ['content_changed'],
        resolved_dok_ids: ['AUTH'],
        input_fingerprint: 'candidate-fingerprint',
      },
    }],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
