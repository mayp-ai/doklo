import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic } from '@doklo-beta/core';
import { parseCaptureConfig } from '../src/config.js';
import {
  runCapture,
  type CaptureRunDependencies,
} from '../src/orchestrator.js';

type FailureStage = 'navigation' | 'action' | 'screenshot';

function config(options: {
  platforms?: Record<string, { width: number; height: number }>;
  actions?: Array<{ type: 'click'; selector: string }>;
  steps?: number;
} = {}) {
  return parseCaptureConfig({
    base_url: 'http://localhost:3000',
    doks: {
      'DOK': {
        ...(options.platforms ? { platforms: options.platforms } : {}),
        steps: Array.from({ length: options.steps ?? 1 }, (_, index) => ({
          step: index + 1,
          url: `/capture-${index + 1}`,
          actions: options.actions ?? [],
          annotate: '#submit',
        })),
      },
    },
  });
}

function fakeDependencies(options: {
  failure?: FailureStage;
  writeAtomic?: CaptureRunDependencies['writeAtomic'];
  beforeWrite?: (index: number) => Promise<void>;
} = {}) {
  const state = { launches: 0, contextClosed: 0, browserClosed: 0 };
  let screenshotCalls = 0;
  const page = {
    setViewportSize: async () => undefined,
    goto: async () => {
      if (options.failure === 'navigation') throw new Error('navigation failed');
    },
    click: async () => {
      if (options.failure === 'action') throw new Error('action failed');
    },
    fill: async () => undefined,
    selectOption: async () => undefined,
    locator: () => ({
      first: () => ({
        boundingBox: async () => ({ x: 10, y: 20, width: 30, height: 40 }),
      }),
      press: async () => undefined,
    }),
    hover: async () => undefined,
    waitForTimeout: async () => undefined,
    waitForSelector: async () => undefined,
    evaluate: async () => undefined,
    context: () => ({ addCookies: async () => undefined }),
    $: async () => null,
    screenshot: async (screenshotOptions: Record<string, unknown>) => {
      expect(screenshotOptions).not.toHaveProperty('path');
      screenshotCalls += 1;
      if (options.failure === 'screenshot' && screenshotCalls === 2) {
        throw new Error('screenshot failed');
      }
      return Buffer.from('real screenshot bytes');
    },
  };
  const dependencies: CaptureRunDependencies = {
    launchBrowser: async () => {
      state.launches += 1;
      return {
        newContext: async () => ({
          newPage: async () => page,
          close: async () => { state.contextClosed += 1; },
        }),
        close: async () => { state.browserClosed += 1; },
      };
    },
    ...(options.writeAtomic ? { writeAtomic: options.writeAtomic } : {}),
    ...(options.beforeWrite ? {
      transactionHooks: { beforeWrite: options.beforeWrite },
    } : {}),
  };
  return { dependencies, state };
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'doklo-capture-safety-'));
}

async function snapshotTree(rootPath: string, current = rootPath): Promise<unknown[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const snapshot: unknown[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    const relativePath = relative(rootPath, path);
    const metadata = await lstat(path);
    if (entry.isDirectory()) {
      snapshot.push({ path: relativePath, type: 'directory', mode: metadata.mode & 0o777 });
      snapshot.push(...await snapshotTree(rootPath, path));
    } else if (entry.isSymbolicLink()) {
      snapshot.push({ path: relativePath, type: 'symlink', mode: metadata.mode & 0o777 });
    } else {
      snapshot.push({
        path: relativePath,
        type: 'file',
        mode: metadata.mode & 0o777,
        bytes: (await readFile(path)).toString('base64'),
      });
    }
  }
  return snapshot;
}

