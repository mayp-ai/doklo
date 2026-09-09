import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadWorkspaceStateMock,
  loadDoksStateMock,
  loadLexiconMock,
  summarizeDoksMock,
} = vi.hoisted(() => ({
  loadWorkspaceStateMock: vi.fn(),
  loadDoksStateMock: vi.fn(),
  loadLexiconMock: vi.fn(),
  summarizeDoksMock: vi.fn(),
}));

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: readFileMock,
}));

vi.mock('node:os', () => ({ homedir: () => '/home/studio' }));

vi.mock('../lib/data', () => ({
  loadWorkspaceState: loadWorkspaceStateMock,
  loadDoksState: loadDoksStateMock,
  loadLexicon: loadLexiconMock,
  summarizeDoks: summarizeDoksMock,
}));

import { wizardGetState } from '../lib/wizard-actions';

const workspace = {
  workspace_id: 'workspace',
  name: 'Workspace',
  services: [
    { service_id: 'web', framework: 'nextjs' },
    { service_id: 'api', framework: 'fastapi' },
  ],
  default_locale: 'en',
};

const readyWorkspace = { kind: 'ready', path: '/workspace/workspace.json', data: workspace, revision: 'w' };
const readyDoks = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/doks',
  data: { doks: [{ dok_id: 'AUTH-SIGNIN' }, { dok_id: 'CAT' }], paths: {}, revisions: {} },
  revision: 'd',
};

function ledgerEntry(overrides: Record<string, unknown> = {}) {
  return {
    sourceFeatureId: 'feature-auth',
    serviceId: 'web',
    canonicalFeatureId: 'auth',
    dokId: 'AUTH-SIGNIN',
    status: 'success',
    reasonCode: 'GENERATED',
    message: 'Generated Dok.',
    ...overrides,
  };
}

