import { resolveContainedPath as resolveSharedContainedPath } from '@doklo-beta/core';

export {
  PathOutsideRootError,
  resolveContainedPath,
} from '@doklo-beta/core';

export async function resolveContainedOutputPath(
  root: string,
  relativePath: string,
): Promise<string> {
  return resolveSharedContainedPath(root, relativePath, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
}
