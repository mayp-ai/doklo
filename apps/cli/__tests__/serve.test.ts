import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  studioNextBin,
  studioOpenUrl,
  resolveStudio,
  resolveCliEntry,
  studioServeEnv,
  StudioNotFoundError,
} from '../src/commands/serve.js';

describe('studioOpenUrl', () => {
  it('defaults to the real workspace Hub', () => {
    expect(studioOpenUrl(4321)).toBe('http://localhost:4321/doks');
  });

  it('honors an explicit openPath', () => {
    expect(studioOpenUrl(4321, '/consolidation')).toBe(
      'http://localhost:4321/consolidation',
    );
  });
});

describe('studioNextBin', () => {
  it('resolves the local next binary on POSIX platforms', () => {
    expect(studioNextBin('/repo/apps/studio', 'darwin')).toBe('/repo/apps/studio/node_modules/.bin/next');
  });

  it('resolves the local next command on Windows', () => {
    expect(studioNextBin('C:\\repo\\apps\\studio', 'win32')).toContain('next.cmd');
  });
});

describe('resolveStudio', () => {
  const tmpDirs: string[] = [];

  async function makeTmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-serve-'));
    tmpDirs.push(dir);
    return dir;
  }

  /** Create an empty file (and its parent dirs). */
  async function touch(file: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '');
  }

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  it('picks the packaged standalone build (monorepo trace layout: <root>/studio/apps/studio/server.js)', async () => {
    const tmp = await makeTmp();
    // here mimics <packageRoot>/dist/commands/serve.js — so <packageRoot>/studio
    // is resolve(here, '..', '..', 'studio').
    const here = join(tmp, 'pkg', 'dist', 'commands');
    const serverJs = join(tmp, 'pkg', 'studio', 'apps', 'studio', 'server.js');
    await touch(serverJs);

    const res = await resolveStudio({
      here,
      devStudioDir: join(tmp, 'no-such', 'studio'),
    });
    expect(res).toEqual({ mode: 'standalone', serverJs });
  });

  it('picks the packaged standalone build (flat layout + single-file dist/index.js: <root>/studio/server.js)', async () => {
    const tmp = await makeTmp();
    // here mimics <packageRoot>/dist/index.js — so <packageRoot>/studio is
    // resolve(here, '..', 'studio'). No nested apps/studio/server.js, so the
    // resolver falls to the flat server.js in the same root.
    const here = join(tmp, 'pkg', 'dist');
    const serverJs = join(tmp, 'pkg', 'studio', 'server.js');
    await touch(serverJs);

    const res = await resolveStudio({
      here,
      devStudioDir: join(tmp, 'no-such', 'studio'),
    });
    expect(res).toEqual({ mode: 'standalone', serverJs });
  });

  it('falls back to monorepo dev mode when a next binary is present and no standalone build exists', async () => {
    const tmp = await makeTmp();
    const here = join(tmp, 'pkg', 'dist', 'commands'); // no studio/ siblings created
    const devStudioDir = join(tmp, 'repo', 'apps', 'studio');
    await touch(studioNextBin(devStudioDir, 'darwin')); // .../node_modules/.bin/next

    const res = await resolveStudio({ here, devStudioDir, platform: 'darwin' });
    expect(res).toEqual({ mode: 'dev', studioDir: devStudioDir });
  });

  it('prefers the packaged standalone build over dev mode when both exist', async () => {
    const tmp = await makeTmp();
    const here = join(tmp, 'pkg', 'dist', 'commands');
    const serverJs = join(tmp, 'pkg', 'studio', 'apps', 'studio', 'server.js');
    await touch(serverJs);
    const devStudioDir = join(tmp, 'repo', 'apps', 'studio');
    await touch(studioNextBin(devStudioDir, 'darwin'));

    const res = await resolveStudio({ here, devStudioDir, platform: 'darwin' });
    expect(res).toEqual({ mode: 'standalone', serverJs });
  });

  it('throws StudioNotFoundError listing every searched path when neither exists', async () => {
    const tmp = await makeTmp();
    const here = join(tmp, 'pkg', 'dist', 'commands');
    const devStudioDir = join(tmp, 'repo', 'apps', 'studio'); // not created

    let caught: unknown;
    try {
      await resolveStudio({ here, devStudioDir, platform: 'darwin' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StudioNotFoundError);
    const err = caught as StudioNotFoundError;
    // every standalone candidate is enumerated...
    expect(err.searched).toContain(join(tmp, 'pkg', 'studio', 'apps', 'studio', 'server.js'));
    expect(err.searched).toContain(join(tmp, 'pkg', 'studio', 'server.js'));
    // ...as are the dev-mode paths.
    expect(err.searched).toContain(devStudioDir);
    expect(err.searched).toContain(studioNextBin(devStudioDir, 'darwin'));
    // and the message surfaces them for the user.
    expect(err.message).toContain('Searched:');
    expect(err.message).toContain(devStudioDir);
  });

  it('errors when the dev studio dir exists but its next binary is missing', async () => {
    const tmp = await makeTmp();
    const here = join(tmp, 'pkg', 'dist', 'commands');
    const devStudioDir = join(tmp, 'repo', 'apps', 'studio');
    await mkdir(devStudioDir, { recursive: true }); // dir present, but no next bin

    await expect(
      resolveStudio({ here, devStudioDir, platform: 'darwin' }),
    ).rejects.toBeInstanceOf(StudioNotFoundError);
  });
});

describe('resolveCliEntry', () => {
  it('finds and returns an absolute CLI entry beside the compiled serve command', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'doklo-cli-entry-'));
    const entry = join(tmp, 'dist', 'index.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, '');
    await expect(resolveCliEntry({ here: join(tmp, 'dist', 'commands') })).resolves.toBe(entry);
    await rm(tmp, { recursive: true, force: true });
  });

  it('uses the built entry when serve is running from TypeScript dev source', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'doklo-cli-dev-entry-'));
    const entry = join(tmp, 'dist', 'index.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, '');
    await expect(resolveCliEntry({ here: join(tmp, 'src', 'commands') })).resolves.toBe(entry);
    await rm(tmp, { recursive: true, force: true });
  });

  it('uses dist/index.js when the esbuild release command lives directly in dist', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'doklo-cli-release-entry-'));
    const entry = join(tmp, 'dist', 'index.js');
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, '');
    await expect(resolveCliEntry({ here: join(tmp, 'dist') })).resolves.toBe(entry);
    await rm(tmp, { recursive: true, force: true });
  });
});

describe('studioServeEnv', () => {
  it.each(['standalone', 'dev'] as const)('passes the verified absolute CLI entry in %s mode', (mode) => {
    const env = studioServeEnv({
      mode,
      baseEnv: { PATH: '/bin' },
      workspaceRoot: '/workspace',
      cliBin: '/release/dist/index.js',
      port: 4321,
    });
    expect(env.DOKLO_CLI_BIN).toBe('/release/dist/index.js');
    expect(env.DOKLO_WORKSPACE_ROOT).toBe('/workspace');
  });
});