describe('Studio onboarding workspace state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('XDG_CONFIG_HOME', '/config/doklo');
    loadWorkspaceStateMock.mockResolvedValue(readyWorkspace);
    loadDoksStateMock.mockResolvedValue(readyDoks);
    readFileMock.mockRejectedValue(Object.assign(new Error('missing file'), { code: 'ENOENT' }));
    loadLexiconMock.mockResolvedValue(undefined);
    summarizeDoksMock.mockReturnValue([
      { dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft', anchorFiles: ['app/login/page.tsx'] },
      { dok_id: 'CAT', name: 'Catalog', status: 'reviewed', anchorFiles: [] },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns real workspace services and existing Dok count', async () => {
    await expect(wizardGetState()).resolves.toEqual({
      workspaceName: 'Workspace',
      workspacePath: '/workspace',
      services: [
        { serviceId: 'web', framework: 'nextjs', scan: { status: 'missing', counts: null } },
        { serviceId: 'api', framework: 'fastapi', scan: { status: 'missing', counts: null } },
      ],
      existingDoks: 2,
      doks: [
        { dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft', anchorFiles: ['app/login/page.tsx'] },
        { dok_id: 'CAT', name: 'Catalog', status: 'reviewed', anchorFiles: [] },
      ],
      generation: { status: 'none', summary: null, completedAt: null },
      model: null,
      provider: null,
    });
  });

  it('loads validated cached scan counts and the durable generation ledger', async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/web.scan.json') {
        return JSON.stringify({
          framework: 'nextjs',
          root: '/workspace',
          files: [],
          routes: [],
          components: [],
          stores: [],
          role_signals: [],
        });
      }
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          model: 'anthropic/claude-sonnet-5',
          planDigest: 'sha256:test',
          startedAt: '2026-07-23T00:00:00.000Z',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [{
            sourceFeatureId: 'feature-auth',
            serviceId: 'web',
            canonicalFeatureId: 'auth',
            dokId: 'AUTH-SIGNIN',
            status: 'failed',
            reasonCode: 'GENERATION_FAILED',
            message: 'Provider timeout',
          }],
          summary: { sourceFeatures: 1, success: 0, skipped: 0, failed: 1 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      workspacePath: '/workspace',
      services: [
        { serviceId: 'web', scan: { status: 'ready', counts: { routes: 0, components: 0, stores: 0 } } },
        { serviceId: 'api', scan: { status: 'missing', counts: null } },
      ],
      generation: {
        status: 'partial',
        summary: { sourceFeatures: 1, success: 0, skipped: 0, failed: 1 },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    });
  });

  it('restores a valid zero-source ledger with an empty Hub as no candidates', async () => {
    loadDoksStateMock.mockResolvedValue({
      kind: 'empty',
      path: '/workspace/.doklo/hub/doks',
      data: { doks: [], paths: {}, revisions: {} },
      revision: 'empty',
    });
    summarizeDoksMock.mockReturnValue([]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          model: 'anthropic/claude-sonnet-5',
          planDigest: 'none',
          startedAt: '2026-07-23T00:00:00.000Z',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [],
          summary: { sourceFeatures: 0, success: 0, skipped: 0, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      existingDoks: 0,
      doks: [],
      generation: {
        status: 'no-candidates',
        summary: { sourceFeatures: 0, success: 0, skipped: 0, failed: 0 },
      },
    });
  });

  it('restores an all-excluded ledger with no Dok targets as no candidates', async () => {
    loadDoksStateMock.mockResolvedValue({
      kind: 'empty',
      path: '/workspace/.doklo/hub/doks',
      data: { doks: [], paths: {}, revisions: {} },
      revision: 'empty',
    });
    summarizeDoksMock.mockReturnValue([]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [ledgerEntry({
            dokId: null,
            status: 'skipped',
            reasonCode: 'EXCLUDED_BY_CONSOLIDATION',
            message: 'Excluded by consolidation.',
          })],
          summary: { sourceFeatures: 1, success: 0, skipped: 1, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      existingDoks: 0,
      generation: {
        status: 'no-candidates',
        summary: { sourceFeatures: 1, dokTargets: 0 },
      },
    });
  });

  it('derives restored Dok targets from unique ledger dok IDs', async () => {
    loadDoksStateMock.mockResolvedValue({
      kind: 'ready',
      path: '/workspace/.doklo/hub/doks',
      data: { doks: [{ dok_id: 'AUTH-SIGNIN' }], paths: {}, revisions: {} },
      revision: 'partial',
    });
    summarizeDoksMock.mockReturnValue([
      { dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft', anchorFiles: [] },
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [
            ledgerEntry({ sourceFeatureId: 'feature-auth-email' }),
            ledgerEntry({ sourceFeatureId: 'feature-auth-password' }),
            ledgerEntry({
              sourceFeatureId: 'feature-message',
              canonicalFeatureId: 'message',
              dokId: 'MSG',
              status: 'failed',
              reasonCode: 'GENERATION_FAILED',
              message: 'Provider timeout.',
            }),
            ledgerEntry({
              sourceFeatureId: 'feature-internal',
              canonicalFeatureId: 'internal',
              dokId: null,
              status: 'skipped',
              reasonCode: 'EXCLUDED_BY_CONSOLIDATION',
              message: 'Excluded by consolidation.',
            }),
          ],
          summary: { sourceFeatures: 4, success: 2, skipped: 1, failed: 1 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      generation: {
        status: 'partial',
        summary: {
          sourceFeatures: 4,
          success: 2,
          skipped: 1,
          failed: 1,
          dokTargets: 2,
          dokTargetIds: ['AUTH-SIGNIN', 'MSG'],
        },
      },
    });
  });

  it('accepts the same source feature ID when it belongs to different services', async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [
            ledgerEntry({ sourceFeatureId: 'route-root', serviceId: 'web', dokId: 'AUTH-SIGNIN' }),
            ledgerEntry({
              sourceFeatureId: 'route-root',
              serviceId: 'api',
              canonicalFeatureId: 'catalog',
              dokId: 'CAT',
            }),
          ],
          summary: { sourceFeatures: 2, success: 2, skipped: 0, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      generation: {
        status: 'complete',
        summary: {
          dokTargets: 2,
          dokTargetIds: ['AUTH-SIGNIN', 'CAT'],
        },
      },
    });
  });

  it('fails closed when a persisted ledger contains an invalid Dok ID', async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [ledgerEntry({
            dokId: '../../../outside',
            status: 'skipped',
            reasonCode: 'EXISTING_PRESERVED',
            message: 'Existing Dok preserved.',
          })],
          summary: { sourceFeatures: 1, success: 0, skipped: 1, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      generation: { status: 'unavailable', summary: null, completedAt: null },
    });
  });

  it('fails closed when persisted summary counts contradict validated entries', async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [ledgerEntry({
            status: 'failed',
            reasonCode: 'GENERATION_FAILED',
            message: 'Provider timeout.',
          })],
          summary: { sourceFeatures: 1, success: 1, skipped: 0, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      generation: { status: 'unavailable', summary: null, completedAt: null },
    });
  });

  it.each([
    {
      label: 'missing source identity',
      entry: ledgerEntry({ sourceFeatureId: undefined }),
    },
    {
      label: 'status and reason mismatch',
      entry: ledgerEntry({ status: 'success', reasonCode: 'GENERATION_FAILED' }),
    },
  ])('fails closed for a malformed ledger entry: $label', async ({ entry }) => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path === '/workspace/.doklo/cache/generation-ledger.json') {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [entry],
          summary: { sourceFeatures: 1, success: 1, skipped: 0, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      generation: { status: 'unavailable', summary: null, completedAt: null },
    });
  });

  it('does not trust a scan cache or generation ledger for another workspace', async () => {
    readFileMock.mockImplementation(async (path: string) => {
      if (path.endsWith('web.scan.json')) return JSON.stringify({ framework: 'nextjs' });
      if (path.endsWith('generation-ledger.json')) {
        return JSON.stringify({
          schema_version: 1,
          workspaceId: 'different-workspace',
          completedAt: '2026-07-23T00:01:00.000Z',
          entries: [],
          summary: { sourceFeatures: 0, success: 0, skipped: 0, failed: 0 },
        });
      }
      throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
    });

    await expect(wizardGetState()).resolves.toMatchObject({
      services: [
        { serviceId: 'web', scan: { status: 'invalid', counts: null } },
        { serviceId: 'api', scan: { status: 'missing', counts: null } },
      ],
      generation: { status: 'unavailable', summary: null, completedAt: null },
    });
  });

  it('does not read Doks or user config when the workspace is missing', async () => {
    loadWorkspaceStateMock.mockResolvedValue({ kind: 'missing', path: '/workspace/workspace.json' });

    await expect(wizardGetState()).rejects.toThrow(/Run `doklo init`/);

    expect(loadDoksStateMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('prefers the generate model over the default model without disclosing config siblings', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      models: {
        generate: { primary: 'openai/gpt-5.6' },
        default: { primary: 'anthropic/claude-sonnet-4-20250514' },
      },
      apiKey: 'must-not-leak',
      auth: { order: { openai: ['openai:default'] } },
      providers: { openai: { kind: 'openai' } },
    }));

    await expect(wizardGetState()).resolves.toMatchObject({
      model: 'openai/gpt-5.6',
      provider: 'openai',
    });
    await expect(wizardGetState()).resolves.not.toHaveProperty('apiKey');
  });

  it('uses the default model when generation has no model', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      models: { default: { primary: 'anthropic/claude-sonnet-4-20250514' } },
    }));

    await expect(wizardGetState()).resolves.toMatchObject({
      model: 'anthropic/claude-sonnet-4-20250514',
      provider: 'anthropic',
    });
  });

  it('rejects malformed selected model references without falling back', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      models: {
        generate: { primary: 'sk-live-secret' },
        default: { primary: 'anthropic/claude-sonnet-4-20250514' },
      },
    }));

    await expect(wizardGetState()).resolves.toMatchObject({ model: null, provider: null });
  });

  it.each([
    'model-without-provider',
    '/missing-provider',
    'openai/',
    'openai/gpt\nsecret',
    'openai/  ',
    ['openai/gpt'],
    { primary: 'openai/gpt' },
    `openai/${'g'.repeat(300)}`,
  ])('returns no model for an invalid configured reference: %j', async (primary) => {
    readFileMock.mockResolvedValue(JSON.stringify({ models: { default: { primary } } }));

    await expect(wizardGetState()).resolves.toMatchObject({ model: null, provider: null });
  });

  it('rejects oversized config files', async () => {
    readFileMock.mockResolvedValue('x'.repeat(65_537));

    await expect(wizardGetState()).resolves.toMatchObject({ model: null, provider: null });
  });

  it('uses only an absolute nonempty XDG config directory', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    await wizardGetState();
    expect(readFileMock).toHaveBeenCalledWith('/home/studio/.config/doklo/config.json', 'utf-8');

    vi.stubEnv('XDG_CONFIG_HOME', 'relative-config');

    await wizardGetState();

    expect(readFileMock).toHaveBeenCalledWith('/home/studio/.config/doklo/config.json', 'utf-8');

    vi.stubEnv('XDG_CONFIG_HOME', '/absolute-config');
    await wizardGetState();
    expect(readFileMock).toHaveBeenCalledWith('/absolute-config/doklo/config.json', 'utf-8');
  });
});
