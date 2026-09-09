import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { resolveContainedOutputPath } from '@doklo-beta/generator';
import { loadWorkspaceWithPaths } from './workspace.js';
import { writeTextFileAtomic } from './atomic-file.js';
import { CommandContractError } from './command-result.js';
import { createContext, resolveLocale } from './context.js';
const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}
function fail(code: string, key: string, args: Record<string, string> = {}): never {
  throw new CommandContractError({ schema_version: 1, command: 'recording', status: 'failed', data: null,
    diagnostics: [{ code, message: createContext(resolveLocale()).t(key, args) }] }, 1);
}
export async function listRecordingBranches(root: string): Promise<string[]> {
  try {
    return (await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'))
      .split('\n').filter(Boolean).sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  } catch { return []; }
}
export async function validateRecordingBranch(root: string, branch: string): Promise<string> {
  try {
    await git(root, 'check-ref-format', `refs/heads/${branch}`);
    return await git(root, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
  } catch { return fail('RECORDING_BRANCH_INVALID', 'recording.invalid', { branch }); }
}
export async function setRecordingBranch(root: string, branch: string): Promise<void> {
  const { paths } = await loadWorkspaceWithPaths(root);
  await validateRecordingBranch(paths.root, branch);
  const file = await resolveContainedOutputPath(paths.root, 'workspace.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.recording_branch = branch;
  await writeTextFileAtomic(file, JSON.stringify(raw, null, 2) + '\n');
}
export interface RecordingSource { branch: string; commit: string; sourceDigest: string; workspaceDigest: string }
export async function assertRecordingSource(root: string): Promise<RecordingSource | undefined> {
  const { workspace, paths } = await loadWorkspaceWithPaths(root);
  if (!workspace.recording_branch) return undefined;
  const branch = workspace.recording_branch;
  const commit = await validateRecordingBranch(paths.root, branch);
  let current: string;
  try { current = await git(paths.root, 'symbolic-ref', '--short', 'HEAD'); }
  catch { return fail('RECORDING_BRANCH_MISMATCH', 'recording.mismatch', { branch }); }
  if (current !== branch) fail('RECORDING_BRANCH_MISMATCH', 'recording.mismatch', { branch });
  const specs = ['.', ':!workspace.json', ':!.doklo', ':!.agents/skills/doklo', ':!.claude/skills/doklo', ':!.claude/rules/doklo.md'];
  const changed = await git(paths.root, 'diff', '--ignore-submodules=none', '--name-only', 'HEAD', '--', ...specs);
  const untracked = await git(paths.root, 'ls-files', '--others', '--exclude-standard', '--', ...specs);
  if (changed || untracked) fail('RECORDING_SOURCE_DIRTY', 'recording.dirty', { branch });
  const workspaceDigest = createHash('sha256').update(JSON.stringify(workspace)).digest('hex');
  const sourceDigest = createHash('sha256').update(await git(paths.root, 'ls-files', '--stage', '-z', '--', ...specs)).digest('hex');
  return { branch, commit, sourceDigest, workspaceDigest };
}
type Stage = 'scan' | 'consolidate';
function stampName(stage: Stage, service: string): string { return `.doklo/cache/recording-${stage}-${service}.json`; }
export async function recordCacheSource(root: string, stage: Stage, service: string, file: string, source: RecordingSource | undefined): Promise<void> {
  if (!source) return;
  const current = await assertRecordingSource(root);
  if (current?.sourceDigest !== source.sourceDigest || current?.workspaceDigest !== source.workspaceDigest) fail('RECORDING_SOURCE_MOVED', 'recording.moved');
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  const target = await resolveContainedOutputPath(root, stampName(stage, service));
  await writeTextFileAtomic(target, JSON.stringify({ ...source, digest }) + '\n');
}
export async function assertCacheSource(root: string, stage: Stage, service: string, file: string, source: RecordingSource | undefined): Promise<void> {
  if (!source) return;
  try {
    const stamp = JSON.parse(await readFile(join(root, stampName(stage, service)), 'utf8'));
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (stamp.branch === source.branch && stamp.sourceDigest === source.sourceDigest && stamp.workspaceDigest === source.workspaceDigest && stamp.digest === digest) return;
  } catch { /* Missing or unreadable provenance is not trusted. */ }
  fail('RECORDING_CACHE_OUTDATED', 'recording.cache', { command: `doklo ${stage} --service ${service}`, file: relative(root, file) });
}
