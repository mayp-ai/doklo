import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';
import { loadWorkspace } from '../src/lib/workspace.js';
const roots: string[] = [];
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'doklo-branch-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){return null}');
  git(root, 'init', '-b', 'main');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return root;
}
async function init(root: string, recordingBranch = 'main') {
  return runInit({ root, workspaceId: 'demo', name: 'Demo', serviceId: 'web', defaultLocale: 'en', supportedLocales: ['en'], recordingBranch } as Parameters<typeof runInit>[0]);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('recording branch', () => {
  it('persists the explicit branch even when init runs on a feature branch', async () => {
    const root = await project();
    git(root, 'checkout', '-b', 'feature');
    await init(root);
    expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).recording_branch).toBe('main');
    expect((await loadWorkspace(root) as unknown as { recording_branch: string }).recording_branch).toBe('main');
    expect(git(root, 'branch', '--show-current')).toBe('feature');
  });
  it('rejects a missing branch before writing a workspace', async () => {
    const root = await project();
    await expect(init(root, 'missing')).rejects.toThrow();
    await expect(readFile(join(root, 'workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import { runSync } from '../src/commands/sync.js';
import { runGenerate } from '../src/commands/generate.js';
import { runScan } from '../src/commands/scan.js';
import { runConsolidate } from '../src/commands/consolidate.js';
import { assertRecordingSource, setRecordingBranch } from '../src/lib/recording-branch.js';

describe('recording source isolation', () => {
  it('blocks scan, consolidation, generation and sync on a different branch before work', async () => {
    const root = await project();
    await init(root);
    git(root, 'checkout', '-b', 'feature');
    for (const run of [() => runScan({root}), () => runConsolidate({root, dryRun: true}), () => runGenerate({root, dryRun: true}), () => runSync({root, check: true})]) {
      await expect(run()).rejects.toMatchObject({ result: { diagnostics: [{code: 'RECORDING_BRANCH_MISMATCH'}] } });
    }
  });
  it('blocks dirty source but allows generated Hub/config changes', async () => {
    const root = await project();
    await init(root);
    await expect(assertRecordingSource(root)).resolves.toMatchObject({branch: 'main'});
    await writeFile(join(root, 'app/page.tsx'), 'export default function Page(){return "changed"}');
    await expect(runSync({root, check: true})).rejects.toMatchObject({ result: { diagnostics: [{code: 'RECORDING_SOURCE_DIRTY'}] } });
  });
  it('allows installed Doklo skill metadata without treating it as product source', async () => {
    const root = await project();
    await init(root);
    const before = await assertRecordingSource(root);
    for (const dir of ['.agents/skills/doklo', '.claude/skills/doklo']) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'SKILL.md'), 'Doklo tool instructions');
    }
    await mkdir(join(root, '.claude/rules'), { recursive: true });
    await writeFile(join(root, '.claude/rules/doklo.md'), 'Doklo startup rule');
    expect(await assertRecordingSource(root)).toEqual(before);
    await writeFile(join(root, 'app/new.tsx'), 'export const newFeature = true');
    await expect(assertRecordingSource(root)).rejects.toMatchObject({ result: { diagnostics: [{code: 'RECORDING_SOURCE_DIRTY'}] } });
  });
  it('blocks an untracked source and detached HEAD', async () => {
    const root = await project();
    await init(root);
    await writeFile(join(root, 'app/new.tsx'), 'export const x = 1');
    await expect(assertRecordingSource(root)).rejects.toMatchObject({ result: { diagnostics: [{code: 'RECORDING_SOURCE_DIRTY'}] } });
    await rm(join(root, 'app/new.tsx'));
    git(root, 'checkout', '--detach');
    await expect(assertRecordingSource(root)).rejects.toMatchObject({ result: { diagnostics: [{code: 'RECORDING_BRANCH_MISMATCH'}] } });
  });
  it('updates an existing workspace without losing other settings or Hub edits', async () => {
    const root = await project();
    await init(root);
    const file = join(root, 'workspace.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.custom_extension = { keep: true };
    await writeFile(file, JSON.stringify(raw));
    const roles = await readFile(join(root, '.doklo/hub/roles.json'), 'utf8');
    git(root, 'branch', 'production');
    await setRecordingBranch(root, 'production');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({recording_branch:'production', custom_extension: {keep:true}});
    expect(await readFile(join(root, '.doklo/hub/roles.json'), 'utf8')).toBe(roles);
    await expect(setRecordingBranch(root, 'missing')).rejects.toThrow();
    expect((await loadWorkspace(root)).recording_branch).toBe('production');
  });
});

import { Command } from 'commander';
import { registerInitCommand } from '../src/commands/init.js';
import { registerRecordingCommand } from '../src/commands/recording.js';
import { createContext } from '../src/lib/context.js';
import { assertCacheSource, recordCacheSource } from '../src/lib/recording-branch.js';
describe('recording CLI and cache provenance', () => {
  it('supports init --recording-branch and updating it without init', async () => {
    const root = await project();
    const cli = new Command();
    registerInitCommand(cli, createContext('en'));
    await cli.parseAsync(['init','--root',root,'--yes','--no-scan','--json','--recording-branch','main'], {from:'user'});
    expect((await loadWorkspace(root)).recording_branch).toBe('main');
    git(root, 'branch', 'production');
    const update = new Command();
    registerRecordingCommand(update, createContext('en'));
    await update.parseAsync(['recording','--root',root,'--branch','production','--json'], {from:'user'});
    expect((await loadWorkspace(root)).recording_branch).toBe('production');
  });
  it('rejects unstamped or modified cache and cache from an earlier source version', async () => {
    const root = await project();
    await init(root);
    const source = await assertRecordingSource(root);
    const cache = join(root, '.doklo/cache/example.json');
    await writeFile(cache, '{}');
    await expect(assertCacheSource(root,'scan','web',cache,source)).rejects.toThrow();
    await recordCacheSource(root,'scan','web',cache,source);
    await expect(assertCacheSource(root,'scan','web',cache,source)).resolves.toBeUndefined();
    await writeFile(cache, '{"from":"feature"}');
    await expect(assertCacheSource(root,'scan','web',cache,source)).rejects.toThrow();
    await writeFile(cache, '{}');
    await writeFile(join(root,'app/page.tsx'),'export default function Page(){return "new"}');
    git(root,'add','app/page.tsx');
    git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','next');
    await expect(assertCacheSource(root,'scan','web',cache,await assertRecordingSource(root))).rejects.toThrow();
  });
  it('rejects legacy cache before consolidation and writes provenance after a real scan', async () => {
    const root = await project();
    await init(root);
    await expect(runConsolidate({root,dryRun:true})).rejects.toMatchObject({result:{diagnostics:[{code:'RECORDING_CACHE_OUTDATED'}]}});
    const result = await runScan({root});
    expect(result.results).toHaveLength(1);
    await expect(assertCacheSource(root,'scan','web',result.results[0]!.outputPath,await assertRecordingSource(root))).resolves.toBeUndefined();
    const preview = await runConsolidate({root,dryRun:true});
    expect(preview.results).toHaveLength(1);
  });
  it('keeps old unconfigured projects usable without Git', async () => {
    const root = await project();
    await rm(join(root,'.git'),{recursive:true});
    await runInit({root,workspaceId:'demo',name:'Demo',serviceId:'web',defaultLocale:'en',supportedLocales:['en']});
    await expect(runSync({root,check:true})).resolves.toMatchObject({checked:0});
  });
});

it('does not require paid regrouping after a documentation-only commit', async () => {
  const root = await project();
  await init(root);
  const cache = join(root,'.doklo/cache/example.json');
  await writeFile(cache,'{}');
  await recordCacheSource(root,'consolidate','web',cache,await assertRecordingSource(root));
  git(root,'add','workspace.json','.doklo/hub');
  git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','record docs');
  await expect(assertCacheSource(root,'consolidate','web',cache,await assertRecordingSource(root))).resolves.toBeUndefined();
});
