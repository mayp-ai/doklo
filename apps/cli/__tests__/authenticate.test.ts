import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '../src/lib/credentials.js';
import type { BrowserLoginProgress, CodexTokens } from '../src/lib/codex-auth.js';

const {
  cancelValue,
  isCancelMock,
  logInfoMock,
  loginWithBrowserMock,
  passwordPromptMock,
  selectPromptMock,
  spinnerFactoryMock,
  spinnerStartMock,
  spinnerMessageMock,
  spinnerStopMock,
  spinnerErrorMock,
  timeline,
} = vi.hoisted(() => {
  const ordered: string[] = [];
  return {
    cancelValue: Symbol('cancel'),
    isCancelMock: vi.fn(),
    logInfoMock: vi.fn((message: string) => ordered.push(`log:${message}`)),
    loginWithBrowserMock: vi.fn(),
    passwordPromptMock: vi.fn(),
    selectPromptMock: vi.fn(),
    spinnerFactoryMock: vi.fn(),
    spinnerStartMock: vi.fn((message: string) => ordered.push(`start:${message}`)),
    spinnerMessageMock: vi.fn((message: string) => ordered.push(`message:${message}`)),
    spinnerStopMock: vi.fn((message: string) => ordered.push(`stop:${message}`)),
    spinnerErrorMock: vi.fn((message: string) => ordered.push(`error:${message}`)),
    timeline: ordered,
  };
});

vi.mock('@clack/prompts', () => ({
  isCancel: isCancelMock,
  log: { info: logInfoMock },
  password: passwordPromptMock,
  select: selectPromptMock,
  spinner: spinnerFactoryMock,
}));

vi.mock('../src/lib/codex-auth.js', () => ({
  loginWithBrowser: loginWithBrowserMock,
}));

import { authenticateProvider } from '../src/lib/authenticate.js';
import { createContext } from '../src/lib/context.js';

function credentialStore(overrides: Partial<CredentialStore> = {}): CredentialStore {
  return {
    get: () => null,
    set(profileId, value) {
      timeline.push(`store:${profileId}:${value}`);
    },
    delete: () => false,
    ...overrides,
  };
}

const oauthTokens: CodexTokens = {
  method: 'oauth',
  flavor: 'codex',
  access: 'oauth-access-secret',
  refresh: 'oauth-refresh-secret',
  expires: Date.now() + 60_000,
};

function emitOAuthProgress(
  onProgress: ((event: BrowserLoginProgress) => void) | undefined,
): void {
  onProgress?.({
    phase: 'browser-opening',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=public-state',
  });
  onProgress?.({ phase: 'browser-waiting' });
  onProgress?.({ phase: 'callback-received' });
  onProgress?.({ phase: 'token-exchanging' });
}

beforeEach(() => {
  timeline.length = 0;
  vi.clearAllMocks();
  isCancelMock.mockImplementation((value) => value === cancelValue);
  selectPromptMock.mockResolvedValue('oauth');
  passwordPromptMock.mockResolvedValue('api-key-secret');
  spinnerFactoryMock.mockReturnValue({
    start: spinnerStartMock,
    message: spinnerMessageMock,
    stop: spinnerStopMock,
    error: spinnerErrorMock,
    cancel: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  });
  loginWithBrowserMock.mockImplementation(
    async ({ onProgress }: { onProgress?: (event: BrowserLoginProgress) => void }) => {
      emitOAuthProgress(onProgress);
      return oauthTokens;
    },
  );
});

describe('authenticateProvider progress', () => {
  it('keeps OAuth visibly active through callback, token exchange, and credential storage', async () => {
    const store = credentialStore({
      set(profileId, value) {
        expect(spinnerStopMock).not.toHaveBeenCalled();
        expect(value).toContain(oauthTokens.access);
        timeline.push(`store:${profileId}`);
      },
    });

    await expect(authenticateProvider('openai', {
      ctx: createContext('en'),
      store,
    })).resolves.toEqual({ profileId: 'openai:default' });

    expect(timeline).toEqual([
      'start:Opening the ChatGPT login page…',
      'log:If the browser does not open, visit: https://auth.openai.com/oauth/authorize?state=public-state',
      'message:Waiting for login in your browser… Terminal is still running · Ctrl+C to cancel',
      'message:Login response received…',
      'message:Login response received · checking tokens…',
      'message:Saving credentials securely…',
      'store:openai:default',
      'stop:ChatGPT login complete',
    ]);
    expect(JSON.stringify(timeline)).not.toContain(oauthTokens.access);
    expect(JSON.stringify(timeline)).not.toContain(oauthTokens.refresh);
  });

  it('ends the spinner as failed when browser authentication fails', async () => {
    loginWithBrowserMock.mockRejectedValue(new Error('provider unavailable'));

    await expect(authenticateProvider('openai', {
      ctx: createContext('en'),
      store: credentialStore(),
    })).rejects.toThrow('provider unavailable');

    expect(spinnerErrorMock).toHaveBeenCalledWith('Authentication failed');
    expect(spinnerStopMock).not.toHaveBeenCalled();
  });

  it('ends the spinner as failed when OAuth credential storage fails', async () => {
    const store = credentialStore({
      set() {
        throw new Error('keychain unavailable');
      },
    });

    await expect(authenticateProvider('openai', {
      ctx: createContext('en'),
      store,
    })).rejects.toThrow('keychain unavailable');

    expect(spinnerMessageMock).toHaveBeenCalledWith('Saving credentials securely…');
    expect(spinnerErrorMock).toHaveBeenCalledWith('Authentication failed');
    expect(spinnerStopMock).not.toHaveBeenCalled();
  });

  it('shows API-key storage progress without claiming provider validation', async () => {
    selectPromptMock.mockResolvedValue('apikey');
    let eventLoopAdvanced = false;
    setTimeout(() => {
      eventLoopAdvanced = true;
    }, 0);
    const store = credentialStore({
      set(profileId, value) {
        expect(value).toBe('api-key-secret');
        expect(spinnerStopMock).not.toHaveBeenCalled();
        expect(eventLoopAdvanced).toBe(true);
        timeline.push(`store:${profileId}`);
      },
    });

    await expect(authenticateProvider('openai', {
      ctx: createContext('en'),
      store,
    })).resolves.toEqual({ profileId: 'openai:default' });

    expect(timeline).toEqual([
      'start:API key received · saving securely…',
      'store:openai:default',
      'stop:API key saved',
    ]);
    expect(JSON.stringify(timeline)).not.toContain('api-key-secret');
    expect(JSON.stringify(timeline).toLowerCase()).not.toContain('valid');
  });

  it('returns from a cancelled OpenAI key prompt to the method selector', async () => {
    selectPromptMock
      .mockResolvedValueOnce('apikey')
      .mockResolvedValueOnce('oauth');
    passwordPromptMock.mockResolvedValueOnce(cancelValue);

    await expect(authenticateProvider('openai', {
      ctx: createContext('en'),
      store: credentialStore(),
    })).resolves.toEqual({ profileId: 'openai:default' });

    expect(selectPromptMock).toHaveBeenCalledTimes(2);
    expect(loginWithBrowserMock).toHaveBeenCalledTimes(1);
  });
});
