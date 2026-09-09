import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  workspaceRootMock,
  loadWorkspaceStateMock,
  loadDoksStateMock,
  loadLexiconMock,
  summarizeDoksMock,
  runScanMock,
  runEvaluateMock,
} = vi.hoisted(() => ({
  workspaceRootMock: vi.fn(),
  loadWorkspaceStateMock: vi.fn(),
  loadDoksStateMock: vi.fn(),
  loadLexiconMock: vi.fn(),
  summarizeDoksMock: vi.fn(),
  runScanMock: vi.fn(),
  runEvaluateMock: vi.fn(),
}));

vi.mock('../lib/data', () => ({
  workspaceRoot: workspaceRootMock,
  loadWorkspaceState: loadWorkspaceStateMock,
  loadDoksState: loadDoksStateMock,
  loadLexicon: loadLexiconMock,
  summarizeDoks: summarizeDoksMock,
}));

vi.mock('@doklo-beta/cli/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@doklo-beta/cli/api')>(),
  runScan: runScanMock,
  runEvaluate: runEvaluateMock,
}));

import OnboardingPage from '../app/(onboarding)/onboarding/page';
import * as wizardGenerateRoute from '../app/api/wizard/generate/route';
import {
  wizardGetState,
  wizardGetDoks,
  wizardRunEvaluate,
  wizardRunScan,
} from '../lib/wizard-actions';

const workspace = {
  workspace_id: 'workspace',
  name: 'Workspace',
  services: [{ service_id: 'web', framework: 'nextjs' }],
  default_locale: 'en',
};
const readyWorkspace = { kind: 'ready', path: '/workspace/workspace.json', data: workspace, revision: 'w' };
const readyDoks = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/doks',
  data: { doks: [{ dok_id: 'AUTH-SIGNIN' }], paths: {}, revisions: {} },
  revision: 'd',
};

