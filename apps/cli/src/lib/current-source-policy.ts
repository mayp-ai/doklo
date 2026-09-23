import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentSourcePathsSync, resolveContainedPath } from '@doklo-beta/core';

/** Cached provenance is not permission to read a file after ignore rules change. */
export async function validateCurrentSourceFiles(root: string, paths: Iterable<string>): Promise<void> {
  const requested = [...new Set(paths)];
  if (requested.length === 0) return;
  const cwd = await realpath(resolve(root));
  const available = currentSourcePathsSync(cwd);
  for (const file of requested) {
    if (!available.has(file)) {
      throw new Error(`Cached source is no longer permitted: ${file}. Rescan and consolidate before generating documentation.`);
    }
    const absolute = await resolveContainedPath(cwd, file);
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > 1024 * 1024) {
      throw new Error(`Cached source is no longer a supported text-source candidate: ${file}. Rescan and consolidate before generating documentation.`);
    }
  }
}
