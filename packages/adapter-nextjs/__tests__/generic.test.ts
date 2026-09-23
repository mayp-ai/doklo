import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as adapter from '../src/index.js';

const roots: string[] = [];
async function fixture(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'doklo-generic-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('generic analysis', () => {
  it('discovers Python and custom text source without a manifest or invented routes', async () => {
    const root = await fixture({ 'src/orders.py': 'def order(): return 42', 'src/rules.custom': 'rule allow orders' });
    const ir = await adapter.extractProjectIR({ rootDir: root });
    expect(ir.files).toEqual(['src/orders.py', 'src/rules.custom']);
    expect(ir.routes).toEqual([]);
    expect(ir.analysis_units?.flatMap(unit => unit.files)).toEqual(ir.files);
    expect(ir.framework_specific?.analysis_strategy).toBe('generic-files-v1');
    expect(ir.framework_specific?.import_graph).toBeUndefined();
    expect(ir.framework_specific?.file_ledger).toEqual(ir.files.map(file => ({ file, status: 'processed', stages: ['discovery'], reason: 'TEXT_SOURCE' })));
  });
  it('excludes secrets, binary files, oversized files, build output and gitignored files', async () => {
    const root = await fixture({ 'main.go': 'package main', '.env': 'SECRET=test', '.npmrc': 'token=test',
      'key.pem': 'PRIVATE', 'image.bin': Buffer.from([0, 1, 2]), 'large.txt': 'a'.repeat(1024 * 1024 + 1),
      'node_modules/x.js': 'dependency', 'dist/out.js': 'output', '.gitignore': 'private/\n', 'private/data.txt': 'ignored' });
    execFileSync('git', ['init', '-q', root]);
    const ir = await adapter.extractProjectIR({ rootDir: root });
    expect(ir.files).toEqual(['main.go']);
    expect(ir.framework_specific?.file_ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'image.bin', status: 'excluded', reason: 'BINARY_OR_NON_UTF8' }),
      expect.objectContaining({ file: 'large.txt', status: 'excluded', reason: 'FILE_TOO_LARGE' }),
    ]));
  });
  it('rejects a source symlink outside the root', async () => {
    const outside = await fixture({ 'secret.txt': 'outside' });
    const root = await fixture({ 'main.py': 'pass' });
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.py'));
    await expect(adapter.extractProjectIR({ rootDir: root })).rejects.toThrow();
  });
  it('uses Next.js App Router when applicable and preserves its parse failures', async () => {
    const root = await fixture({ 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'app/page.tsx': 'export default function Page() { return null; }' });
    const ir = await adapter.extractProjectIR({ rootDir: root });
    expect(ir.framework).toBe('nextjs');
    expect(ir.routes.some(route => route.path === '/')).toBe(true);
    await writeFile(join(root, 'app/broken.ts'), 'export const = ;');
    const broken = await adapter.extractProjectIR({ rootDir: root });
    expect(broken.framework_specific?.file_ledger).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'app/broken.ts', status: 'failed' })]));
  });
  it('uses the generic path for Next.js Pages Router and an invalid manifest', async () => {
    const root = await fixture({ 'package.json': '{"dependencies":{"next":"15.0.0"}}', 'pages/index.tsx': 'export default () => null;' });
    expect((await adapter.extractProjectIR({ rootDir: root })).framework_specific?.analysis_strategy).toBe('generic-files-v1');
    await writeFile(join(root, 'package.json'), '{invalid');
    expect((await adapter.extractProjectIR({ rootDir: root })).files).toContain('pages/index.tsx');
  });
});

it('keeps files outside a specialist language in a mixed project', async () => {
  const root = await fixture({ 'package.json': '{"dependencies":{"next":"15.0.0"}}',
    'app/page.tsx': 'export default () => null;', 'worker/task.py': 'def run(): return 1' });
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.files).toContain('worker/task.py');
  expect(ir.analysis_units?.flatMap(unit => unit.files)).toContain('worker/task.py');
  expect(ir.routes.some(route => route.path === '/')).toBe(true);
});