describe('runCapture input and output safety', () => {
  it('fails closed before a path writer can swap the parent at the final call boundary', async () => {
    const workspaceRoot = await root();
    const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
    const parkedDir = join(workspaceRoot, '.doklo', 'screenshots', 'parked');
    const external = await root();
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(external, 'step-1.png'), 'external screenshot');
    await writeFile(join(external, 'annotations.json'), 'external annotations');
    const externalBefore = await snapshotTree(external);
    let writes = 0;
    const { dependencies, state } = fakeDependencies({
      writeAtomic: async (destination, bytes, options) => {
        writes += 1;
        if (writes === 1) {
          await rename(outputDir, parkedDir);
          await symlink(external, outputDir);
        }
        await writeFileAtomic(destination, bytes, options);
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config(),
      dokId: 'DOK',
      overwrite: true,
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(writes).toBe(0);
    expect(state.launches).toBe(0);
    expect(await snapshotTree(external)).toEqual(externalBefore);
  });

  it.each(['../outside', '/tmp/outside', 'AUTH\\001', 'AUTH/001', 'AUTH\0-001'])
    ('rejects unsafe Dok input %j before launch or filesystem mutation', async (dokId) => {
      const workspaceRoot = await root();
      const { dependencies, state } = fakeDependencies();

      await expect(runCapture({
        workspaceRoot,
        config: config(),
        dokId,
      }, dependencies)).rejects.toThrow();

      expect(state.launches).toBe(0);
      await expect(access(join(workspaceRoot, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it.each([
    'screenshots parent',
    'Dok directory',
    'platform directory',
    'screenshot leaf',
    'annotations leaf',
  ])('rejects a symlinked %s without changing the external target', async (location) => {
    const workspaceRoot = await root();
    const external = await root();
    const externalFile = join(external, 'sentinel');
    await writeFile(externalFile, 'external original');
    await chmod(externalFile, 0o640);
    const modeBefore = (await stat(externalFile)).mode & 0o777;
    const platform = location === 'platform directory';
    const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
    const leafDir = platform ? join(outputDir, 'mobile') : outputDir;

    await mkdir(join(workspaceRoot, '.doklo'), { recursive: true });
    if (location === 'screenshots parent') {
      await symlink(external, join(workspaceRoot, '.doklo', 'screenshots'));
    } else {
      await mkdir(join(workspaceRoot, '.doklo', 'screenshots'), { recursive: true });
      if (location === 'Dok directory') {
        await symlink(external, outputDir);
      } else {
        await mkdir(outputDir, { recursive: true });
        if (location === 'platform directory') {
          await symlink(external, leafDir);
        } else if (location === 'screenshot leaf') {
          await symlink(externalFile, join(leafDir, 'step-1.png'));
        } else {
          await symlink(externalFile, join(leafDir, 'annotations.json'));
        }
      }
    }

    const { dependencies, state } = fakeDependencies();
    await expect(runCapture({
      workspaceRoot,
      config: config(platform ? { platforms: { mobile: { width: 390, height: 844 } } } : {}),
      dokId: 'DOK',
      overwrite: true,
    }, dependencies)).rejects.toThrow();

    expect(state.launches).toBe(0);
    expect(await readFile(externalFile, 'utf8')).toBe('external original');
    expect((await stat(externalFile)).mode & 0o777).toBe(modeBefore);
  });

  it.each(['step-1.png', 'annotations.json'])
    ('keeps publication unavailable with existing %s and launches nothing', async (leaf) => {
      const workspaceRoot = await root();
      const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, leaf), 'existing');
      const { dependencies, state } = fakeDependencies();

      await expect(runCapture({
        workspaceRoot,
        config: config(),
        dokId: 'DOK',
      }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

      expect(state.launches).toBe(0);
      expect(await readFile(join(outputDir, leaf), 'utf8')).toBe('existing');
    });

  it('does not publish even with overwrite consent while path-pinned writes are unavailable', async () => {
    const workspaceRoot = await root();
    const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'step-1.png'), 'old screenshot');
    await writeFile(join(outputDir, 'annotations.json'), 'old annotations');
    const before = await snapshotTree(workspaceRoot);
    const { dependencies, state } = fakeDependencies();

    await expect(runCapture({
      workspaceRoot,
      config: config(),
      dokId: 'DOK',
      overwrite: true,
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(await snapshotTree(workspaceRoot)).toEqual(before);
    expect(state).toEqual({ launches: 0, contextClosed: 0, browserClosed: 0 });
  });

  it.each<FailureStage>(['navigation', 'action', 'screenshot'])
    ('never reaches a requested %s failure and leaves the workspace unchanged', async (failure) => {
      const workspaceRoot = await root();
      const before = await snapshotTree(workspaceRoot);
      const { dependencies, state } = fakeDependencies({ failure });

      await expect(runCapture({
        workspaceRoot,
        config: config(
          failure === 'action'
            ? { actions: [{ type: 'click', selector: '#go' }] }
            : failure === 'screenshot'
              ? { steps: 2 }
              : {},
        ),
        dokId: 'DOK',
      }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

      const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
      await expect(access(join(outputDir, 'step-1.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(outputDir, 'step-2.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(outputDir, 'annotations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await snapshotTree(workspaceRoot)).toEqual(before);
      expect(state).toEqual({ launches: 0, contextClosed: 0, browserClosed: 0 });
    });

  it('does not corrupt existing files or report success when atomic publishing fails', async () => {
    const workspaceRoot = await root();
    const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
    await mkdir(outputDir, { recursive: true });
    const existing = join(outputDir, 'step-1.png');
    await writeFile(existing, 'old screenshot');
    await chmod(existing, 0o640);
    const modeBefore = (await stat(existing)).mode & 0o777;
    const writeFailure = new Error('atomic write failed');
    let writes = 0;
    const { dependencies, state } = fakeDependencies({
      writeAtomic: async () => {
        writes += 1;
        throw writeFailure;
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config(),
      dokId: 'DOK',
      overwrite: true,
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(writes).toBe(0);
    expect(await readFile(existing, 'utf8')).toBe('old screenshot');
    expect((await stat(existing)).mode & 0o777).toBe(modeBefore);
    expect(state).toEqual({ launches: 0, contextClosed: 0, browserClosed: 0 });
  });

  it('does not enter a no-overwrite race while publication is unavailable', async () => {
    const workspaceRoot = await root();
    const collision = new Error('created concurrently') as NodeJS.ErrnoException;
    collision.code = 'EEXIST';
    let writes = 0;
    const { dependencies } = fakeDependencies({
      writeAtomic: async () => {
        writes += 1;
        throw collision;
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config(),
      dokId: 'DOK',
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });
    expect(writes).toBe(0);
  });

  it('does not expose a parent-swap hook or touch its external target', async () => {
    const workspaceRoot = await root();
    const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
    const parkedDir = join(workspaceRoot, '.doklo', 'screenshots', 'parked');
    const external = await root();
    await mkdir(outputDir, { recursive: true });
    const externalStep = join(external, 'step-1.png');
    const externalAnnotations = join(external, 'annotations.json');
    await writeFile(externalStep, 'external screenshot');
    await writeFile(externalAnnotations, 'external annotations');
    await chmod(externalStep, 0o640);
    await chmod(externalAnnotations, 0o600);
    const externalBefore = await snapshotTree(external);
    let swaps = 0;
    const { dependencies } = fakeDependencies({
      beforeWrite: async (index) => {
        if (index !== 0) return;
        swaps += 1;
        await rename(outputDir, parkedDir);
        await symlink(external, outputDir);
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config(),
      dokId: 'DOK',
      overwrite: true,
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(swaps).toBe(0);
    expect(await snapshotTree(external)).toEqual(externalBefore);
  });

  it('does not enter an Nth-write path or create outputs and directories', async () => {
    const workspaceRoot = await root();
    const before = await snapshotTree(workspaceRoot);
    let writes = 0;
    const failure = new Error('second write failed');
    const { dependencies } = fakeDependencies({
      writeAtomic: async (destination, bytes, options) => {
        writes += 1;
        if (writes === 2) throw failure;
        await writeFileAtomic(destination, bytes, options);
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config({ steps: 2 }),
      dokId: 'DOK',
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(writes).toBe(0);
    expect(await snapshotTree(workspaceRoot)).toEqual(before);
  });

  it('does not enter an overwrite path, preserving existing bytes and modes', async () => {
    const workspaceRoot = await root();
    const outputDir = join(workspaceRoot, '.doklo', 'screenshots', 'DOK');
    await mkdir(outputDir, { recursive: true });
    for (const [index, leaf] of ['step-1.png', 'step-2.png', 'annotations.json'].entries()) {
      const path = join(outputDir, leaf);
      await writeFile(path, `original-${leaf}`);
      await chmod(path, 0o600 + index * 0o20);
    }
    const before = await snapshotTree(workspaceRoot);
    let writes = 0;
    const failure = new Error('second overwrite failed');
    const { dependencies } = fakeDependencies({
      writeAtomic: async (destination, bytes, options) => {
        writes += 1;
        if (writes === 2) throw failure;
        await writeFileAtomic(destination, bytes, options);
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config({ steps: 2 }),
      dokId: 'DOK',
      overwrite: true,
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(writes).toBe(0);
    expect(await snapshotTree(workspaceRoot)).toEqual(before);
  });

  it('does not enter a concurrent collision path or partially publish', async () => {
    const workspaceRoot = await root();
    const before = await snapshotTree(workspaceRoot);
    let writes = 0;
    const { dependencies } = fakeDependencies({
      writeAtomic: async (destination, bytes, options) => {
        writes += 1;
        if (writes === 2) await writeFile(destination, 'concurrent owner', { flag: 'wx' });
        await writeFileAtomic(destination, bytes, options);
      },
    });

    await expect(runCapture({
      workspaceRoot,
      config: config({ steps: 2 }),
      dokId: 'DOK',
    }, dependencies)).rejects.toMatchObject({ code: 'CAPTURE_PUBLICATION_UNAVAILABLE' });

    expect(writes).toBe(0);
    expect(await snapshotTree(workspaceRoot)).toEqual(before);
  });
});
