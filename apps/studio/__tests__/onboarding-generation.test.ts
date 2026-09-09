import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GenerationAlreadyRunningError,
  acquireGenerationRun,
  isGenerationActive,
  startOnboardingGeneration,
} from '../lib/onboarding-generation';

describe('onboarding generation', () => {
  it('enriches successful dok events from the persisted Hub in stream order', async () => {
    const events: Record<string, unknown>[] = [];

    await startOnboardingGeneration(
      { root: '/workspace', service: 'web' },
      async (event) => {
        events.push(event);
      },
      {
        cliBin: '/cli.js',
        stream: async (_opts, emit) => {
          const first = emit({ stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true });
          await emit({ stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 });
          await first;
          await emit({ stage: 'clean-close' });
        },
        summarizeDok: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return {
            dok_id: 'AUTH-SIGNIN',
            name: 'Sign in',
            status: 'draft',
            anchorFiles: ['app/login/page.tsx'],
          };
        },
      },
    );

    expect(events).toMatchObject([
      {
        stage: 'dok-done',
        dok: {
          dok_id: 'AUTH-SIGNIN',
          name: 'Sign in',
          anchorFiles: ['app/login/page.tsx'],
        },
      },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ]);
  });

  it('forwards successful dok events unchanged when the persisted summary is absent', async () => {
    const events: Record<string, unknown>[] = [];
    const original = { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true };

    await startOnboardingGeneration(
      { root: '/workspace', service: 'web' },
      (event) => {
        events.push(event);
      },
      {
        cliBin: '/cli.js',
        stream: async (_opts, emit) => {
          await emit(original);
        },
        summarizeDok: async () => null,
      },
    );

    expect(events).toEqual([original]);
  });

  it('rejects a concurrent run for the same workspace and service', () => {
    const first = acquireGenerationRun('/workspace', 'web');
    expect(isGenerationActive('/workspace', 'web')).toBe(true);
    expect(() => acquireGenerationRun('/workspace', 'web')).toThrow(
      GenerationAlreadyRunningError,
    );
    first.release();
    expect(isGenerationActive('/workspace', 'web')).toBe(false);
  });

  it('releases a run lease after stream failure', async () => {
    await expect(
      startOnboardingGeneration(
        { root: '/workspace', service: 'web' },
        () => {},
        {
          cliBin: '/cli.js',
          stream: async () => {
            throw new Error('stream failed');
          },
          summarizeDok: async () => null,
        },
      ),
    ).rejects.toThrow('stream failed');

    expect(isGenerationActive('/workspace', 'web')).toBe(false);
  });
});

describe('wizard generation route', () => {
  const startMock = vi.fn();
  const activeMock = vi.fn();
  const endpoint = 'http://localhost/api/wizard/generate?service=web';

  async function authorizedRequest(
    post: (request: Request) => Promise<Response>,
  ): Promise<Request> {
    const consent = await post(new Request(endpoint, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'x-doklo-generation-action': 'request-consent',
      },
    }));
    const { consentToken } = await consent.json() as { consentToken: string };
    const cookie = consent.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    return new Request(endpoint, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'x-doklo-generation-action': 'start-generation',
        'x-doklo-generation-consent': consentToken,
        Cookie: cookie,
      },
    });
  }

  beforeEach(() => {
    vi.resetModules();
    startMock.mockReset();
    activeMock.mockReset();
    vi.doMock('../lib/data', () => ({ workspaceRoot: () => '/workspace' }));
    vi.doMock('../lib/onboarding-generation', () => ({
      isGenerationActive: activeMock,
      startOnboardingGeneration: startMock,
    }));
  });

  it('rejects a missing service before starting generation', async () => {
    const { POST } = await import('../app/api/wizard/generate/route');
    const response = await POST(new Request('http://localhost/api/wizard/generate'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'missing service' });
    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the workspace service already has an active run', async () => {
    activeMock.mockReturnValue(true);
    const { POST } = await import('../app/api/wizard/generate/route');
    const response = await POST(await authorizedRequest(POST));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Generation already running' });
    expect(startMock).not.toHaveBeenCalled();
  });

  it('streams each event as newline-delimited JSON without caching', async () => {
    activeMock.mockReturnValue(false);
    startMock.mockImplementation(async (_input, emit) => {
      await emit({ stage: 'plan', total: 1 });
      await emit({ stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 });
    });
    const { POST } = await import('../app/api/wizard/generate/route');
    const response = await POST(await authorizedRequest(POST));

    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      { stage: 'plan', total: 1 },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
    ]);
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ root: '/workspace', service: 'web' }),
      expect.any(Function),
    );
  });
});
