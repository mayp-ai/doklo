import { execFile } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { readSourceRepository } from '../lib/source-repository';
import { githubSourceUrl } from '../lib/source-repository-shared';

const exec = promisify(execFile);

describe('readSourceRepository', () => {
  it('reads a sanitized GitHub origin, current HEAD and workspace prefix from a local repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-source-repo-'));
    const workspace = join(root, 'packages', 'product');
    await mkdir(workspace, { recursive: true });
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['remote', 'add', 'origin', 'https://token@github.com/acme/storefront.git'], { cwd: root });
    await exec('git', ['-c', 'user.name=Doklo Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });

    const metadata = await readSourceRepository(workspace);

    expect(metadata).toMatchObject({ repository: 'acme/storefront', workspacePrefix: 'packages/product' });
    expect(metadata?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(metadata)).not.toContain('token');
  });
});

describe('githubSourceUrl', () => {
  it('joins the workspace prefix and encodes every path segment', () => {
    expect(githubSourceUrl(
      { repository: 'acme/storefront', commit: 'a'.repeat(40), workspacePrefix: 'packages/product' },
      'apps/web/app/[locale]/sign in.tsx',
      7,
      9,
    )).toBe(`https://github.com/acme/storefront/blob/${'a'.repeat(40)}/packages/product/apps/web/app/%5Blocale%5D/sign%20in.tsx#L7-L9`);
  });
});
