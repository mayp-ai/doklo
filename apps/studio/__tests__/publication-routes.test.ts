import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationWorkspaceModel } from '../lib/publication-read-model';

const {
  cliBinMock,
  loadModelMock,
  runCliMock,
} = vi.hoisted(() => ({
  cliBinMock: vi.fn(),
  loadModelMock: vi.fn(),
  runCliMock: vi.fn(),
}));

vi.mock('../lib/data', () => ({
  workspaceRoot: () => '/workspace',
}));
vi.mock('../lib/cli-bin', () => ({
  resolveStudioCliBin: cliBinMock,
}));
vi.mock('../lib/publication-read-model', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../lib/publication-read-model')
  >();
  return {
    ...actual,
    loadPublicationWorkspaceModel: loadModelMock,
  };
});
vi.mock('../lib/publication-cli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/publication-cli')>();
  return {
    ...actual,
    runPublicationCli: runCliMock,
  };
});

describe('livedocs collection route', () => {
  beforeEach(() => {
    vi.resetModules();
    cliBinMock.mockReset().mockResolvedValue('/cli.js');
    runCliMock.mockReset().mockResolvedValue({
      schema_version: 1,
      command: 'live-docs.publication.create',
      status: 'success',
      data: {},
      diagnostics: [],
      stderr_tail: '',
    });
    loadModelMock.mockReset().mockResolvedValue(model());
  });

  it('returns the authoritative catalog without caching', async () => {
    const { GET } = await import('../app/api/livedocs/route');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      locale: 'en',
      templates: [{ name: 'workspace-guide' }],
    });
  });

  it.each([
    ['unknown Template', { template: 'missing-template' }],
    ['unsupported locale', { locale: 'ja' }],
    ['unsupported format', { format: 'pptx' }],
    ['local automatic mode', { update_mode: 'automatic' }],
    ['unsafe destination', { destination: '../escape' }],
    ['ineligible Dok', {
      selection: { mode: 'explicit', dok_ids: ['MISSING'] },
    }],
  ])('rejects %s before spawning the CLI', async (_label, override) => {
    const { POST } = await import('../app/api/livedocs/route');
    const response = await POST(request({
      ...validBody(),
      ...override,
    }));

    expect(response.status).toBe(400);
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it('creates in review mode, renders once, and never publishes', async () => {
    runCliMock
      .mockResolvedValueOnce({
        schema_version: 1,
        command: 'live-docs.publication.create',
        status: 'success',
        data: {},
        diagnostics: [],
        stderr_tail: '',
      })
      .mockResolvedValueOnce({
        schema_version: 1,
        command: 'live-docs.publication.render',
        status: 'success',
        data: {},
        diagnostics: [],
        stderr_tail: '',
      });
    const { POST } = await import('../app/api/livedocs/route');
    const response = await POST(request(validBody()));

    expect(response.status).toBe(201);
    expect(runCliMock).toHaveBeenCalledTimes(2);
    expect(runCliMock.mock.calls[0]![0]).toMatchObject({
      operation: {
        kind: 'create',
        name: 'workspace-guide',
        args: expect.arrayContaining(['--update-mode', 'review']),
      },
    });
    expect(runCliMock.mock.calls[1]![0]).toMatchObject({
      operation: {
        kind: 'render',
        name: 'workspace-guide',
      },
    });
    expect(
      runCliMock.mock.calls.some(
        ([input]) => input.operation.kind === 'publish',
      ),
    ).toBe(false);
  });

  it('keeps all-eligible selection dynamic for a Template-gated Publication', async () => {
    const gated = model();
    gated.templates[0]!.scope = 'selected_doks';
    gated.templates[0]!.selection = {
      ...gated.templates[0]!.selection,
      scope: 'selected_doks',
      default_kind: 'template',
    };
    loadModelMock.mockResolvedValue(gated);
    const { POST } = await import('../app/api/livedocs/route');

    const response = await POST(request(validBody()));

    expect(response.status).toBe(201);
    const create = runCliMock.mock.calls[0]![0].operation;
    expect(create).toMatchObject({ kind: 'create' });
    if (create.kind !== 'create') throw new Error('expected create operation');
    expect(create.args).toContain('--all');
    expect(create.args).not.toContain('--dok-id');
  });

  it('returns the created definition and fresh model when the initial render fails', async () => {
    runCliMock
      .mockResolvedValueOnce(successResult('create'))
      .mockResolvedValueOnce({
        schema_version: 1,
        command: 'live-docs.publication.render',
        status: 'failed',
        data: null,
        diagnostics: [{
          code: 'PUBLICATION_RENDER_FAILED',
          message: 'The initial render failed.',
        }],
        stderr_tail: '',
      });
    const created = model();
    created.publications = [actionModel().publications[0]!];
    loadModelMock
      .mockResolvedValueOnce(model())
      .mockResolvedValueOnce(created);

    const { POST } = await import('../app/api/livedocs/route');
    const response = await POST(request(validBody()));

    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      status: 'partial',
      completed: ['create'],
      failed: 'render',
      code: 'PUBLICATION_RENDER_FAILED',
      model: {
        publications: [{
          publication: { name: 'review-guide' },
        }],
      },
    });
  });
});

