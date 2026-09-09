import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveContainedPath, type ContainedPathOptions } from '@doklo-beta/core';

export class TemplatePathError extends Error {
  constructor(readonly label: string, message: string, options?: ErrorOptions) {
    super(`${label}: ${message}`, options);
    this.name = 'TemplatePathError';
  }
}

export function assertSafeTemplateSegment(value: string, label: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new TemplatePathError(label, 'must be a single lowercase path segment');
  }
  return value;
}

export async function resolveTemplatePath(
  root: string,
  relativePath: string,
  label: string,
  options?: ContainedPathOptions,
): Promise<string> {
  try {
    return await resolveContainedPath(root, relativePath, options);
  } catch (cause) {
    throw new TemplatePathError(label, 'path is not contained by its declared root', { cause });
  }
}

export async function assertTemplateTreeHasNoSymlinks(root: string, label: string): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new TemplatePathError(label, `symlink is forbidden: ${path}`);
    if (!stat.isDirectory()) return;
    for (const entry of await readdir(path)) await visit(join(path, entry));
  };
  await visit(root);
}
