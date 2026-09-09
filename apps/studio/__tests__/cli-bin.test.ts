import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStudioCliBin, StudioCliBinNotFoundError } from '../lib/cli-bin';

describe('resolveStudioCliBin', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('accepts an existing absolute DOKLO_CLI_BIN override', async () => {
    vi.stubEnv('DOKLO_CLI_BIN', '/release/apps/cli/dist/index.js');
    await expect(resolveStudioCliBin({ exists: async (path) => path === '/release/apps/cli/dist/index.js' }))
      .resolves.toBe('/release/apps/cli/dist/index.js');
  });

  it('finds the traced CLI next to Studio in the standalone layout', async () => {
    vi.stubEnv('DOKLO_CLI_BIN', '');
    await expect(resolveStudioCliBin({
      cwd: '/release/apps/studio',
      exists: async (path) => path === '/release/apps/cli/dist/index.js',
    })).resolves.toBe('/release/apps/cli/dist/index.js');
  });

  it('fails before spawning when no candidate exists', async () => {
    vi.stubEnv('DOKLO_CLI_BIN', '');
    await expect(resolveStudioCliBin({ cwd: '/release/apps/studio', exists: async () => false }))
      .rejects.toBeInstanceOf(StudioCliBinNotFoundError);
  });
});