describe('Studio production entry wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRootMock.mockReturnValue('/workspace');
    loadWorkspaceStateMock.mockResolvedValue(readyWorkspace);
    loadDoksStateMock.mockResolvedValue(readyDoks);
    loadLexiconMock.mockResolvedValue(null);
    summarizeDoksMock.mockReturnValue([{ dok_id: 'AUTH-SIGNIN', name: 'Auth', status: 'draft', anchorFiles: [] }]);
    runScanMock.mockResolvedValue({ results: [] });
    runEvaluateMock.mockResolvedValue({
      report: { total: 0, maxTotal: 0, totalDoks: 0, categories: {} },
    });
  });

  it('loads real onboarding without a demo environment flag', async () => {
    const page = await OnboardingPage();

    expect(loadWorkspaceStateMock).toHaveBeenCalledOnce();
    expect(page.props.workspaceName).toBe('Workspace');
    expect(page.props.initialState).toMatchObject({
      workspaceName: 'Workspace', services: [{ serviceId: 'web', framework: 'nextjs' }], existingDoks: 1,
    });
  });

  it.each([
    { kind: 'missing', path: '/workspace/workspace.json' },
    { kind: 'invalid', path: '/workspace/workspace.json', message: 'invalid JSON' },
    { kind: 'unreadable', path: '/workspace/workspace.json', message: 'EACCES' },
  ])('fails closed for a %s workspace before Dok, config, or runner work', async (state) => {
    loadWorkspaceStateMock.mockResolvedValue(state);

    await expect(OnboardingPage()).rejects.toThrow(/Run `doklo init`/);
    await expect(wizardRunScan('web')).rejects.toThrow(/Run `doklo init`/);
    await expect(wizardRunEvaluate()).rejects.toThrow(/Run `doklo init`/);
    await expect(wizardGetDoks()).rejects.toThrow(/Run `doklo init`/);

    expect(loadDoksStateMock).not.toHaveBeenCalled();
    expect(loadLexiconMock).not.toHaveBeenCalled();
    expect(workspaceRootMock).not.toHaveBeenCalled();
    expect(runScanMock).not.toHaveBeenCalled();
    expect(runEvaluateMock).not.toHaveBeenCalled();
  });

  it('exposes only a POST NDJSON wizard generation endpoint', async () => {
    expect((wizardGenerateRoute as { GET?: unknown }).GET).toBeUndefined();
    const response = await wizardGenerateRoute.POST(new Request('http://localhost/api/wizard/generate'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'missing service' });
    expect(workspaceRootMock).not.toHaveBeenCalled();
  });

  it('runs a real scan only for the selected workspace service', async () => {
    loadWorkspaceStateMock.mockResolvedValue({
      ...readyWorkspace,
      data: {
        ...workspace,
        services: [
          { service_id: 'web', framework: 'nextjs' },
          { service_id: 'api', framework: 'spring-boot' },
        ],
      },
    });
    runScanMock.mockResolvedValue({
      results: [{ counts: { routes: 2, components: 4, stores: 1 } }],
    });

    await expect(wizardRunScan('api')).resolves.toMatchObject({ workspaceName: 'Workspace', serviceCount: 1 });

    expect(runScanMock).toHaveBeenCalledWith({ root: '/workspace', serviceId: 'api' });
  });

  it('rejects an unknown selected service before scanning', async () => {
    await expect(wizardRunScan('missing')).rejects.toThrow(/Unknown workspace service/);
    expect(runScanMock).not.toHaveBeenCalled();
  });

  it('surfaces real scan and evaluator failures', async () => {
    runScanMock.mockRejectedValueOnce(new Error('scan failed'));
    await expect(wizardRunScan('web')).rejects.toThrow('scan failed');

    runEvaluateMock.mockRejectedValueOnce(new Error('evaluate failed'));
    await expect(wizardRunEvaluate()).rejects.toThrow('evaluate failed');
  });

  it('rejects a malformed Dok catalog before scan, evaluation, or Dok rendering', async () => {
    loadDoksStateMock.mockResolvedValue({
      kind: 'invalid', path: '/workspace/.doklo/hub/doks/BROKEN.json', message: 'invalid Dok',
    });

    await expect(wizardRunScan('web')).rejects.toThrow(/Dok catalog is invalid/);
    await expect(wizardRunEvaluate()).rejects.toThrow(/Dok catalog is invalid/);
    await expect(wizardGetDoks()).rejects.toThrow(/Dok catalog is invalid/);

    expect(runScanMock).not.toHaveBeenCalled();
    expect(runEvaluateMock).not.toHaveBeenCalled();
    expect(summarizeDoksMock).not.toHaveBeenCalled();
  });

  it('treats a missing Dok directory as an empty catalog', async () => {
    loadDoksStateMock.mockResolvedValue({ kind: 'missing', path: '/workspace/.doklo/hub/doks' });
    summarizeDoksMock.mockReturnValue([]);

    await expect(wizardGetDoks()).resolves.toEqual([]);

    expect(summarizeDoksMock).toHaveBeenCalledWith([], { lexicon: null, locale: 'en' });
  });

  it('rejects a Dok file that disappears after catalog enumeration', async () => {
    loadDoksStateMock.mockResolvedValue({
      kind: 'missing', path: '/workspace/.doklo/hub/doks/AUTH-SIGNIN.json',
    });

    await expect(wizardGetState()).rejects.toThrow(/Dok catalog is missing/);
    await expect(wizardRunScan('web')).rejects.toThrow(/Dok catalog is missing/);
    await expect(wizardRunEvaluate()).rejects.toThrow(/Dok catalog is missing/);
    await expect(wizardGetDoks()).rejects.toThrow(/Dok catalog is missing/);

    expect(runScanMock).not.toHaveBeenCalled();
    expect(runEvaluateMock).not.toHaveBeenCalled();
    expect(summarizeDoksMock).not.toHaveBeenCalled();
  });

  it('loads strict catalog summaries with the workspace locale', async () => {
    await expect(wizardGetDoks()).resolves.toEqual([
      { dok_id: 'AUTH-SIGNIN', name: 'Auth', status: 'draft', anchorFiles: [] },
    ]);

    expect(summarizeDoksMock).toHaveBeenCalledWith(readyDoks.data.doks, { lexicon: null, locale: 'en' });
  });
});