it('honors nested ignore rules in a downloaded source tree without creating .git', async () => {
  const root = await fixture({ '.gitignore': 'private.txt\n', 'private.txt': 'secret', 'main.py': 'pass',
    'src/.gitignore': '*.local\n!keep.local\n', 'src/private.local': 'secret', 'src/keep.local': 'allowed' });
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.files).toEqual(['main.py', 'src/keep.local']);
});
it('records deleted tracked files without blocking the remaining source', async () => {
  const root = await fixture({ 'main.py': 'pass', 'deleted.py': 'pass' });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  await rm(join(root, 'deleted.py'));
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.files).toEqual(['main.py']);
});
it('keeps Git-ignored source out of the specialist result and diagnoses an excluded import', async () => {
  const root = await fixture({ 'package.json': '{"dependencies":{"next":"15.0.0"}}', '.gitignore': 'private.ts\n',
    'app/page.tsx': 'export default () => null;', 'private.ts': 'export const secret = 1;' });
  execFileSync('git', ['init', '-q', root]);
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.files).not.toContain('private.ts');
  await writeFile(join(root, 'app/page.tsx'), "import { secret } from '../private'; export default () => secret;");
  const broken = await adapter.extractProjectIR({ rootDir: root });
  expect(broken.files).not.toContain('private.ts');
  expect(broken.framework_specific?.file_ledger).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: 'app/page.tsx', status: 'failed' }),
  ]));
});

it('produces generic candidates for an API-only Next.js service', async () => {
  const root = await fixture({ 'package.json': '{"dependencies":{"next":"15.0.0"}}',
    'app/api/route.ts': 'export function GET() { return new Response("ok"); }' });
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.analysis_units?.flatMap(unit => unit.files)).toContain('app/api/route.ts');
  expect(ir.framework_specific?.analysis_strategy).toBe('generic-files-v1');
  expect(ir.routes.some(route => route.kind === 'api')).toBe(true);
});
it('does not read ignored middleware metadata through the specialist', async () => {
  const root = await fixture({ 'package.json': '{"dependencies":{"next":"15.0.0"}}',
    '.gitignore': 'middleware.ts\n', 'middleware.ts': "export const config = { matcher: ['/private'] };",
    'app/page.tsx': 'export default () => null;' });
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.framework_specific?.middleware).toBeNull();
});

// Regression: removing the pre-read policy must expose forbidden entries again.
it('excludes credential/config paths before resolving or reading them', async () => {
  const root = await fixture({ 'main.py': 'pass', 'AuthKey.p8': 'SYNTHETIC_CANARY',
    'application.properties': 'password=SYNTHETIC_CANARY', 'application-prod.yml': 'password: SYNTHETIC_CANARY',
    '.ENV.local': 'TOKEN=SYNTHETIC_CANARY', '.aws/config': 'SYNTHETIC_CANARY',
    'secrets/service.json': 'SYNTHETIC_CANARY', 'terraform.tfstate': 'SYNTHETIC_CANARY',
    'config/database.yml': 'SYNTHETIC_CANARY' });
  // A forbidden dangling link must never reach containment resolution/readFile.
  await symlink('/nonexistent/doklo-sensitive', join(root, 'private.p8'));
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.files).toEqual(['main.py']);
  expect(JSON.stringify(ir.analysis_units)).not.toContain('SYNTHETIC_CANARY');
});
it('excludes even tracked files matching current gitignore rules', async () => {
  const root = await fixture({ 'main.py': 'pass', 'private/settings.custom': 'SYNTHETIC_CANARY' });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  await writeFile(join(root, '.gitignore'), 'private/\n');
  expect((await adapter.extractProjectIR({ rootDir: root })).files).toEqual(['main.py']);
});

