import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/scanner.js';

describe('scanProject path containment', () => {
  it('rejects a discovered source file whose symlink target is outside the scan root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-adapter-outside-'));
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(
      join(outside, 'page.tsx'),
      "export const AUTH_ROLES = ['admin', 'outsider'] as const;\n",
      'utf-8',
    );
    await symlink(join(outside, 'page.tsx'), join(root, 'app', 'page.tsx'));

    await expect(scanProject(root)).rejects.toThrow(/outside|contain|symlink/i);
  });

  it.each(['ext', 'dist'])(
    'rejects an external %s directory symlink before an import resolver can follow it',
    async (directory) => {
      const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
      const outside = await mkdtemp(join(tmpdir(), 'doklo-adapter-outside-'));
      await mkdir(join(root, 'app'), { recursive: true });
      await writeFile(
        join(root, 'app', 'page.tsx'),
        `import { secret } from '../${directory}/secret'; export default () => secret;\n`,
        'utf-8',
      );
      await writeFile(join(outside, 'secret.ts'), 'export const secret = 42;\n', 'utf-8');
      await symlink(outside, join(root, directory));

      await expect(scanProject(root)).rejects.toThrow(/outside|contain|symlink/i);
    },
  );

  it.each([
    'node_modules',
    '.next',
    'dist',
    '.git',
    '.claude',
    '.codex',
    '.agents',
    '.worktrees',
  ])(
    'does not enumerate a nested ignored %s tree',
    async (directory) => {
      const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
      await mkdir(join(root, 'packages', 'web'), { recursive: true });
      await mkdir(join(root, 'packages', 'web', directory), { recursive: true });
      await writeFile(
        join(root, 'packages', 'web', 'page.tsx'),
        'export default () => null;\n',
        'utf-8',
      );
      await writeFile(
        join(root, 'packages', 'web', directory, 'generated.ts'),
        'export const generated = true;\n',
        'utf-8',
      );

      await expect(scanProject(root)).resolves.toMatchObject({
        files: ['packages/web/page.tsx'],
      });
    },
  );

  it('does not enumerate a nested external node_modules link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-adapter-outside-'));
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'web', 'page.tsx'),
      'export default () => null;\n',
      'utf-8',
    );
    await writeFile(join(outside, 'dependency.ts'), 'export const dependency = true;\n', 'utf-8');
    await symlink(outside, join(root, 'packages', 'web', 'node_modules'));

    await expect(scanProject(root)).resolves.toMatchObject({
      files: ['packages/web/page.tsx'],
    });
  });

  it('excludes only root out and public trees from parser candidates and summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
    for (const directory of ['app', 'out', 'public', 'src/out', 'src/public']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, 'app/page.tsx'), 'export default () => null;\n', 'utf-8');
    await writeFile(join(root, 'out/generated.js'), 'broken output )\n', 'utf-8');
    await writeFile(join(root, 'public/vendor.js'), 'broken vendor )\n', 'utf-8');
    await writeFile(join(root, 'src/out/source.ts'), 'export const sourceOut = true;\n', 'utf-8');
    await writeFile(join(root, 'src/public/source.ts'), 'export const sourcePublic = true;\n', 'utf-8');

    const scan = await scanProject(root);

    expect(scan.files).toEqual([
      'app/page.tsx',
      'src/out/source.ts',
      'src/public/source.ts',
    ]);
    expect(scan.candidates.map((candidate) => candidate.file)).toEqual(scan.files);
    expect(scan.summary).toMatchObject({ matched: 3, excluded: 0 });
  });

  it('rejects an external link nested inside an ignored build directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'doklo-adapter-outside-'));
    await mkdir(join(root, 'app'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(
      join(root, 'app', 'page.tsx'),
      "import { secret } from '../dist/generated/secret'; export default () => secret;\n",
      'utf-8',
    );
    await writeFile(join(outside, 'secret.ts'), 'export const secret = 42;\n', 'utf-8');
    await symlink(outside, join(root, 'dist', 'generated'));

    await expect(scanProject(root)).rejects.toThrow(/outside|contain|symlink/i);
  });

  it('allows a source symlink whose physical target stays inside the scan root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-adapter-root-'));
    await mkdir(join(root, 'app'), { recursive: true });
    await mkdir(join(root, 'shared'), { recursive: true });
    await writeFile(join(root, 'shared', 'page.tsx'), 'export default () => null;\n', 'utf-8');
    await symlink(join(root, 'shared', 'page.tsx'), join(root, 'app', 'page.tsx'));

    await expect(scanProject(root)).resolves.toMatchObject({
      files: ['app/page.tsx', 'shared/page.tsx'],
    });
  });
});
