import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectScreenshots } from '../src/screenshots.js';

async function tmp<T>(fn: (d: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(join(tmpdir(), 'shots-'));
  try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); }
}

const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63680000000200015a4d57f50000000049454e44ae426082',
  'hex',
);

describe('collectScreenshots', () => {
  it('returns all-null array when source dir absent', async () => {
    await tmp(async (root) => {
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'X', outDir: join(root, 'out'), stepCount: 3,
      });
      expect(r.stepScreenshots).toEqual([null, null, null]);
      expect(r.copied).toBe(0);
    });
  });

  it('copies step-N.png files to outDir and reports relative URLs', async () => {
    await tmp(async (root) => {
      const src = join(root, '.doklo', 'screenshots', 'DOK');
      await mkdir(src, { recursive: true });
      await writeFile(join(src, 'step-1.png'), PNG_1x1);
      await writeFile(join(src, 'step-3.png'), PNG_1x1);
      const outDir = join(root, 'out');

      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK', outDir, stepCount: 4,
      });

      expect(r.copied).toBe(2);
      expect(r.stepScreenshots[0]).toBe('_assets/screenshots/DOK/step-1.png');
      expect(r.stepScreenshots[1]).toBeNull();
      expect(r.stepScreenshots[2]).toBe('_assets/screenshots/DOK/step-3.png');
      expect(r.stepScreenshots[3]).toBeNull();

      const copied = await readdir(join(outDir, '_assets', 'screenshots', 'DOK'));
      expect(copied.sort()).toEqual(['step-1.png', 'step-3.png']);
    });
  });

  it('ignores files with unsupported extension', async () => {
    await tmp(async (root) => {
      const src = join(root, '.doklo', 'screenshots', 'DOK2');
      await mkdir(src, { recursive: true });
      await writeFile(join(src, 'step-1.txt'), 'not an image');
      await writeFile(join(src, 'step-2.jpg'), PNG_1x1);
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK2', outDir: join(root, 'out'), stepCount: 2,
      });
      expect(r.copied).toBe(1);
      expect(r.stepScreenshots[1]).toBe('_assets/screenshots/DOK2/step-2.jpg');
    });
  });

  it('ignores step numbers outside [1..stepCount]', async () => {
    await tmp(async (root) => {
      const src = join(root, '.doklo', 'screenshots', 'DOK3');
      await mkdir(src, { recursive: true });
      await writeFile(join(src, 'step-9.png'), PNG_1x1);
      await writeFile(join(src, 'step-0.png'), PNG_1x1);
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK3', outDir: join(root, 'out'), stepCount: 2,
      });
      expect(r.copied).toBe(0);
      expect(r.stepScreenshots).toEqual([null, null]);
    });
  });

  it('discovers platform subdirs into stepScreenshotsByPlatform', async () => {
    await tmp(async (root) => {
      const base = join(root, '.doklo', 'screenshots', 'DOK-P');
      await mkdir(join(base, 'desktop'), { recursive: true });
      await mkdir(join(base, 'mobile'), { recursive: true });
      await writeFile(join(base, 'desktop', 'step-1.png'), PNG_1x1);
      await writeFile(join(base, 'desktop', 'step-2.png'), PNG_1x1);
      await writeFile(join(base, 'mobile', 'step-1.png'), PNG_1x1);
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-P', outDir: join(root, 'out'), stepCount: 2,
      });
      expect(Object.keys(r.stepScreenshotsByPlatform).sort()).toEqual(['desktop', 'mobile']);
      expect(r.stepScreenshotsByPlatform['desktop']).toEqual([
        '_assets/screenshots/DOK-P/desktop/step-1.png',
        '_assets/screenshots/DOK-P/desktop/step-2.png',
      ]);
      expect(r.stepScreenshotsByPlatform['mobile']).toEqual([
        '_assets/screenshots/DOK-P/mobile/step-1.png',
        null,
      ]);
      // no flat layer → default falls back to desktop
      expect(r.stepScreenshots[0]).toBe('_assets/screenshots/DOK-P/desktop/step-1.png');
      expect(r.copied).toBe(3);
    });
  });

  it('prefers the active-locale subdir over the flat layer', async () => {
    await tmp(async (root) => {
      const base = join(root, '.doklo', 'screenshots', 'DOK-L');
      await mkdir(join(base, 'ko'), { recursive: true });
      await writeFile(join(base, 'step-1.png'), PNG_1x1);     // flat
      await writeFile(join(base, 'ko', 'step-1.png'), PNG_1x1); // ko-specific
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-L', outDir: join(root, 'out'), stepCount: 1,
        locale: 'ko', supportedLocales: ['en', 'ko'],
      });
      expect(r.stepScreenshots[0]).toBe('_assets/screenshots/DOK-L/ko/step-1.png');
    });
  });

  it('reads annotations.json and exposes per-step regions for the default layer', async () => {
    await tmp(async (root) => {
      const base = join(root, '.doklo', 'screenshots', 'DOK-A');
      await mkdir(base, { recursive: true });
      await writeFile(join(base, 'step-1.png'), PNG_1x1);
      await writeFile(join(base, 'step-2.png'), PNG_1x1);
      await writeFile(
        join(base, 'annotations.json'),
        JSON.stringify({ regions: [{ step: 1, x: 10, y: 20, w: 30, h: 40 }] }),
      );
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-A', outDir: join(root, 'out'), stepCount: 2,
      });
      expect(r.stepAnnotations[0]).toEqual({ x: 10, y: 20, w: 30, h: 40 });
      expect(r.stepAnnotations[1]).toBeNull(); // no region for step 2
    });
  });

  it('propagates a non-missing annotations read error', async () => {
    await tmp(async (root) => {
      const base = join(root, '.doklo', 'screenshots', 'DOK-IO');
      await mkdir(join(base, 'annotations.json'), { recursive: true });
      await writeFile(join(base, 'step-1.png'), PNG_1x1);

      await expect(collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-IO', outDir: join(root, 'out'), stepCount: 1,
      })).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  it('reads platform-subdir annotations.json when default layer is that platform', async () => {
    await tmp(async (root) => {
      const d = join(root, '.doklo', 'screenshots', 'DOK-PA', 'desktop');
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'step-1.png'), PNG_1x1);
      await writeFile(join(d, 'annotations.json'), JSON.stringify({ regions: [{ step: 1, x: 5, y: 5, w: 9, h: 9 }] }));
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-PA', outDir: join(root, 'out'), stepCount: 1,
      });
      // no flat → default layer is desktop → its annotations apply
      expect(r.stepAnnotations[0]).toEqual({ x: 5, y: 5, w: 9, h: 9 });
    });
  });

  it('exposes per-platform annotations alongside per-platform screenshots', async () => {
    await tmp(async (root) => {
      const base = join(root, '.doklo', 'screenshots', 'DOK-PB');
      await mkdir(join(base, 'desktop'), { recursive: true });
      await mkdir(join(base, 'mobile'), { recursive: true });
      await writeFile(join(base, 'desktop', 'step-1.png'), PNG_1x1);
      await writeFile(join(base, 'desktop', 'step-2.png'), PNG_1x1);
      await writeFile(join(base, 'mobile', 'step-1.png'), PNG_1x1);
      await writeFile(
        join(base, 'desktop', 'annotations.json'),
        JSON.stringify({ regions: [{ step: 1, x: 10, y: 20, w: 30, h: 40 }] }),
      );
      await writeFile(
        join(base, 'mobile', 'annotations.json'),
        JSON.stringify({ regions: [{ step: 1, x: 1, y: 2, w: 3, h: 4 }] }),
      );
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-PB', outDir: join(root, 'out'), stepCount: 2,
      });
      expect(r.stepAnnotationsByPlatform['desktop']).toEqual([
        { x: 10, y: 20, w: 30, h: 40 },
        null, // step-2.png exists but has no region
      ]);
      expect(r.stepAnnotationsByPlatform['mobile']).toEqual([
        { x: 1, y: 2, w: 3, h: 4 },
        null, // no mobile step-2 shot at all
      ]);
    });
  });

  it('falls back to flat when active-locale subdir is absent', async () => {
    await tmp(async (root) => {
      const base = join(root, '.doklo', 'screenshots', 'DOK-L2');
      await mkdir(join(base, 'en'), { recursive: true });
      await writeFile(join(base, 'step-1.png'), PNG_1x1);
      await writeFile(join(base, 'en', 'step-1.png'), PNG_1x1);
      const r = await collectScreenshots({
        workspaceRoot: root, dokId: 'DOK-L2', outDir: join(root, 'out'), stepCount: 1,
        locale: 'ko', supportedLocales: ['en', 'ko'],
      });
      // ko absent → flat used (not en)
      expect(r.stepScreenshots[0]).toBe('_assets/screenshots/DOK-L2/step-1.png');
    });
  });
});
