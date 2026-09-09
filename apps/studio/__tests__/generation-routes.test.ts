import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();
const resolverMock = vi.fn();

vi.mock('../lib/data', () => ({ workspaceRoot: () => '/workspace' }));
vi.mock('../lib/cli-bin', () => ({ resolveStudioCliBin: resolverMock }));
vi.mock('../lib/generate-subprocess', () => ({ streamCliGenerate: streamMock }));

const ORIGIN = 'http://localhost';
const ACTION_HEADER = 'x-doklo-generation-action';
const CONSENT_HEADER = 'x-doklo-generation-consent';

type PostHandler = (request: Request) => Promise<Response>;

async function authorizedRequest(handler: PostHandler, path: string): Promise<Request> {
  const consent = await handler(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      [ACTION_HEADER]: 'request-consent',
    },
  }));
  const { consentToken } = await consent.json() as { consentToken: string };
  const cookie = consent.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      [ACTION_HEADER]: 'start-generation',
      [CONSENT_HEADER]: consentToken,
      Cookie: cookie,
    },
  });
}

describe('generation routes', () => {
  const completions: Array<() => void> = [];

  beforeEach(() => {
    vi.resetModules();
    streamMock.mockReset();
    resolverMock.mockReset();
    resolverMock.mockResolvedValue('/cli.js');
    streamMock.mockImplementation(() => new Promise<void>((resolve) => {
      completions.push(resolve);
    }));
  });

  afterEach(async () => {
    completions.splice(0).forEach((complete) => complete());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
  });

  it('excludes a same-service consolidation run while a wizard run owns the shared lease, then reacquires after close', async () => {
    const { POST: wizardPost } = await import('../app/api/wizard/generate/route');
    const { POST: consolidationPost } = await import('../app/api/consolidation/generate/route');
    const wizardPath = '/api/wizard/generate?service=web';
    const consolidationPath = '/api/consolidation/generate?service=web';

    const wizard = await wizardPost(await authorizedRequest(wizardPost, wizardPath));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(streamMock).toHaveBeenCalledTimes(1);

    const blocked = await consolidationPost(
      await authorizedRequest(consolidationPost, consolidationPath),
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain('Generation already running');
    expect(streamMock).toHaveBeenCalledTimes(1);

    completions.shift()!();
    await wizard.text();

    const consolidation = await consolidationPost(
      await authorizedRequest(consolidationPost, consolidationPath),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(streamMock).toHaveBeenCalledTimes(2);
    completions.shift()!();
    await consolidation.text();
  });
});
