import { describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRenderOutputs, resolveOutputDestination } from '../src/output-plan.js';

async function withTmp<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'livedoc-output-plan-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('planRenderOutputs', () => {
  it('plans every text, binary, screenshot, and manifest artifact in canonical order', async () => {
    await withTmp(async (root) => {
      const plan = await planRenderOutputs({
        outputRoot: root,
        outputDir: 'help-page',
        overwrite: false,
        targets: [
          { relativePath: 'manual.pptx', format: 'pptx', dokId: 'AUTH' },
          { relativePath: 'account-recovery.html', format: 'html', dokId: 'AUTH' },
        ],
        screenshots: [
          { relativePath: 'assets/account-recovery/step-1.png', dokId: 'AUTH' },
        ],
        inputs: {
          template_ref: 'help-page',
          template_source: 'builtin',
          template_path: '/templates/help-page',
          dok_ids: ['AUTH'],
          source_paths: ['/workspace/doks/AUTH.json'],
        },
        warnings: [{ code: 'MISSING_IA', message: 'No IA is available yet' }],
      });

      expect(plan.outputs.map(({ relative_path, format, dok_id, action }) => ({
        relative_path,
        format,
        dok_id,
        action,
      }))).toEqual([
        {
          relative_path: 'help-page/account-recovery.html',
          format: 'html',
          dok_id: 'AUTH',
          action: 'create',
        },
        {
          relative_path: 'help-page/assets/account-recovery/step-1.png',
          format: 'screenshot',
          dok_id: 'AUTH',
          action: 'create',
        },
        {
          relative_path: 'help-page/livedoc-manifest.json',
          format: 'manifest',
          dok_id: undefined,
          action: 'create',
        },
        {
          relative_path: 'help-page/manual.pptx',
          format: 'pptx',
          dok_id: 'AUTH',
          action: 'create',
        },
      ]);
      const canonicalRoot = await realpath(root);
      expect(plan.output_root).toBe(canonicalRoot);
      expect(plan.manifest_path).toBe(join(canonicalRoot, 'help-page', 'livedoc-manifest.json'));
      expect(plan.inputs).toEqual({
        template_ref: 'help-page',
        template_source: 'builtin',
        template_path: '/templates/help-page',
        dok_ids: ['AUTH'],
        source_paths: ['/workspace/doks/AUTH.json'],
      });
      expect(plan.warnings).toEqual([
        { code: 'MISSING_IA', message: 'No IA is available yet' },
      ]);
    });
  });

  it('marks existing outputs blocked unless overwrite is explicit', async () => {
    await withTmp(async (root) => {
      await mkdir(join(root, 'help-page'));
      await writeFile(join(root, 'help-page', 'account-recovery.html'), 'original');

      const blocked = await planRenderOutputs({
        outputRoot: root,
        outputDir: 'help-page',
        overwrite: false,
        targets: [{ relativePath: 'account-recovery.html', format: 'html' }],
        screenshots: [],
      });
      const overwrite = await planRenderOutputs({
        outputRoot: root,
        outputDir: 'help-page',
        overwrite: true,
        targets: [{ relativePath: 'account-recovery.html', format: 'html' }],
        screenshots: [],
      });

      expect(blocked.outputs.find((output) => output.format === 'html')).toMatchObject({
        exists: true,
        action: 'blocked',
      });
      expect(overwrite.outputs.find((output) => output.format === 'html')).toMatchObject({
        exists: true,
        action: 'overwrite',
      });
      expect(await readFile(join(root, 'help-page', 'account-recovery.html'), 'utf8')).toBe('original');
    });
  });

  it('returns canonical-identical plans and never changes the filesystem', async () => {
    await withTmp(async (root) => {
      const input = {
        outputRoot: root,
        outputDir: 'nested/new-output',
        overwrite: false,
        targets: [
          { relativePath: 'b.md', format: 'markdown', dokId: 'BILL' },
          { relativePath: 'a.html', format: 'html', dokId: 'AUTH' },
        ],
        screenshots: [],
        inputs: {
          dok_ids: ['BILL', 'AUTH', 'AUTH'],
          source_paths: ['/z.json', '/a.json', '/a.json'],
        },
        warnings: [
          { code: 'Z_WARNING', message: 'z' },
          { code: 'A_WARNING', message: 'a' },
        ],
      };

      const before = await readdir(root);
      const first = await planRenderOutputs(input);
      const second = await planRenderOutputs(input);

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.inputs.dok_ids).toEqual(['AUTH', 'BILL']);
      expect(first.inputs.source_paths).toEqual(['/a.json', '/z.json']);
      expect(first.warnings.map((warning) => warning.code)).toEqual(['A_WARNING', 'Z_WARNING']);
      expect(await readdir(root)).toEqual(before);
    });
  });

  it('fails when two producers claim the same output path', async () => {
    await withTmp(async (root) => {
      await expect(planRenderOutputs({
        outputRoot: root,
        outputDir: 'help-page',
        overwrite: false,
        targets: [
          { relativePath: 'same.html', format: 'html' },
          { relativePath: 'same.html', format: 'text' },
        ],
        screenshots: [],
      })).rejects.toMatchObject({ code: 'DUPLICATE_OUTPUT' });
    });
  });

  it('rejects case-only aliases claimed by two producers', async () => {
    await withTmp(async (root) => {
      await expect(planRenderOutputs({
        outputRoot: root,
        outputDir: '',
        overwrite: false,
        targets: [
          { relativePath: 'A.md', format: 'markdown' },
          { relativePath: 'a.md', format: 'markdown' },
        ],
        screenshots: [],
      })).rejects.toMatchObject({ code: 'DUPLICATE_OUTPUT' });
    });
  });

  it('rejects a case-only alias of the generated manifest path', async () => {
    await withTmp(async (root) => {
      await expect(planRenderOutputs({
        outputRoot: root,
        outputDir: '',
        overwrite: false,
        targets: [
          { relativePath: 'LIVEDOC-MANIFEST.JSON', format: 'json' },
        ],
        screenshots: [],
      })).rejects.toMatchObject({ code: 'DUPLICATE_OUTPUT' });
    });
  });

  it('rejects traversal outside the output root', async () => {
    await withTmp(async (root) => {
      await expect(planRenderOutputs({
        outputRoot: root,
        outputDir: 'help-page',
        overwrite: false,
        targets: [{ relativePath: '../../outside.html', format: 'html' }],
        screenshots: [],
      })).rejects.toThrow();
    });
  });

  it('rejects symlinked output parents and leaves the external target unchanged', async () => {
    await withTmp(async (root) => {
      const external = join(root, 'external');
      await mkdir(external);
      await writeFile(join(external, 'help.html'), 'original');
      await symlink(external, join(root, 'linked'));

      await expect(planRenderOutputs({
        outputRoot: root,
        outputDir: 'linked',
        overwrite: true,
        targets: [{ relativePath: 'help.html', format: 'html' }],
        screenshots: [],
      })).rejects.toThrow();

      expect(await readFile(join(external, 'help.html'), 'utf8')).toBe('original');
    });
  });

  it('rejects a symlinked output leaf even when overwrite is enabled', async () => {
    await withTmp(async (root) => {
      const output = join(root, 'help-page');
      const external = join(root, 'external.html');
      await mkdir(output);
      await writeFile(external, 'original');
      await symlink(external, join(output, 'help.html'));

      await expect(planRenderOutputs({
        outputRoot: root,
        outputDir: 'help-page',
        overwrite: true,
        targets: [{ relativePath: 'help.html', format: 'html' }],
        screenshots: [],
      })).rejects.toThrow();

      expect(await readFile(external, 'utf8')).toBe('original');
    });
  });

  it('rejects an existing non-directory ancestor of the requested output directory', async () => {
    await withTmp(async (root) => {
      const fileAncestor = join(root, 'not-a-directory');
      await writeFile(fileAncestor, 'file');

      await expect(resolveOutputDestination(join(fileAncestor, 'nested'))).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      expect(await readFile(fileAncestor, 'utf8')).toBe('file');
    });
  });
});
