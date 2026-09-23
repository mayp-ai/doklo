import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validateCurrentSourceFiles } from '../src/lib/current-source-policy.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doklo-current-source-'));
  roots.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/main.py'), 'def run(): pass');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([true, false])('rejects a cached file ignored after discovery (tracked=%s)', async tracked => {
  const root = await fixture();
  execFileSync('git', ['init', '-q', root]);
  if (tracked) execFileSync('git', ['-C', root, 'add', '.']);
  const cached = ['src/main.py'];
  await expect(validateCurrentSourceFiles(root, cached)).resolves.toBeUndefined();
  await writeFile(join(root, '.gitignore'), 'src/main.py\n');
  await expect(validateCurrentSourceFiles(root, cached)).rejects.toThrow(/rescan/i);
});

it('applies nested ignore rules and negation outside Git without creating .git', async () => {
  const root = await fixture();
  await writeFile(join(root, 'src/.gitignore'), '*.py\n!main.py\n');
  await writeFile(join(root, 'src/local.py'), 'SYNTHETIC_CANARY');
  await expect(validateCurrentSourceFiles(root, ['src/main.py'])).resolves.toBeUndefined();
  await expect(validateCurrentSourceFiles(root, ['src/local.py'])).rejects.toThrow(/rescan/i);
  await expect(access(join(root, '.git'))).rejects.toThrow();
});

it.each(['.envrc', 'serviceAccountKey.json', 'node_modules/module.js', '.doklo/cache.json'])('rejects excluded cached path %s', async file => {
  const root = await fixture();
  const segments = file.split('/');
  if (segments.length > 1) await mkdir(join(root, segments[0]!), { recursive: true });
  await writeFile(join(root, file), 'SYNTHETIC_CANARY');
  await expect(validateCurrentSourceFiles(root, [file])).rejects.toThrow(/rescan/i);
});

it('rejects an ignored source before resolving its replaced symlink', async () => {
  const root = await fixture();
  await writeFile(join(root, '.gitignore'), 'private.py\n');
  await symlink('/nonexistent/doklo-sensitive', join(root, 'private.py'));
  await expect(validateCurrentSourceFiles(root, ['private.py'])).rejects.toThrow(/rescan/i);
});

it('rejects a permitted filename replaced by a symlink', async () => {
  const root = await fixture();
  await symlink(join(root, 'src/main.py'), join(root, 'alias.py'));
  await expect(validateCurrentSourceFiles(root, ['alias.py'])).rejects.toThrow();
});
