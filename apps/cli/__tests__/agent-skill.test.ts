import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { manageAgentSkill, DOKLO_AGENT_SKILL } from '../src/lib/agent-skill.js';
import { registerAgentCommand } from '../src/commands/agent.js';
import { createContext } from '../src/lib/context.js';

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'doklo-agent-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('project-local agent skill', () => {
  it('installs, previews and removes the Claude startup rule alongside the skill', async () => {
    const root = await project();
    const opts = { root, target: 'claude-code', action: 'setup' as const };
    const preview = await manageAgentSkill({ ...opts, preview: true });
    expect(preview.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining('.claude/rules/doklo.md'), status: 'preview', content: expect.stringContaining('doklo show --json') }),
    ]));
    await expect(access(join(root, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
    await manageAgentSkill(opts);
    expect(await readFile(join(root, '.claude/rules/doklo.md'), 'utf8')).toContain('doklo show --json');
    expect((await manageAgentSkill(opts)).status).toBe('unchanged');
    await manageAgentSkill({ ...opts, action: 'remove' });
    await expect(access(join(root, '.claude/rules/doklo.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a customized startup rule and the skill on setup or removal conflict', async () => {
    const root = await project();
    const opts = { root, target: 'claude-code', action: 'setup' as const };
    await manageAgentSkill(opts);
    await mkdir(join(root, '.claude/rules'), { recursive: true });
    await writeFile(join(root, '.claude/rules/doklo.md'), 'My rule');
    for (const action of ['setup', 'remove'] as const) {
      await expect(manageAgentSkill({ ...opts, action })).rejects.toMatchObject({ code: 'conflict' });
      expect(await readFile(join(root, '.claude/skills/doklo/SKILL.md'), 'utf8')).toBe(DOKLO_AGENT_SKILL);
      expect(await readFile(join(root, '.claude/rules/doklo.md'), 'utf8')).toBe('My rule');
    }
  });

  it('rejects a symlinked rules directory before installing the Claude skill', async () => {
    const root = await project();
    const external = await project();
    await mkdir(join(root, '.claude'));
    await symlink(external, join(root, '.claude/rules'));
    await expect(manageAgentSkill({ root, target: 'claude-code', action: 'setup' })).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(access(join(root, '.claude/skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(external, 'doklo.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([['codex', '.agents'], ['claude-code', '.claude']] as const)('installs and removes only %s skill, preserving user guidance', async (target, directory) => {
    const root = await project();
    await writeFile(join(root, 'AGENTS.md'), 'user rules\n');
    await writeFile(join(root, 'CLAUDE.md'), 'other user rules\n');
    const opts = { root, target, action: 'setup' as const };
    const result = await manageAgentSkill(opts);
    expect(result.status).toBe('installed');
    const file = join(root, directory, 'skills', 'doklo', 'SKILL.md');
    expect(result.path).toBe(await realpath(file));
    expect(await readFile(file, 'utf8')).toBe(DOKLO_AGENT_SKILL);
    expect((await manageAgentSkill(opts)).status).toBe('unchanged');
    await writeFile(join(root, directory, 'skills', 'doklo', 'NOTES.md'), 'user notes');
    expect((await manageAgentSkill({ ...opts, action: 'remove', preview: true })).status).toBe('preview');
    await access(file);
    expect((await manageAgentSkill({ ...opts, action: 'remove' })).status).toBe('removed');
    expect((await manageAgentSkill({ ...opts, action: 'remove' })).status).toBe('absent');
    expect(await readFile(join(root, directory, 'skills', 'doklo', 'NOTES.md'), 'utf8')).toBe('user notes');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('user rules\n');
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('other user rules\n');
  });

  it('previews full content without creating directories', async () => {
    const root = await project();
    const result = await manageAgentSkill({ root, target: 'codex', action: 'setup', preview: true });
    expect(result.status).toBe('preview');
    expect(result.content).toBe(DOKLO_AGENT_SKILL);
    await expect(access(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses both replacement and removal of modified or foreign files', async () => {
    const root = await project();
    const opts = { root, target: 'codex', action: 'setup' as const };
    const { path } = await manageAgentSkill(opts);
    for (const content of ['user skill', `${DOKLO_AGENT_SKILL}\nUser addition`]) {
      await writeFile(path, content);
      for (const action of ['setup', 'remove'] as const) {
        await expect(manageAgentSkill({ ...opts, action })).rejects.toMatchObject({ code: 'conflict' });
      }
      expect(await readFile(path, 'utf8')).toBe(content);
    }
  });

  it('rejects symlinked skill roots and files', async () => {
    const root = await project();
    const external = await project();
    await symlink(external, join(root, '.agents'));
    await expect(manageAgentSkill({ root, target: 'codex', action: 'setup' })).rejects.toMatchObject({ code: 'unsafe_path' });
    await rm(join(root, '.agents'));
    await mkdir(join(root, '.agents/skills/doklo'), { recursive: true });
    await writeFile(join(external, 'SKILL.md'), DOKLO_AGENT_SKILL);
    await symlink(join(external, 'SKILL.md'), join(root, '.agents/skills/doklo/SKILL.md'));
    await expect(manageAgentSkill({ root, target: 'codex', action: 'remove' })).rejects.toMatchObject({ code: 'unsafe_path' });
    expect(await readFile(join(external, 'SKILL.md'), 'utf8')).toBe(DOKLO_AGENT_SKILL);
  });

  it('rejects unsupported targets before writing anything', async () => {
    const root = await project();
    await expect(manageAgentSkill({ root, target: '../escape', action: 'setup' })).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('runs actual commander setup with an explicit project root', async () => {
    const root = await project();
    const program = new Command().exitOverride();
    registerAgentCommand(program, createContext('en'));
    await program.parseAsync(['agent', 'setup', '--target', 'codex', '--root', root], { from: 'user' });
    expect(await readFile(join(root, '.agents/skills/doklo/SKILL.md'), 'utf8')).toBe(DOKLO_AGENT_SKILL);
  });
});
