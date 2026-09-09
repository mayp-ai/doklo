import { describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/lib/context.js';
import { runInitHandoff } from '../src/lib/init-handoff.js';

describe('runInitHandoff', () => {
  it('starts foreground Studio at onboarding for the recommended browser choice', async () => {
    const serve = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();
    const pickPort = vi.fn().mockResolvedValue({ port: 4321, fallback: false });

    const result = await runInitHandoff(
      { root: '/workspace', ctx: createContext('en') },
      { choose: async () => 'browser', serve, write, pickPort },
    );

    expect(result).toBe('browser');
    expect(pickPort).toHaveBeenCalledWith(4321);
    expect(serve).toHaveBeenCalledWith({
      root: '/workspace',
      port: 4321,
      open: true,
      openPath: '/onboarding',
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      'Opening http://localhost:4321/onboarding in your browser. Press Ctrl+C to stop web.',
    );
  });

  it('announces the fallback port and passes it to serve when 4321 is busy', async () => {
    const serve = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();
    const pickPort = vi.fn().mockResolvedValue({ port: 4322, fallback: true });

    const result = await runInitHandoff(
      { root: '/workspace', ctx: createContext('en') },
      { choose: async () => 'browser', serve, write, pickPort },
    );

    expect(result).toBe('browser');
    expect(serve).toHaveBeenCalledWith({
      root: '/workspace',
      port: 4322,
      open: true,
      openPath: '/onboarding',
    });
    // Notice first (explains the unusual URL), then a truthful opening line.
    expect(write).toHaveBeenNthCalledWith(
      1,
      'Port 4321 is in use — using 4322 instead.',
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      'Opening http://localhost:4322/onboarding in your browser. Press Ctrl+C to stop web.',
    );
  });

  it('localizes the fallback notice in Korean', async () => {
    const serve = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();
    const pickPort = vi.fn().mockResolvedValue({ port: 4322, fallback: true });

    await runInitHandoff(
      { root: '/workspace', ctx: createContext('ko') },
      { choose: async () => 'browser', serve, write, pickPort },
    );

    const notice = write.mock.calls[0]?.[0] as string;
    expect(notice).toContain('4321');
    expect(notice).toContain('4322');
    expect(notice).not.toContain('is in use'); // ko string, not the en one
  });

  it('prints recovery and keeps the workspace when no port can be picked', async () => {
    const serve = vi.fn();
    const write = vi.fn();
    const pickPort = vi
      .fn()
      .mockRejectedValue(new Error('Ports 4321-4330 are all in use.'));

    const result = await runInitHandoff(
      { root: '/workspace', ctx: createContext('en') },
      { choose: async () => 'browser', serve, write, pickPort },
    );

    expect(result).toBe('browser-unavailable');
    expect(serve).not.toHaveBeenCalled();
    expect(write).toHaveBeenNthCalledWith(
      1,
      'web could not start: Ports 4321-4330 are all in use.',
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      'Your initialized workspace is preserved at /workspace. Retry with `doklo serve --open`.',
    );
  });

  it('returns terminal without starting Studio', async () => {
    const serve = vi.fn();
    const write = vi.fn();

    const result = await runInitHandoff(
      { root: '/workspace', ctx: createContext('en') },
      { choose: async () => 'terminal', serve, write },
    );

    expect(result).toBe('terminal');
    expect(serve).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('Next: `doklo generate`, then `doklo show`');
  });

  it('preserves the initialized workspace and prints recovery when Studio cannot start', async () => {
    const serve = vi.fn().mockRejectedValue(new Error('Studio bundle missing'));
    const write = vi.fn();
    const pickPort = vi.fn().mockResolvedValue({ port: 4321, fallback: false });

    const result = await runInitHandoff(
      { root: '/workspace', ctx: createContext('en') },
      { choose: async () => 'browser', serve, write, pickPort },
    );

    expect(result).toBe('browser-unavailable');
    expect(write).toHaveBeenNthCalledWith(
      2,
      'web could not start: Studio bundle missing',
    );
    expect(write).toHaveBeenNthCalledWith(
      3,
      'Your initialized workspace is preserved at /workspace. Retry with `doklo serve --open`.',
    );
  });

  it('returns cancelled without writing or starting Studio', async () => {
    const serve = vi.fn();
    const write = vi.fn();

    const result = await runInitHandoff(
      { root: '/workspace', ctx: createContext('en') },
      { choose: async () => Symbol('cancel'), serve, write },
    );

    expect(result).toBe('cancelled');
    expect(write).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });
});
