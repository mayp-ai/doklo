import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerInitCommand, runInit } from '../src/commands/init.js';
import { runScan } from '../src/commands/scan.js';
import { createContext } from '../src/lib/context.js';
import { takeCommandResult } from '../src/lib/command-result.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function monorepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-code-root-'));
  roots.push(root);
  await mkdir(join(root, 'web/app'), { recursive: true });
  await mkdir(join(root, 'server/.venv'), { recursive: true });
  await writeFile(join(root, 'web/package.json'), JSON.stringify({ dependencies: { next: '15.4.0' } }));
  await writeFile(join(root, 'web/app/page.tsx'), 'export default function Page() { return <button>Save</button>; }');
  await writeFile(join(root, 'server/main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/status")\ndef status():\n    return {"ok": True}\n');
  await writeFile(join(root, 'server/requirements.txt'), 'fastapi\n');
  await writeFile(join(root, 'server/.env'), 'PRIVATE_TOKEN=fixture\n');
  await writeFile(join(root, 'server/.venv/cache.py'), '# excluded dependency\n');
  await writeFile(join(root, 'server/image.bin'), Buffer.from([0, 1, 2]));
  return root;
}

function options(root: string, codeRoot: string) {
  return { root, codeRoot, workspaceId: 'demo', name: 'Demo', defaultLocale: 'ko', supportedLocales: ['ko'], serviceId: 'web' };
}

describe('init service code root', () => {
  it('persists the explicit Korean tone through the init CLI', async () => {
    const root = await monorepo();
    const program = new Command().exitOverride();
    registerInitCommand(program, createContext('ko'));
    await program.parseAsync(['init', '--root', root, '--code-root', 'web', '--korean-tone', 'plain', '--yes', '--json', '--no-scan'], { from: 'user' });
    expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).korean_customer_tone).toBe('plain');
  });
  it('keeps the workspace at the monorepo root and scans only the selected Next.js app', async () => {
    const root = await monorepo();
    const init = await runInit(options(root, './web/'));
    expect(init.framework).toBe('nextjs');
    const workspace = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'));
    expect(workspace.services).toEqual([{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'web' }]);
    await expect(access(join(root, 'web/workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const scan = await runScan({ root });
    expect(scan.results[0]?.ir?.files).toEqual(['app/page.tsx']);
    expect(scan.results[0]).toMatchObject({ analysis: {
      strategy: 'nextjs-app-router', codeRoot: 'web', serviceRoot: join(await realpath(root), 'web'), files: 1,
    } });
  });

  it('supports FastAPI source through generic file analysis without inventing route semantics', async () => {
    const root = await monorepo();
    await runInit({ ...options(root, 'server'), serviceId: 'api', framework: 'fastapi' });
    const scan = await runScan({ root });
    expect(scan.results[0]?.ir?.files).toEqual(['main.py', 'requirements.txt']);
    expect(scan.results[0]?.ir?.routes).toEqual([]);
    expect(scan.results[0]).toMatchObject({ framework: 'fastapi', analysis: {
      strategy: 'generic-files-v1', codeRoot: 'server', files: 2,
      excludedFiles: [{ file: 'image.bin', reason: 'BINARY_OR_NON_UTF8' }],
    } });
    expect(scan.results[0]?.analysis?.limitations.join(' ')).toMatch(/framework.*semantics/i);
    expect(scan.results[0]?.analysis?.exclusions.join(' ')).toMatch(/ignored.*sensitive/i);
  });

  it('wires --code-root into the offline CLI path and reports selected roots in JSON', async () => {
    const root = await monorepo();
    const program = new Command().exitOverride();
    registerInitCommand(program, createContext('en'));
    await program.parseAsync(['init', '--root', root, '--code-root', 'web', '--yes', '--json', '--no-scan'], { from: 'user' });
    expect(takeCommandResult(program)).toMatchObject({ command: 'init', data: {
      framework: 'nextjs', codeRoot: 'web', serviceRoot: join(await realpath(root), 'web'),
    } });
  });

  it.each(['', 'missing', 'server/main.py', '../outside', 'web/../server', '/tmp', 'C:\\outside'])('rejects invalid code root %j before bootstrap writes', async codeRoot => {
    const root = await monorepo();
    await writeFile(join(root, 'sentinel.txt'), 'keep');
    await expect(runInit(options(root, codeRoot))).rejects.toMatchObject({ code: 'INVALID_CODE_ROOT' });
    for (const path of ['workspace.json', '.doklo', '.agents', '.claude']) {
      await expect(access(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(root, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it.each(['alias', 'alias/app'])('rejects a symlinked code root or ancestor: %s', async codeRoot => {
    const root = await monorepo();
    await symlink(join(root, 'web'), join(root, 'alias'));
    await expect(runInit(options(root, codeRoot))).rejects.toMatchObject({ code: 'INVALID_CODE_ROOT' });
    await expect(access(join(root, '.doklo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
