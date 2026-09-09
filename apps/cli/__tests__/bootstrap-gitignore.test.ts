import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { bootstrapWorkspace } from '../src/lib/bootstrap.js';
import { createPublication } from '../src/lib/publication-store.js';

async function emptyDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'doklo-gitignore-'));
}

const sampleService = {
  service_id: 'web' as const,
  type: 'frontend' as const,
  framework: 'nextjs' as const,
  code_root: '.',
  description: 'Next.js single-codebase web app',
};

function bootstrapArgs(root: string) {
  return {
    root,
    workspaceId: 'demo',
    name: 'Demo',
    defaultLocale: 'en',
    supportedLocales: ['en'],
    services: [sampleService],
  };
}

// The 7 core allowlist lines, verbatim + in order, the file must contain.
const CORE_ALLOWLIST = [
  '# .doklo/ — Doklo workspace.',
  '# The Hub (hub/) and Publication definitions (livedocs/) are source: commit them.',
  '# Everything else (renders, caches, debug, screenshots) is derived — regenerate it.',
  '/*',
  '!/.gitignore',
  '!/hub/',
  '!/livedocs/',
].join('\n');

describe('bootstrapWorkspace — .doklo/.gitignore', () => {
  it('writes .doklo/.gitignore containing the allowlist core lines', async () => {
    const root = await emptyDir();
    await bootstrapWorkspace(bootstrapArgs(root));

    const content = await readFile(join(root, '.doklo/.gitignore'), 'utf-8');
    expect(content).toContain(CORE_ALLOWLIST);
    // Guidance comment for publishers of rendered Live Docs.
    expect(content).toContain('!/output/');
  });

  it('preserves a pre-existing .doklo/.gitignore (no clobber, even without workspace.json)', async () => {
    const root = await emptyDir();
    // Simulate a partial/previous init: .doklo/.gitignore exists but
    // workspace.json does not, so bootstrap does NOT throw yet must still
    // preserve the user's file.
    await mkdir(join(root, '.doklo'), { recursive: true });
    const custom = '# my custom rules\n/*\n!/hub/\n!/output/\n';
    await writeFile(join(root, '.doklo/.gitignore'), custom, 'utf-8');

    await bootstrapWorkspace(bootstrapArgs(root));

    const content = await readFile(join(root, '.doklo/.gitignore'), 'utf-8');
    expect(content).toBe(custom);
  });

  it('git exposes Hub and Publication sources while derived output/cache/debug stay ignored', async () => {
    const root = await emptyDir();
    // Isolate from any global/system gitignore so the assertions are hermetic.
    const git = (args: string[]) =>
      execa('git', args, {
        cwd: root,
        reject: false,
        env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });

    await git(['init']);
    await bootstrapWorkspace(bootstrapArgs(root));

    // One Hub source, one persisted Publication source, and three derived files.
    await mkdir(join(root, '.doklo/output'), { recursive: true });
    await writeFile(join(root, '.doklo/hub/doks/X.json'), '{}\n', 'utf-8');
    await createPublication(root, {
      schema_version: 1,
      name: 'public-help',
      display_name: 'Public Help',
      template: 'help-page',
      selection: { mode: 'all' },
      selected_dok_ids: ['AUTH'],
      format: 'html',
      locale: 'en',
      vars: { title: 'Help Center' },
      output_dir: 'help-page/public-help',
      created_at: '2026-07-17T03:04:05.678Z',
    });
    await writeFile(join(root, '.doklo/output/public-help.html'), '<html></html>\n', 'utf-8');
    await writeFile(join(root, '.doklo/cache/b.json'), '{}\n', 'utf-8');
    await writeFile(join(root, '.doklo/debug/c.json'), '{}\n', 'utf-8');

    // git check-ignore: exit 0 ⟺ path is ignored.
    const isIgnored = async (rel: string): Promise<boolean> =>
      (await git(['check-ignore', rel])).exitCode === 0;

    // Source of truth + the policy file itself are trackable.
    expect(await isIgnored('.doklo/hub/doks/X.json')).toBe(false);
    expect(await isIgnored('.doklo/livedocs/publications/public-help.json')).toBe(false);
    expect(await isIgnored('.doklo/.gitignore')).toBe(false);
    // Derived output is ignored.
    expect(await isIgnored('.doklo/output/public-help.html')).toBe(true);
    expect(await isIgnored('.doklo/cache/b.json')).toBe(true);
    expect(await isIgnored('.doklo/debug/c.json')).toBe(true);

    // Cross-check via porcelain (-uall lists individual untracked files;
    // ignored files are omitted entirely).
    const status = (await git(['status', '--porcelain', '-uall'])).stdout;
    expect(status).toContain('.doklo/hub/doks/X.json');
    expect(status).toContain('.doklo/livedocs/publications/public-help.json');
    expect(status).toContain('.doklo/.gitignore');
    expect(status).not.toContain('.doklo/output/public-help.html');
    expect(status).not.toContain('.doklo/cache/b.json');
    expect(status).not.toContain('.doklo/debug/c.json');
  });
});
