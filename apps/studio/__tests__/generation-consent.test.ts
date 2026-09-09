import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();
const resolverMock = vi.fn();
const startOnboardingMock = vi.fn();
const activeMock = vi.fn();

vi.mock('../lib/data', () => ({ workspaceRoot: () => '/workspace' }));
vi.mock('../lib/cli-bin', () => ({ resolveStudioCliBin: resolverMock }));
vi.mock('../lib/generate-subprocess', () => ({ streamCliGenerate: streamMock }));
vi.mock('../lib/onboarding-generation', () => ({
  isGenerationActive: activeMock,
  startOnboardingGeneration: startOnboardingMock,
}));

const ORIGIN = 'http://localhost';
const ACTION_HEADER = 'x-doklo-generation-action';
const CONSENT_HEADER = 'x-doklo-generation-consent';

type PostHandler = (request: Request) => Promise<Response>;

function postRequest(
  path: string,
  headers: Record<string, string> = {},
  origin = ORIGIN,
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: origin, ...headers },
  });
}

async function issueConsent(handler: PostHandler, path: string) {
  const response = await handler(postRequest(path, {
    [ACTION_HEADER]: 'request-consent',
  }));
  expect(response.status).toBe(200);
  const payload = await response.json() as { consentToken?: unknown };
  expect(payload.consentToken).toEqual(expect.any(String));
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toEqual(expect.any(String));
  return { token: payload.consentToken as string, cookie: cookie as string };
}

function generationRequest(path: string, token: string, cookie: string): Request {
  return postRequest(path, {
    [ACTION_HEADER]: 'start-generation',
    [CONSENT_HEADER]: token,
    Cookie: cookie,
  });
}

beforeEach(() => {
  vi.resetModules();
  streamMock.mockReset();
  resolverMock.mockReset();
  startOnboardingMock.mockReset();
  activeMock.mockReset();
  resolverMock.mockResolvedValue('/cli.js');
  streamMock.mockResolvedValue(undefined);
  startOnboardingMock.mockResolvedValue(undefined);
  activeMock.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('generation consent boundary', () => {
  it.each([
    ['wizard', '../app/api/wizard/generate/route'],
    ['consolidation', '../app/api/consolidation/generate/route'],
  ])('rejects cross-origin consent issuance for %s generation', async (_label, modulePath) => {
    const route = await import(modulePath) as { POST: PostHandler };
    const response = await route.POST(postRequest(
      '/api/generate?service=web',
      { [ACTION_HEADER]: 'request-consent' },
      'https://attacker.example',
    ));

    expect(response.status).toBe(403);
    expect(startOnboardingMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('rejects a same-origin hostname that resolves to the local Studio', async () => {
    const { POST } = await import('../app/api/wizard/generate/route');
    const response = await POST(new Request(
      'http://attacker.example/api/wizard/generate?service=web',
      {
        method: 'POST',
        headers: {
          Origin: 'http://attacker.example',
          [ACTION_HEADER]: 'request-consent',
        },
      },
    ));

    expect(response.status).toBe(403);
    expect(startOnboardingMock).not.toHaveBeenCalled();
  });

  it('accepts the browser Host when a standalone server rewrites request.url', async () => {
    const { POST } = await import('../app/api/wizard/generate/route');
    const response = await POST(new Request(
      'http://127.0.0.1:3000/api/wizard/generate?service=web',
      {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4321',
          Origin: 'http://127.0.0.1:4321',
          [ACTION_HEADER]: 'request-consent',
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(startOnboardingMock).not.toHaveBeenCalled();
  });

  it('rejects a loopback Origin that does not match the browser Host', async () => {
    const { POST } = await import('../app/api/wizard/generate/route');
    const response = await POST(new Request(
      'http://127.0.0.1:3000/api/wizard/generate?service=web',
      {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:4321',
          Origin: 'http://localhost:4321',
          [ACTION_HEADER]: 'request-consent',
        },
      },
    ));

    expect(response.status).toBe(403);
    expect(startOnboardingMock).not.toHaveBeenCalled();
  });

  it.each([
    ['wizard', '../app/api/wizard/generate/route'],
    ['consolidation', '../app/api/consolidation/generate/route'],
  ])('rejects %s generation without the custom action header', async (_label, modulePath) => {
    const route = await import(modulePath) as { POST: PostHandler };
    const response = await route.POST(postRequest('/api/generate?service=web'));

    expect(response.status).toBe(403);
    expect(startOnboardingMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
  });

  it('binds wizard consent to the issuing browser session', async () => {
    const { POST } = await import('../app/api/wizard/generate/route');
    const path = '/api/wizard/generate?service=web';
    const consent = await issueConsent(POST, path);

    const response = await POST(postRequest(path, {
      [ACTION_HEADER]: 'start-generation',
      [CONSENT_HEADER]: consent.token,
    }));

    expect(response.status).toBe(403);
    expect(startOnboardingMock).not.toHaveBeenCalled();
  });

  it('consumes wizard consent once and rejects a replay', async () => {
    const { POST } = await import('../app/api/wizard/generate/route');
    const path = '/api/wizard/generate?service=web';
    const consent = await issueConsent(POST, path);

    const first = await POST(generationRequest(path, consent.token, consent.cookie));
    await first.text();
    const replay = await POST(generationRequest(path, consent.token, consent.cookie));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(403);
    expect(startOnboardingMock).toHaveBeenCalledTimes(1);
  });

  it('exposes consolidation generation as POST-only and consumes consent once', async () => {
    const route = await import('../app/api/consolidation/generate/route');
    expect((route as { GET?: unknown }).GET).toBeUndefined();
    const path = '/api/consolidation/generate?service=web';
    const consent = await issueConsent(route.POST, path);

    const first = await route.POST(generationRequest(path, consent.token, consent.cookie));
    await first.text();
    const replay = await route.POST(generationRequest(path, consent.token, consent.cookie));

    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(replay.status).toBe(403);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it('does not allow consent for one endpoint to start the other endpoint', async () => {
    const wizard = await import('../app/api/wizard/generate/route');
    const consolidation = await import('../app/api/consolidation/generate/route');
    const wizardPath = '/api/wizard/generate?service=web';
    const consent = await issueConsent(wizard.POST, wizardPath);

    const response = await consolidation.POST(generationRequest(
      '/api/consolidation/generate?service=web',
      consent.token,
      consent.cookie,
    ));

    expect(response.status).toBe(403);
    expect(streamMock).not.toHaveBeenCalled();
  });
});
