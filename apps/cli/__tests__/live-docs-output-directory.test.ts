import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { registerLiveDocsRenderCommand } from '../src/commands/live-docs-render.js';
import { createContext } from '../src/lib/context.js';
import { takeCommandResult } from '../src/lib/command-result.js';

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doklo-output-boundary-'));
  roots.push(root);
  const workspaceRoot = join(root, 'web');
  await cp(join(here, '../../../packages/livedoc-engine/__tests__/fixtures/render-ws'), workspaceRoot, { recursive: true });
  const external = join(root, 'sibling-public');
  await mkdir(external);
  await writeFile(join(external, 'sentinel.html'), 'keep this file');
  return { root, workspaceRoot, external };
}
function program() {
  const command = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerLiveDocsRenderCommand(command, createContext('en'));
  return command;
}
async function run(workspaceRoot: string, outDir: string, extra: string[] = []) {
  const command = program();
  await command.parseAsync(['live-docs', 'render', 'help-page', '--root', workspaceRoot, '--dok', 'AUTH', '--format', 'html', '--out-dir', outDir, '--json', ...extra], { from: 'user' });
  return takeCommandResult(command);
}

describe('render output directory boundary', () => {
  it('explains workspace-contained output and exact-match public term configuration in CLI help', () => {
    const command = program().commands.find((child) => child.name() === 'live-docs')!.commands.find((child) => child.name() === 'render')!;
    expect(command.helpInformation()).toMatch(/inside.*workspace/i);
    let help = '';
    command.configureOutput({ writeOut: (value) => { help += value; } });
    command.outputHelp();
    expect(help).toContain('workspace.json');
    expect(help).toContain('stable_public_terms');
    expect(help).toContain('exact-match');
    expect(help).toContain('INTERNAL_IDENTIFIER');
    expect(help).toContain('publication export');
  });

  it.each(['parent', 'absolute', 'parent-symlink', 'leaf-symlink', 'dangling-symlink'])('rejects %s destinations early with recovery guidance and no outside writes', async (kind) => {
    const { workspaceRoot, external } = await fixture();
    let destination = '../sibling-public';
    if (kind === 'absolute') destination = external;
    if (kind.includes('symlink')) {
      await symlink(kind === 'dangling-symlink' ? join(external, 'missing') : external, join(workspaceRoot, 'linked'));
      destination = kind === 'parent-symlink' ? 'linked/help' : 'linked';
    }
    // Output validation must not be hidden behind an unrelated missing Hub.
    await rm(join(workspaceRoot, '.doklo/hub'), { recursive: true });
    await expect(run(workspaceRoot, destination)).rejects.toMatchObject({
      result: { status: 'failed', diagnostics: [expect.objectContaining({ code: 'OUTPUT_DIRECTORY_INVALID', message: expect.stringContaining('.doklo/output/help') })] },
    });
    try { await run(workspaceRoot, destination); } catch (error: any) {
      expect(error.result.diagnostics[0].message).toContain(workspaceRoot);
      expect(error.result.diagnostics[0].message).toContain(destination);
    }
    expect(await readFile(join(external, 'sentinel.html'), 'utf8')).toBe('keep this file');
    expect(await readdir(external)).toEqual(['sentinel.html']);
    expect(await readdir(workspaceRoot)).not.toContain('public');
  });

  it('accepts nested relative and absolute in-workspace outputs while preserving dry-run and overwrite behavior', async () => {
    const { workspaceRoot } = await fixture();
    expect(await run(workspaceRoot, 'public/help', ['--dry-run'])).toMatchObject({ status: 'success' });
    expect(await readdir(workspaceRoot)).not.toContain('public');
    expect(await run(workspaceRoot, 'public/help')).toMatchObject({ status: 'success' });
    const original = await readFile(join(workspaceRoot, 'public/help/AUTH.html'), 'utf8');
    await expect(run(workspaceRoot, 'public/help')).rejects.toMatchObject({ result: { diagnostics: [expect.objectContaining({ code: 'OUTPUT_EXISTS' })] } });
    expect(await readFile(join(workspaceRoot, 'public/help/AUTH.html'), 'utf8')).toBe(original);
    expect(await run(workspaceRoot, join(workspaceRoot, 'public/other'))).toMatchObject({ status: 'success' });
  });

  it('does not mislabel a missing Hub as an invalid output directory', async () => {
    const { workspaceRoot } = await fixture();
    await rm(join(workspaceRoot, '.doklo/hub'), { recursive: true });
    await expect(run(workspaceRoot, '.doklo/output/help')).rejects.not.toMatchObject({ result: { diagnostics: [expect.objectContaining({ code: 'OUTPUT_DIRECTORY_INVALID' })] } });
  });
});