it('keeps a small multi-directory service together so generation sees data and handlers', async () => {
  const root = await fixture({
    'src/data.py': 'notices = []',
    'routes/list.py': 'from src.data import notices',
    'routes/detail.py': 'from src.data import notices',
    'requirements.txt': 'Flask',
  });
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.analysis_units).toHaveLength(1);
  expect(ir.analysis_units![0]!.files).toEqual(['requirements.txt', 'routes/detail.py', 'routes/list.py', 'src/data.py']);
});

it('skips ecosystem credentials before containment while preserving authentication logic', async () => {
  const root = await fixture({ 'src/auth.py': 'def authorize(): return True',
    'src/firebase-admin.ts': 'export function authenticate() { return true; }' });
  const outside = await fixture({ 'sensitive.txt': 'SYNTHETIC_CANARY' });
  for (const file of ['.envrc', 'production.auto.tfvars.json', 'serviceAccountKey.json',
    'project-firebase-adminsdk-abc-123.json', 'local.settings.json', 'local_settings.py']) {
    await symlink(join(outside, 'sensitive.txt'), join(root, file));
  }
  // A late check fails containment on the first alias; a pre-read check skips it.
  const ir = await adapter.extractProjectIR({ rootDir: root });
  expect(ir.files).toEqual(['src/auth.py', 'src/firebase-admin.ts']);
});


it('never opens ignored imports or inherited config while retaining allowed aliases', async () => {
  const root = await fixture({
    'package.json': '{"dependencies":{"next":"15.0.0"}}',
    '.gitignore': 'private.ts\nprivate-config.json\n',
    'private.ts': 'export const secret = "SYNTHETIC_CANARY";',
    'private-config.json': '{"compilerOptions":{"strict":true}}',
    'tsconfig.json': JSON.stringify({ extends: './private-config.json', compilerOptions: {
      baseUrl: '.', paths: { '@/*': ['./src/*'] }, jsx: 'preserve',
    } }),
    'src/allowed.ts': 'export const allowed = 1;',
    'app/page.tsx': "import { secret } from '../private'; import { allowed } from '@/allowed'; export default () => allowed;",
  });
  const forbidden = new Set([join(root, 'private.ts'), join(root, 'private-config.json')].map(file => fs.realpathSync(file)));
  const opened: string[] = [];
  const original = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === 'string' && fs.existsSync(file) && forbidden.has(fs.realpathSync(file))) opened.push(file);
    return (original as Function)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    const ir = await adapter.extractProjectIR({ rootDir: root });
    expect(opened).toEqual([]);
    expect(ir.framework_specific?.import_graph).toMatchObject({ 'app/page.tsx': ['src/allowed.ts'] });
    expect(ir.framework_specific?.file_ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'app/page.tsx', status: 'failed' }),
    ]));
  } finally { spy.mockRestore(); }
});


it('retains inherited aliases from approved config while containing outside imports', async () => {
  const outside = await fixture({ 'outside.ts': 'export const token = "SYNTHETIC_CANARY";' });
  const root = await fixture({
    'package.json': '{"dependencies":{"next":"15.0.0"}}',
    'tsconfig.json': '{"extends":"./config/base.json"}',
    'config/base.json': JSON.stringify({ compilerOptions: {
      baseUrl: '..', paths: { '@/*': ['./src/*'] }, jsx: 'preserve',
    } }),
    'src/allowed.ts': 'export const allowed = 1;',
    'app/page.tsx': `import { token } from '${join(outside, 'outside')}'; import { allowed } from '@/allowed'; export default () => allowed;`,
  });
  const forbidden = fs.realpathSync(join(outside, 'outside.ts'));
  const opened: string[] = [];
  const original = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === 'string' && fs.existsSync(file) && fs.realpathSync(file) === forbidden) opened.push(file);
    return (original as Function)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    const ir = await adapter.extractProjectIR({ rootDir: root });
    expect(opened).toEqual([]);
    expect(ir.framework_specific?.import_graph).toMatchObject({ 'app/page.tsx': ['src/allowed.ts'] });
  } finally { spy.mockRestore(); }
});