describe('livedocs action route', () => {
  beforeEach(() => {
    vi.resetModules();
    cliBinMock.mockReset().mockResolvedValue('/cli.js');
    runCliMock.mockReset().mockResolvedValue({
      schema_version: 1,
      command: 'live-docs.publication.action',
      status: 'success',
      data: {},
      diagnostics: [],
      stderr_tail: '',
    });
    loadModelMock.mockReset().mockResolvedValue(actionModel());
  });

  it('approves dynamic review changes through resnapshot, render, dry-run, and publish', async () => {
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('approve'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock.mock.calls.map(
      ([input]) => [
        input.operation.kind,
        input.operation.kind === 'publish'
          ? input.operation.dryRun
          : undefined,
      ],
    )).toEqual([
      ['create', undefined],
      ['render', undefined],
      ['publish', true],
      ['publish', false],
    ]);
    expect(runCliMock.mock.calls[0]![0].operation.args).toEqual(
      expect.arrayContaining(['--overwrite', '--update-mode', 'review']),
    );
  });

  it('approves an explicit review selection without resnapshotting it', async () => {
    const explicit = actionModel();
    explicit.publications[0]!.publication.selection = {
      mode: 'explicit',
      dok_ids: ['AUTH'],
    };
    loadModelMock.mockResolvedValue(explicit);
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('approve'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock.mock.calls.map(
      ([input]) => input.operation.kind,
    )).toEqual(['render', 'publish', 'publish']);
  });

  it('builds a dynamic Publication from a refreshed membership snapshot', async () => {
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('render'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock.mock.calls.map(([input]) => input.operation)).toEqual([
      {
        kind: 'create',
        name: 'review-guide',
        args: expect.arrayContaining(['--overwrite']),
      },
      {
        kind: 'render',
        name: 'review-guide',
        overwrite: true,
        dryRun: false,
      },
    ]);
  });

  it('builds an explicit Publication without overwriting its definition', async () => {
    const explicit = actionModel();
    explicit.publications[0]!.publication.selection = {
      mode: 'explicit',
      dok_ids: ['AUTH'],
    };
    loadModelMock.mockResolvedValue(explicit);
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('render'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock.mock.calls.map(([input]) => input.operation)).toEqual([
      {
        kind: 'render',
        name: 'review-guide',
        overwrite: true,
        dryRun: false,
      },
    ]);
  });

  it('preserves a refreshed dynamic membership when rendering it fails', async () => {
    runCliMock
      .mockResolvedValueOnce(successResult('create'))
      .mockResolvedValueOnce({
        schema_version: 1,
        command: 'live-docs.publication.render',
        status: 'failed',
        data: null,
        diagnostics: [{
          code: 'PUBLICATION_RENDER_FAILED',
          message: 'The render failed.',
        }],
        stderr_tail: '',
      });
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('render'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      status: 'partial',
      completed: ['resnapshot'],
      failed: 'render',
      code: 'PUBLICATION_RENDER_FAILED',
    });
  });

  it('validates a publish plan before publishing', async () => {
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('publish'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock.mock.calls.map(
      ([input]) => input.operation,
    )).toEqual([
      { kind: 'publish', name: 'review-guide', dryRun: true },
      { kind: 'publish', name: 'review-guide', dryRun: false },
    ]);
  });

  it('exports the last official render through the CLI bridge', async () => {
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('export'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock).toHaveBeenCalledTimes(1);
    expect(runCliMock.mock.calls[0]![0].operation).toEqual({
      kind: 'export',
      name: 'review-guide',
    });
  });

  it('allows a blocked dynamic Publication to resnapshot for recovery', async () => {
    const blocked = actionModel();
    blocked.publications[0]!.status.render_state = 'blocked';
    blocked.publications[0]!.status.reasons = ['missing_dok'];
    loadModelMock.mockResolvedValue(blocked);
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('resnapshot'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(200);
    expect(runCliMock).toHaveBeenCalledTimes(1);
    expect(runCliMock.mock.calls[0]![0].operation).toMatchObject({
      kind: 'create',
      name: 'review-guide',
    });
  });

  it('rejects a stale fingerprint with zero mutation', async () => {
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('render', 'stale'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(409);
    expect(runCliMock).not.toHaveBeenCalled();
  });

  it('reports a preserved official render when publish fails after approval', async () => {
    runCliMock
      .mockResolvedValueOnce(successResult('create'))
      .mockResolvedValueOnce(successResult('render'))
      .mockResolvedValueOnce(successResult('publish'))
      .mockResolvedValueOnce({
        schema_version: 1,
        command: 'live-docs.publication.publish',
        status: 'failed',
        data: null,
        diagnostics: [{
          code: 'PUBLICATION_PUBLISH_BLOCKED',
          message: 'Destination conflict.',
        }],
        stderr_tail: '',
      });
    const { POST } = await import('../app/api/livedocs/[name]/action/route');
    const response = await POST(actionRequest('approve'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });

    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      status: 'partial',
      completed: ['resnapshot', 'render', 'publish-dry-run'],
      failed: 'publish',
      code: 'PUBLICATION_PUBLISH_BLOCKED',
    });
  });

  it('rejects an overlapping official action under the Publication lease', async () => {
    const { acquirePublicationRun } = await import('../lib/publication-run');
    const lease = acquirePublicationRun('/workspace', 'review-guide');
    try {
      const { POST } = await import('../app/api/livedocs/[name]/action/route');
      const response = await POST(actionRequest('render'), {
        params: Promise.resolve({ name: 'review-guide' }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'PUBLICATION_ALREADY_RUNNING',
      });
      expect(runCliMock).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
  });

  it('holds the Publication lease until a deferred official action settles', async () => {
    const explicit = actionModel();
    explicit.publications[0]!.publication.selection = {
      mode: 'explicit',
      dok_ids: ['AUTH'],
    };
    loadModelMock.mockResolvedValue(explicit);
    const firstCommand = deferred<ReturnType<typeof successResult>>();
    runCliMock
      .mockImplementationOnce(() => firstCommand.promise)
      .mockResolvedValue(successResult('render'));
    const { POST } = await import('../app/api/livedocs/[name]/action/route');

    const firstResponsePromise = POST(actionRequest('render'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });
    await vi.waitFor(() => expect(runCliMock).toHaveBeenCalledTimes(1));

    const overlapping = await POST(actionRequest('render'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });
    expect(overlapping.status).toBe(409);
    expect(await overlapping.json()).toMatchObject({
      code: 'PUBLICATION_ALREADY_RUNNING',
    });
    expect(runCliMock).toHaveBeenCalledTimes(1);

    firstCommand.resolve(successResult('render'));
    expect((await firstResponsePromise).status).toBe(200);

    const afterSettlement = await POST(actionRequest('render'), {
      params: Promise.resolve({ name: 'review-guide' }),
    });
    expect(afterSettlement.status).toBe(200);
    expect(runCliMock).toHaveBeenCalledTimes(2);
  });
});

function request(body: unknown): Request {
  return new Request('http://localhost/api/livedocs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    name: 'workspace-guide',
    display_name: 'Workspace Guide',
    template: 'workspace-guide',
    selection: { mode: 'all_eligible' },
    update_mode: 'review',
    locale: 'en',
    format: 'markdown',
    vars: {},
    destination: 'docs/guide',
  };
}

function model(): PublicationWorkspaceModel {
  return {
    locale: 'en',
    workspace_default_locale: 'en',
    publications: [],
    errors: [],
    doks: [
      {
        dok_id: 'AUTH',
        name: 'Authentication',
        status: 'active',
        tags: ['public'],
        surfaces: ['web'],
      },
      {
        dok_id: 'DRAFT',
        name: 'Draft',
        status: 'draft',
        tags: ['public'],
        surfaces: ['web'],
      },
    ],
    templates: [{
      name: 'workspace-guide',
      version: '1.0.0',
      source: 'builtin',
      stability: 'stable',
      display_name: 'Workspace guide',
      description: 'Guide',
      audience: 'Product teams',
      purpose: 'Explain the product',
      job: 'Review',
      required_input: 'Active Doks',
      scope: 'workspace',
      default_format: 'markdown',
      output_formats: ['markdown', 'html'],
      supported_locales: ['en', 'ko'],
      default_locale: 'en',
      variables: {},
      selection: {
        scope: 'workspace',
        eligible_dok_ids: ['AUTH'],
        default_kind: 'all_eligible',
        allowed_kinds: ['all_eligible', 'filter', 'explicit'],
        excluded: [{ dok_id: 'DRAFT', reason: 'unreviewed' }],
      },
    }],
  };
}

function actionRequest(
  action: 'render' | 'approve' | 'publish' | 'export' | 'resnapshot',
  fingerprint = 'current-fingerprint',
): Request {
  return new Request(
    'http://localhost/api/livedocs/review-guide/action',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, fingerprint }),
    },
  );
}

