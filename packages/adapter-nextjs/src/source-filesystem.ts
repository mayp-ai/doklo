import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InMemoryFileSystemHost } from 'ts-morph';
import { isSensitiveSourcePath, resolveContainedPathSync } from '@doklo-beta/core';

/** TypeScript may resolve imports, types and config extends while parsing. Give
 * it a snapshot of approved files so those implicit reads cannot reach disk.
 */
export function sourceFileSystem(rootDir: string, files: Iterable<string>): InMemoryFileSystemHost {
  const host = new InMemoryFileSystemHost();
  for (const file of files) {
    if (isSensitiveSourcePath(file)) continue;
    const absolute = resolveContainedPathSync(rootDir, file);
    host.writeFileSync(resolve(rootDir, file), readFileSync(absolute, 'utf8'));
  }
  return host;
}
