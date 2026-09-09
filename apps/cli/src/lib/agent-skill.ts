import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type AgentTarget = 'claude-code' | 'codex';
export type AgentSkillAction = 'setup' | 'remove';
export type AgentSkillErrorCode = 'invalid_target' | 'conflict' | 'unsafe_path';
export class AgentSkillError extends Error {
  constructor(public readonly code: AgentSkillErrorCode, public readonly path: string) {
    super(`${code}: ${path}`);
    this.name = 'AgentSkillError';
  }
}

// Exact content is the ownership receipt: even a marked but customized skill
// belongs to the user. Keep older templates explicitly if migration is needed.
export const DOKLO_AGENT_SKILL = `---
name: doklo
description: Use when implementing, debugging, refactoring, or reviewing code in this project that has existing Doklo Doks, including ordinary coding requests that do not mention Doklo.
---

<!-- doklo-managed-skill:v1 -->
# Use existing Doks as product context

Run these commands from the Doklo workspace root (the directory containing workspace.json), with the installed doklo executable available on PATH. From a nested directory, supply --root with that workspace directory.

1. Run \`doklo show --json\` to list existing Doks. The JSONL terminal result envelope contains the list in \`result.data\`. Select Doks relevant to the user's coding task by their IDs and names.
2. Run \`doklo show DOK-ID --json\` for each relevant ID. Read its business rules, acceptance criteria, user actions, and code anchors; then inspect the relevant source code and tests, resolving anchors against the owning service's code root in workspace.json. Use existing code mapping when it helps locate the implementation.
3. Inspect review status separately from source freshness: \`draft\` means not yet approved; \`active\` records a review transition, not guaranteed correctness. Read \`_meta.history\` and \`_meta.pending_change\` when relevant. The JSON Dok itself is not a live freshness check. Run \`doklo show DOK-ID\` for its current tracked-source freshness summary, and compare source code when accuracy matters. A matching source hash does not establish human review; missing hashes mean unknown freshness.
4. Use those concrete rules to guide the change and validation. Cite the relevant Dok ID/rule and code path when explaining a material decision or discrepancy. Generated Doks may be incomplete or stale; compare their claims with current code and the user's requested behavior. Report contradictions rather than silently treating a Dok as authoritative or inventing missing constraints.

If the executable, workspace, or relevant Doks are unavailable, say what context is missing and continue the authorized coding work using source code and tests. An empty list is not permission to generate documentation. Do not initialize, generate, sync, or change Dok approval status merely to obtain context. Do not claim human review or approval on a person's behalf.

Reading Doks is appropriate on every development branch. Recording product changes is a separate, configured workflow: only after integration on the project's explicitly configured production branch (workspace.json recording_branch), following that workflow's authorization. Read the setting with \`doklo recording --json\` when needed. Do not assume main or master is production, ask about recording on every development commit, or create generation/recording hooks as part of a coding task. Existing session authorization still applies to an explicitly requested documentation operation.

This skill provides discoverable guidance; client skill selection is not an enforced hook. Invoke explicitly with \`$doklo\` in Codex or \`/doklo\` in Claude Code.
`;

export const DOKLO_CLAUDE_RULE = `<!-- doklo-managed-rule:v1 -->
# Doklo product context

When the user asks to investigate, explain, fix, review, or change this project's behavior, start by reading the doklo skill and looking up existing Doks before searching implementation files. This includes requests to understand how a feature currently works or where to improve it, even when the user does not mention documentation.

Invoke the doklo skill, or read .claude/skills/doklo/SKILL.md if the Skill tool is unavailable. From the workspace root, run \`doklo show --json\`, then read the relevant Dok IDs with \`doklo show DOK-ID --json\`. Use the actual rules and code anchors in those Doks to guide source inspection. If the CLI is missing, the command is denied, or no relevant Dok exists, report that limitation and continue with source code. Do not claim a lookup succeeded without its result.

Drafts are unreviewed context; compare their claims with code. Reading context never authorizes generation, sync, approval, or production recording. For unrelated conversation, no Dok lookup is needed.
`;

export interface AgentSkillFileResult {
  path: string;
  status: 'preview' | 'installed' | 'unchanged' | 'removed' | 'absent';
  content?: string;
}

export interface AgentSkillOptions {
  root: string;
  target: string;
  action: AgentSkillAction;
  preview?: boolean;
}
export interface AgentSkillResult {
  target: AgentTarget;
  path: string;
  action: AgentSkillAction;
  status: 'preview' | 'installed' | 'unchanged' | 'removed' | 'absent';
  content?: string;
  files: AgentSkillFileResult[];
}
async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Never traverse project-local symlinks while installing or deleting. */
async function inspectPath(root: string, parts: string[]): Promise<void> {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = await statIfPresent(path);
    if (!stat) return;
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new AgentSkillError('unsafe_path', path);
    }
  }
}

export async function manageAgentSkill(opts: AgentSkillOptions): Promise<AgentSkillResult> {
  if (opts.target !== 'claude-code' && opts.target !== 'codex') {
    throw new AgentSkillError('invalid_target', opts.target);
  }
  const target: AgentTarget = opts.target;
  const root = await realpath(resolve(opts.root));
  const definitions = [
    { parts: [target === 'codex' ? '.agents' : '.claude', 'skills', 'doklo', 'SKILL.md'], content: DOKLO_AGENT_SKILL },
    ...(target === 'claude-code' ? [{ parts: ['.claude', 'rules', 'doklo.md'], content: DOKLO_CLAUDE_RULE }] : []),
  ];
  // Check every owned file before any mutation, including removal.
  for (const { parts, content } of definitions) {
    await inspectPath(root, parts);
    const path = join(root, ...parts);
    if (await statIfPresent(path) && await readFile(path, 'utf8') !== content) {
      throw new AgentSkillError('conflict', path);
    }
  }
  const files: AgentSkillFileResult[] = [];
  for (const { parts, content } of definitions) {
    const path = join(root, ...parts);
    if (opts.preview) {
      files.push({ path, status: 'preview', content });
      continue;
    }
    await inspectPath(root, parts);
    const stat = await statIfPresent(path);
    if (stat && await readFile(path, 'utf8') !== content) throw new AgentSkillError('conflict', path);
    if (opts.action === 'remove') {
      if (stat) await unlink(path);
      files.push({ path, status: stat ? 'removed' : 'absent' });
    } else if (stat) {
      files.push({ path, status: 'unchanged' });
    } else {
      await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
      await inspectPath(root, parts);
      try { await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AgentSkillError('conflict', path);
        throw error;
      }
      files.push({ path, status: 'installed' });
    }
  }
  const status = opts.preview ? 'preview'
    : opts.action === 'remove' ? (files.some(file => file.status === 'removed') ? 'removed' : 'absent')
    : files.some(file => file.status === 'installed') ? 'installed' : 'unchanged';
  return { target, path: files[0]!.path, action: opts.action, status, files,
    ...(opts.preview ? { content: DOKLO_AGENT_SKILL } : {}),
  };
}
