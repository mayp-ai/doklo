import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { SourceRepository } from './source-repository-shared';


function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolveOutput(stdout);
    });
  });
}

function githubRepository(remote: string): string | null {
  const trimmed = remote.trim();
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const segments = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/');
    if (segments.length !== 2 || segments.some((segment) => !segment || /\s/.test(segment))) return null;
    return `${segments[0]}/${segments[1]}`;
  } catch {
    return null;
  }
}

export async function readSourceRepository(workspacePath: string): Promise<SourceRepository | null> {
  try {
    const cwd = await realpath(resolve(workspacePath));
    const [rootOut, remoteOut, commitOut] = await Promise.all([
      git(cwd, ['rev-parse', '--show-toplevel']),
      git(cwd, ['remote', 'get-url', 'origin']),
      git(cwd, ['rev-parse', 'HEAD']),
    ]);
    const repository = githubRepository(remoteOut);
    const commit = commitOut.trim();
    const root = rootOut.trim();
    const workspacePrefix = relative(root, cwd).replace(/\\/g, '/');
    if (repository === null || !/^[0-9a-f]{40}$/i.test(commit)) return null;
    if (workspacePrefix.split('/').includes('..')) return null;
    return { repository, commit: commit.toLowerCase(), workspacePrefix: workspacePrefix === '.' ? '' : workspacePrefix };
  } catch {
    return null;
  }
}
