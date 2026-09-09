import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  workspaceRootMock,
  loadWorkspaceStateMock,
  loadDoksStateMock,
  loadLexiconMock,
  summarizeDoksMock,
  runScanMock,
} = vi.hoisted(() => ({
  workspaceRootMock: vi.fn(),
  loadWorkspaceStateMock: vi.fn(),
  loadDoksStateMock: vi.fn(),
  loadLexiconMock: vi.fn(),
  summarizeDoksMock: vi.fn(),
  runScanMock: vi.fn(),
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
  runEvaluate: vi.fn(),
}));

import { ParserLedgerIncompleteError } from '@doklo-beta/cli/api';
import { wizardRunScan } from '../lib/wizard-actions';

describe('wizard scan action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRootMock.mockReturnValue('/workspace');
    loadWorkspaceStateMock.mockResolvedValue({
      kind: 'ready',
      path: '/workspace/workspace.json',
      revision: 'workspace-revision',
      data: {
        workspace_id: 'workspace',
        name: 'Workspace',
        services: [{ service_id: 'web', framework: 'nextjs' }],
        default_locale: 'ko',
      },
    });
    loadDoksStateMock.mockResolvedValue({
      kind: 'ready',
      path: '/workspace/.doklo/hub/doks',
      revision: 'doks-revision',
      data: { doks: [], paths: {}, revisions: {} },
    });
    loadLexiconMock.mockResolvedValue(null);
    summarizeDoksMock.mockReturnValue([]);
  });

  it('serializes parser ledger failures without throwing across the server action boundary', async () => {
    runScanMock.mockRejectedValueOnce(new ParserLedgerIncompleteError({
      serviceId: 'web',
      failedFiles: ['src/broken.js'],
      failures: [{
        file: 'src/broken.js',
        stages: ['ast'],
        reason: "TS1005 667:34 ';' expected.",
        diagnosticCount: 655,
      }],
      preserved: ['/workspace/.doklo/cache/web.scan.json'],
      nextCommand: 'doklo scan --service web',
    } as never));

    await expect(wizardRunScan('web')).resolves.toEqual({
      ok: false,
      error: {
        code: 'PARSER_LEDGER_INCOMPLETE',
        serviceId: 'web',
        failedFiles: [{
          file: 'src/broken.js',
          stages: ['ast'],
          reason: "TS1005 667:34 ';' expected.",
          diagnosticCount: 655,
        }],
        preserved: ['/workspace/.doklo/cache/web.scan.json'],
        nextCommand: 'doklo scan --service web',
      },
    });
  });
});
