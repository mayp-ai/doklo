import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXCLUDED_SOURCE_DIRS, isExcludedSourcePath } from './source-policy.js';

/** Current path permission, without opening source contents. Never cache across commands. */
export function currentSourcePathsSync(projectRoot: string): Set<string> {
  const cwd = realpathSync(resolve(projectRoot));
  const options = { cwd, encoding: 'utf8' as const, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const git = (args: string[]) => execFileSync('git', args, options);
  let files: string[];
  try {
    git(['rev-parse', '--show-toplevel']);
    const listed = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const ignored = new Set(git(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z']).split('\0'));
    files = listed.split('\0').filter(file => !ignored.has(file));
  } catch (error) {
    if (!String((error as { stderr?: unknown }).stderr).includes('not a git repository')) throw error;
    const gitDir = mkdtempSync(join(tmpdir(), 'doklo-current-inventory-'));
    try {
      git(['init', '--bare', '--quiet', gitDir]);
      files = git([`--git-dir=${gitDir}`, `--work-tree=${cwd}`,
        'ls-files', '--others', '--exclude-standard', '-z',
        ...[...EXCLUDED_SOURCE_DIRS].map(dir => `--exclude=${dir}/`)]).split('\0');
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  }
  return new Set(files.filter(file => file && !isExcludedSourcePath(file)));
}