function actionModel(): PublicationWorkspaceModel {
  const base = model();
  const template = base.templates[0]!;
  return {
    ...base,
    publications: [{
      publication: {
        schema_version: 1,
        name: 'review-guide',
        display_name: 'Review Guide',
        template: template.name,
        selection: { mode: 'filter', statuses: ['active'] },
        selected_dok_ids: ['AUTH'],
        format: 'markdown',
        locale: 'en',
        vars: {},
        output_dir: 'workspace-guide/review-guide',
        destination: { kind: 'repo_path', path: 'docs/guide' },
        update_mode: 'review',
        created_at: '2026-07-17T03:04:05.678Z',
      },
      effective_update_mode: 'review',
      definition_path: '/workspace/review-guide.json',
      definition_sha256: 'current-definition',
      template,
      status: {
        render_state: 'update_available',
        publish_state: 'publish_needed',
        freshness: 'proven',
        template_update_available: false,
        reasons: ['content_changed'],
        resolved_dok_ids: ['AUTH'],
        input_fingerprint: 'current-fingerprint',
      },
    }],
  };
}

function successResult(kind: string) {
  return {
    schema_version: 1,
    command: `live-docs.publication.${kind}`,
    status: 'success',
    data: {},
    diagnostics: [],
    stderr_tail: '',
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
