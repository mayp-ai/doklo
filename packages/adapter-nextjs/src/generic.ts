import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolveContainedPath, isExcludedSourcePath, type ProjectIR } from '@doklo-beta/core';
import type { ParserFileLedgerEntry } from './legacy-types.js';

const exec = promisify(execFile);
const MAX_TEXT_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', '.doklo', '.claude', '.codex', '.agents', '.worktrees',
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', 'target', 'vendor', '.idea', '.vscode']);

/** Read source text without assuming a language, framework or route convention. */
export async function extractGenericIR({ rootDir }: { rootDir: string }): Promise<ProjectIR> {
  const root = await realpath(resolve(rootDir));
  let candidates: string[];
  try {
    // Git supplies tracked plus untracked files and applies nested .gitignore rules.
    await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    const result = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root, maxBuffer: 16 * 1024 * 1024,
    });
    const ignored = await exec('git', ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'], {
      cwd: root, maxBuffer: 16 * 1024 * 1024,
    });
    const ignoredFiles = new Set(ignored.stdout.split('\0').filter(Boolean));
    candidates = result.stdout.split('\0').filter(file => file && !ignoredFiles.has(file));
  } catch (error) {
    // Only absence of a repository permits filesystem discovery. Other Git failures
    // must not silently expand the scan beyond the user's ignored source set.
    if (!String((error as { stderr?: string }).stderr).includes('not a git repository')) throw error;
    // A disposable Git directory lets Git apply its own nested ignore semantics
    // to a downloaded source tree without creating .git inside that tree.
    const gitDir = await mkdtemp(join(tmpdir(), 'doklo-inventory-'));
    try {
      await exec('git', ['init', '--bare', '--quiet', gitDir]);
      const result = await exec('git', [`--git-dir=${gitDir}`, `--work-tree=${root}`,
        'ls-files', '--others', '--exclude-standard', '-z',
        ...[...IGNORED_DIRS].map(dir => `--exclude=${dir}/`)], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      candidates = result.stdout.split('\0').filter(Boolean);
    } finally {
      await rm(gitDir, { recursive: true, force: true });
    }
  }
  const files: string[] = [];
  const ledger: ParserFileLedgerEntry[] = [];
  for (const file of [...new Set(candidates)].sort()) {
    if (isExcludedSourcePath(file)) continue;
    let absolute: string;
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      absolute = await resolveContainedPath(root, file);
      info = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ledger.push({ file, status: 'excluded', stages: ['discovery'], reason: 'MISSING_TRACKED_FILE' });
      continue;
    }
    // Do not follow directory aliases or special files. Source symlinks within the
    // root are excluded as aliases; containment above rejects external targets.
    if (!info.isFile()) {
      ledger.push({ file, status: 'excluded', stages: ['discovery'], reason: 'NOT_REGULAR_FILE' });
      continue;
    }
    if (info.size > MAX_TEXT_BYTES) {
      ledger.push({ file, status: 'excluded', stages: ['discovery'], reason: 'FILE_TOO_LARGE' });
      continue;
    }
    const content = await readFile(absolute);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
    catch { text = '\0'; }
    if (text.includes('\0')) {
      ledger.push({ file, status: 'excluded', stages: ['discovery'], reason: 'BINARY_OR_NON_UTF8' });
      continue;
    }
    files.push(file);
    ledger.push({ file, status: 'processed', stages: ['discovery'], reason: 'TEXT_SOURCE' });
  }
  const groups = new Map<string, string[]>();
  for (const file of files) {
    // A bounded service fits the generator's 24-source excerpt budget. Keep
    // its data and handlers together instead of inventing a feature per folder.
    const directory = files.length <= 24 ? '.' : dirname(file);
    const group = groups.get(directory) ?? [];
    group.push(file);
    groups.set(directory, group);
  }
  return {
    framework: 'unknown', root, files, routes: [], components: [], stores: [], role_signals: [],
    analysis_units: [...groups].map(([directory, members]) => ({
      id: `source-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`,
      label: directory === '.' ? 'Project source' : directory,
      files: members,
    })),
    framework_specific: { analysis_strategy: 'generic-files-v1', file_ledger: ledger },
  };
}
