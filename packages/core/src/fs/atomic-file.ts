import { randomUUID } from 'node:crypto';
import type { RmOptions } from 'node:fs';
import { link, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  createConfinedMutationOperations,
  nativeConfinedMutationFileSystem,
  type ContainedPathIdentity,
  type DirectoryPublishDestinationSnapshot,
  type PublishDirectoryContainedOptions,
} from './confined-mutation-internal.js';

export type WriteFileAtomicContainedOptions = {
  mode?: number;
  replace?: boolean;
  expectedIdentity?: ContainedPathIdentity;
};

export type RemoveContainedOptions = RmOptions & {
  expectedIdentity?: ContainedPathIdentity;
};

export type UnlinkContainedOptions = {
  expectedIdentity?: ContainedPathIdentity;
};
export type {
  ContainedPathIdentity,
  DirectoryPublishDestinationSnapshot,
  PublishDirectoryContainedOptions,
};

const confinedMutations = createConfinedMutationOperations(
  nativeConfinedMutationFileSystem,
);

export async function captureContainedPathIdentity(
  root: string,
  relativePath: string,
  options: { allowMissingLeaf?: boolean } = {},
): Promise<ContainedPathIdentity> {
  return confinedMutations.captureContainedPathIdentity(
    root,
    relativePath,
    options,
  );
}

export async function assertContainedPathIdentity(
  root: string,
  relativePath: string,
  expected: ContainedPathIdentity,
): Promise<void> {
  await confinedMutations.assertContainedPathIdentity(
    root,
    relativePath,
    expected,
  );
}

export async function writeFileAtomicContained(
  root: string,
  relativePath: string,
  bytes: string | Uint8Array,
  options: WriteFileAtomicContainedOptions = {},
): Promise<void> {
  await confinedMutations.writeFileAtomicContained(
    root,
    relativePath,
    bytes,
    options,
  );
}

export async function unlinkContained(
  root: string,
  relativePath: string,
  options: UnlinkContainedOptions = {},
): Promise<void> {
  await confinedMutations.unlinkContained(root, relativePath, options);
}

export async function removeContained(
  root: string,
  relativePath: string,
  options: RemoveContainedOptions = {},
): Promise<void> {
  await confinedMutations.removeContained(root, relativePath, options);
}

export async function publishDirectoryContained(
  root: string,
  stagedRelativePath: string,
  destinationRelativePath: string,
  options: PublishDirectoryContainedOptions = {},
): Promise<void> {
  await confinedMutations.publishDirectoryContained(
    root,
    stagedRelativePath,
    destinationRelativePath,
    options,
  );
}

export async function captureDirectoryPublishDestination(
  root: string,
  destinationRelativePath: string,
): Promise<DirectoryPublishDestinationSnapshot> {
  return confinedMutations.captureDirectoryPublishDestination(
    root,
    destinationRelativePath,
  );
}

export async function writeFileAtomic(
  destination: string,
  bytes: string | Uint8Array,
  options: { mode?: number; replace?: boolean } = {},
): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', options.mode ?? 0o666);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.replace === false) {
      await link(temporary, destination);
      await rm(temporary, { force: true });
    } else {
      await rename(temporary, destination);
    }
    const directory = await open(dirname(destination), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
