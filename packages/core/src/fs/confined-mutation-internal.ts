import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type RmOptions } from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  PathIdentityChangedError,
  PathOutsideRootError,
  resolveContainedPath,
  type ConfinedMutationOperation,
} from './path-containment.js';

type AtomicContainedWriteOptions = {
  mode?: number;
  replace?: boolean;
  expectedIdentity?: ContainedPathIdentity;
};

declare const containedPathIdentityBrand: unique symbol;

export type ContainedPathIdentity = {
  readonly [containedPathIdentityBrand]: true;
};

type RemoveContainedOptions = RmOptions & {
  expectedIdentity?: ContainedPathIdentity;
};

type UnlinkContainedOptions = {
  expectedIdentity?: ContainedPathIdentity;
};

/**
 * Stable identity of the destination directory entry. Callers remain
 * responsible for validating the directory's owned contents separately.
 */
export type DirectoryPublishDestinationSnapshot = (
  | { exists: false }
  | {
    exists: true;
    realPath: string;
    device: string;
    inode: string;
  }
);

export type PublishDirectoryContainedOptions = {
  /**
   * Destination expectation rechecked inside the confined publish barrier.
   * This narrows caller-to-core TOCTOU; it is not an OS-native no-replace/CAS.
   * Callers that rely on this expectation as a safety boundary must hold
   * exclusive writer ownership of the destination while publish runs.
   */
  expectedDestination?: DirectoryPublishDestinationSnapshot;
  expectedStagedIdentity?: ContainedPathIdentity;
};

export type ConfinedMutationBarrierContext = {
  operation: ConfinedMutationOperation;
  root: string;
  relativePath: string;
  parent: string;
  destination: string;
  temporary?: string;
  staged?: string;
  backup?: string;
  mutation?: DirectoryPublishMutation;
};

type DirectoryPublishMutation =
  | 'move-destination-to-backup'
  | 'move-stage-to-destination'
  | 'remove-backup'
  | 'rollback-destination-to-stage'
  | 'rollback-backup-to-destination';

/** Private dependency boundary for deterministic identity-swap tests. */
export type ConfinedMutationFileSystem = {
  directorySync: 'supported' | 'unsupported';
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  beforeFinalMutation?(context: ConfinedMutationBarrierContext): Promise<void>;
};

export const nativeConfinedMutationFileSystem: ConfinedMutationFileSystem = {
  directorySync: process.platform === 'win32' ? 'unsupported' : 'supported',
  lstat: (path) => lstat(path, { bigint: true }),
  realpath: (path) => realpath(path),
  open: (path, flags, mode) => open(path, flags, mode),
  link: (existingPath, newPath) => link(existingPath, newPath),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  unlink: (path) => unlink(path),
  rm: (path, options) => rm(path, options),
};

type ExistingPathIdentity = {
  exists: true;
  stable: true;
  realPath: string;
  device: string;
  inode: string;
  fileType: number;
};

type UnstablePathIdentity = {
  exists: true;
  stable: false;
  realPath: string;
  fileType: number;
};

type MissingPathIdentity = {
  exists: false;
};

type PathIdentity = (
  ExistingPathIdentity
  | UnstablePathIdentity
  | MissingPathIdentity
);

type AuthorizedMutation = {
  operation: ConfinedMutationOperation;
  relativePath: string;
  lexicalRoot: string;
  physicalRoot: string;
  parent: string;
  destination: string;
  rootIdentity: ExistingPathIdentity;
  parentIdentity: ExistingPathIdentity;
  destinationIdentity: PathIdentity;
};

type CapturedContainedPathIdentity = {
  lexicalRoot: string;
  physicalRoot: string;
  relativePath: string;
  parent: string;
  destination: string;
  rootIdentity: ExistingPathIdentity;
  parentIdentity: ExistingPathIdentity;
  destinationIdentity: PathIdentity;
  allowMissingLeaf: boolean;
};

const capturedContainedPathIdentities = new WeakMap<
  ContainedPathIdentity,
  CapturedContainedPathIdentity
>();

export function createConfinedMutationOperations(fileSystem: ConfinedMutationFileSystem) {
  return {
    captureContainedPathIdentity: async (
      root: string,
      relativePath: string,
      options: { allowMissingLeaf?: boolean } = {},
    ): Promise<ContainedPathIdentity> => captureContainedPathIdentityWith(
      fileSystem,
      root,
      relativePath,
      options,
    ),
    assertContainedPathIdentity: async (
      root: string,
      relativePath: string,
      expected: ContainedPathIdentity,
    ): Promise<void> => assertContainedPathIdentityWith(
      fileSystem,
      root,
      relativePath,
      expected,
    ),
    writeFileAtomicContained: async (
      root: string,
      relativePath: string,
      bytes: string | Uint8Array,
      options: AtomicContainedWriteOptions = {},
    ): Promise<void> => writeFileAtomicContainedWith(
      fileSystem,
      root,
      relativePath,
      bytes,
      options,
    ),
    unlinkContained: async (
      root: string,
      relativePath: string,
      options: UnlinkContainedOptions = {},
    ): Promise<void> => {
      await removeEntryContainedWith(
        fileSystem,
        'unlink',
        root,
        relativePath,
        options,
      );
    },
    removeContained: async (
      root: string,
      relativePath: string,
      options: RemoveContainedOptions = {},
    ): Promise<void> => {
      await removeEntryContainedWith(
        fileSystem,
        'remove',
        root,
        relativePath,
        options,
      );
    },
    captureDirectoryPublishDestination: async (
      root: string,
      destinationRelativePath: string,
    ): Promise<DirectoryPublishDestinationSnapshot> => (
      captureDirectoryPublishDestinationWith(
        fileSystem,
        root,
        destinationRelativePath,
      )
    ),
    publishDirectoryContained: async (
      root: string,
      stagedRelativePath: string,
      destinationRelativePath: string,
      options: PublishDirectoryContainedOptions = {},
    ): Promise<void> => {
      await publishDirectoryContainedWith(
        fileSystem,
        root,
        stagedRelativePath,
        destinationRelativePath,
        options,
      );
    },
  };
}

type AuthorizedDirectoryPublish = {
  authorized: AuthorizedMutation;
  staged: string;
  stagedIdentity: ExistingPathIdentity;
  backup: string;
};

type DirectoryPublishState = {
  stagedIdentity: PathIdentity;
  destinationIdentity: PathIdentity;
  backupIdentity: PathIdentity;
  destinationBackedUp: boolean;
  stagePublished: boolean;
  publicationCommitted: boolean;
};

async function publishDirectoryContainedWith(
  fileSystem: ConfinedMutationFileSystem,
  root: string,
  stagedRelativePath: string,
  destinationRelativePath: string,
  options: PublishDirectoryContainedOptions,
): Promise<void> {
  const publish = await authorizeDirectoryPublish(
    fileSystem,
    root,
    stagedRelativePath,
    destinationRelativePath,
    options.expectedStagedIdentity,
  );
  const { authorized } = publish;
  assertExpectedDirectoryPublishDestination(
    authorized,
    options.expectedDestination,
  );
  const destinationExisted = authorized.destinationIdentity.exists;
  const state: DirectoryPublishState = {
    stagedIdentity: publish.stagedIdentity,
    destinationIdentity: authorized.destinationIdentity,
    backupIdentity: { exists: false },
    destinationBackedUp: false,
    stagePublished: false,
    publicationCommitted: false,
  };

  try {
    if (destinationExisted) {
      await directoryPublishBarrier(
        fileSystem,
        publish,
        'move-destination-to-backup',
      );
      await assertDirectoryPublishState(fileSystem, publish, state);
      await fileSystem.rename(authorized.destination, publish.backup);
      state.destinationBackedUp = true;
      state.destinationIdentity = { exists: false };
      state.backupIdentity = await snapshotExistingPath(
        fileSystem,
        publish.backup,
      );
      if (
        !isStableExistingIdentity(state.backupIdentity)
        || !sameFilesystemObject(
          authorized.destinationIdentity as ExistingPathIdentity,
          state.backupIdentity,
        )
      ) {
        throw identityChanged(authorized);
      }
      await assertDirectoryPublishState(fileSystem, publish, state);
    }

    await directoryPublishBarrier(
      fileSystem,
      publish,
      'move-stage-to-destination',
    );
    await assertDirectoryPublishState(fileSystem, publish, state);
    await fileSystem.rename(publish.staged, authorized.destination);
    state.stagePublished = true;
    state.stagedIdentity = { exists: false };
    state.destinationIdentity = await snapshotExistingPath(
      fileSystem,
      authorized.destination,
    );
    if (
      !isStableExistingIdentity(state.destinationIdentity)
      || !sameFilesystemObject(
        publish.stagedIdentity,
        state.destinationIdentity,
      )
    ) {
      throw identityChanged(authorized);
    }
    await assertDirectoryPublishState(fileSystem, publish, state);
    await syncParentDirectory(fileSystem, authorized);

    if (state.destinationBackedUp) {
      await directoryPublishBarrier(fileSystem, publish, 'remove-backup');
      await assertDirectoryPublishState(fileSystem, publish, state);
      // Backup cleanup is destructive and can fail after removing only part of
      // the old tree. From this point onward the complete new destination is
      // authoritative and must never be rolled back from a partial backup.
      state.publicationCommitted = true;
      await fileSystem.rm(publish.backup, { recursive: true });
      state.destinationBackedUp = false;
      state.backupIdentity = { exists: false };
      await syncParentDirectory(fileSystem, authorized);
    }
  } catch (error) {
    await rollbackDirectoryPublish(
      fileSystem,
      publish,
      state,
    );
    throw error;
  }
}

async function captureDirectoryPublishDestinationWith(
  fileSystem: ConfinedMutationFileSystem,
  root: string,
  destinationRelativePath: string,
): Promise<DirectoryPublishDestinationSnapshot> {
  const authorized = await authorizeMutation(
    fileSystem,
    'publish-directory',
    root,
    destinationRelativePath,
    true,
  );
  if (!authorized.destinationIdentity.exists) return { exists: false };
  if (
    !isStableExistingIdentity(authorized.destinationIdentity)
    || authorized.destinationIdentity.fileType !== constants.S_IFDIR
  ) {
    throw identityChanged(authorized);
  }
  return directoryPublishDestinationSnapshot(
    authorized.destinationIdentity,
  );
}

function assertExpectedDirectoryPublishDestination(
  authorized: AuthorizedMutation,
  expected: DirectoryPublishDestinationSnapshot | undefined,
): void {
  if (expected === undefined) return;
  const current = authorized.destinationIdentity;
  if (!expected.exists) {
    if (current.exists) throw identityChanged(authorized);
    return;
  }
  if (
    !isStableExistingIdentity(current)
    || current.realPath !== expected.realPath
    || current.device !== expected.device
    || current.inode !== expected.inode
  ) {
    throw identityChanged(authorized);
  }
}

function directoryPublishDestinationSnapshot(
  identity: ExistingPathIdentity,
): DirectoryPublishDestinationSnapshot {
  return {
    exists: true,
    realPath: identity.realPath,
    device: identity.device,
    inode: identity.inode,
  };
}

async function authorizeDirectoryPublish(
  fileSystem: ConfinedMutationFileSystem,
  root: string,
  stagedRelativePath: string,
  destinationRelativePath: string,
  expectedStagedIdentity: ContainedPathIdentity | undefined,
): Promise<AuthorizedDirectoryPublish> {
  const authorized = await authorizeMutation(
    fileSystem,
    'publish-directory',
    root,
    destinationRelativePath,
    true,
  );
  const stagedAuthorized = await authorizeMutation(
    fileSystem,
    'publish-directory',
    root,
    stagedRelativePath,
    expectedStagedIdentity !== undefined,
  );
  if (expectedStagedIdentity !== undefined) {
    assertAuthorizedContainedPathIdentity(
      stagedAuthorized,
      expectedStagedIdentity,
    );
  }
  const staged = stagedAuthorized.destination;
  if (
    staged === authorized.destination
    || dirname(staged) !== authorized.parent
  ) {
    throw new PathOutsideRootError(root, stagedRelativePath);
  }
  const stagedIdentity = stagedAuthorized.destinationIdentity;
  if (
    !isStableExistingIdentity(stagedIdentity)
    || stagedIdentity.realPath !== staged
    || stagedIdentity.fileType !== constants.S_IFDIR
    || (
      authorized.destinationIdentity.exists
      && authorized.destinationIdentity.fileType !== constants.S_IFDIR
    )
  ) {
    throw identityChanged(authorized);
  }
  const backup = join(
    authorized.parent,
    `.${basename(authorized.destination)}.backup-${process.pid}-${randomUUID()}`,
  );
  const backupIdentity = await snapshotPath(fileSystem, backup, true);
  if (backupIdentity.exists) throw identityChanged(authorized);

  return {
    authorized,
    staged,
    stagedIdentity,
    backup,
  };
}

async function assertDirectoryPublishState(
  fileSystem: ConfinedMutationFileSystem,
  publish: AuthorizedDirectoryPublish,
  state: DirectoryPublishState,
): Promise<void> {
  await assertRootAndParentIdentities(fileSystem, publish.authorized);
  await assertIdentity(
    fileSystem,
    publish.staged,
    state.stagedIdentity,
    publish.authorized,
  );
  await assertIdentity(
    fileSystem,
    publish.authorized.destination,
    state.destinationIdentity,
    publish.authorized,
  );
  await assertIdentity(
    fileSystem,
    publish.backup,
    state.backupIdentity,
    publish.authorized,
  );
}

async function directoryPublishBarrier(
  fileSystem: ConfinedMutationFileSystem,
  publish: AuthorizedDirectoryPublish,
  mutation: DirectoryPublishMutation,
): Promise<void> {
  await fileSystem.beforeFinalMutation?.({
    ...barrierContext(publish.authorized),
    staged: publish.staged,
    backup: publish.backup,
    mutation,
  });
}

async function rollbackDirectoryPublish(
  fileSystem: ConfinedMutationFileSystem,
  publish: AuthorizedDirectoryPublish,
  state: DirectoryPublishState,
): Promise<void> {
  try {
    if (state.publicationCommitted) return;
    if (state.stagePublished) {
      await directoryPublishBarrier(
        fileSystem,
        publish,
        'rollback-destination-to-stage',
      );
      await assertDirectoryPublishState(fileSystem, publish, state);
      await fileSystem.rename(
        publish.authorized.destination,
        publish.staged,
      );
      state.stagePublished = false;
      state.destinationIdentity = { exists: false };
      state.stagedIdentity = await snapshotExistingPath(
        fileSystem,
        publish.staged,
      );
      if (
        !isStableExistingIdentity(state.stagedIdentity)
        || !sameFilesystemObject(
          publish.stagedIdentity,
          state.stagedIdentity,
        )
      ) return;
      await assertDirectoryPublishState(fileSystem, publish, state);
    }

    if (state.destinationBackedUp) {
      await directoryPublishBarrier(
        fileSystem,
        publish,
        'rollback-backup-to-destination',
      );
      await assertDirectoryPublishState(fileSystem, publish, state);
      await fileSystem.rename(
        publish.backup,
        publish.authorized.destination,
      );
      state.destinationBackedUp = false;
      state.backupIdentity = { exists: false };
      state.destinationIdentity = await snapshotExistingPath(
        fileSystem,
        publish.authorized.destination,
      );
      if (
        !isStableExistingIdentity(state.destinationIdentity)
        || !authorizedDestinationRestored(publish, state.destinationIdentity)
      ) return;
      await assertDirectoryPublishState(fileSystem, publish, state);
      await syncParentDirectory(fileSystem, publish.authorized);
    }
  } catch {
    // Rollback must not traverse a changed path or mask the publish failure.
  }
}

function authorizedDestinationRestored(
  publish: AuthorizedDirectoryPublish,
  destinationIdentity: ExistingPathIdentity,
): boolean {
  return isStableExistingIdentity(publish.authorized.destinationIdentity)
    && sameFilesystemObject(
      publish.authorized.destinationIdentity,
      destinationIdentity,
    );
}

async function captureContainedPathIdentityWith(
  fileSystem: ConfinedMutationFileSystem,
  root: string,
  relativePath: string,
  options: { allowMissingLeaf?: boolean },
): Promise<ContainedPathIdentity> {
  const allowMissingLeaf = options.allowMissingLeaf === true;
  const authorized = await authorizeMutation(
    fileSystem,
    'write',
    root,
    relativePath,
    allowMissingLeaf,
  );
  const token = Object.freeze({}) as ContainedPathIdentity;
  capturedContainedPathIdentities.set(token, {
    lexicalRoot: authorized.lexicalRoot,
    physicalRoot: authorized.physicalRoot,
    relativePath: authorized.relativePath,
    parent: authorized.parent,
    destination: authorized.destination,
    rootIdentity: authorized.rootIdentity,
    parentIdentity: authorized.parentIdentity,
    destinationIdentity: authorized.destinationIdentity,
    allowMissingLeaf,
  });
  return token;
}

async function assertContainedPathIdentityWith(
  fileSystem: ConfinedMutationFileSystem,
  root: string,
  relativePath: string,
  expected: ContainedPathIdentity,
): Promise<void> {
  const captured = capturedContainedPathIdentity(
    expected,
    relativePath,
    'write',
  );
  let authorized: AuthorizedMutation;
  try {
    authorized = await authorizeMutation(
      fileSystem,
      'write',
      root,
      relativePath,
      captured.allowMissingLeaf,
    );
  } catch (error) {
    if (error instanceof PathIdentityChangedError) throw error;
    if (error instanceof PathOutsideRootError || isMissingPathError(error)) {
      throw new PathIdentityChangedError(relativePath, 'write');
    }
    throw error;
  }
  assertAuthorizedContainedPathIdentity(authorized, expected);
}

function assertAuthorizedContainedPathIdentity(
  authorized: AuthorizedMutation,
  expected: ContainedPathIdentity,
): void {
  const captured = capturedContainedPathIdentity(
    expected,
    authorized.relativePath,
    authorized.operation,
  );
  if (
    captured.lexicalRoot !== authorized.lexicalRoot
    || captured.physicalRoot !== authorized.physicalRoot
    || captured.relativePath !== authorized.relativePath
    || captured.parent !== authorized.parent
    || captured.destination !== authorized.destination
    || !sameIdentity(captured.rootIdentity, authorized.rootIdentity)
    || !sameIdentity(captured.parentIdentity, authorized.parentIdentity)
    || !sameIdentity(
      captured.destinationIdentity,
      authorized.destinationIdentity,
    )
  ) {
    throw identityChanged(authorized);
  }
}

function capturedContainedPathIdentity(
  expected: ContainedPathIdentity,
  relativePath: string,
  operation: ConfinedMutationOperation,
): CapturedContainedPathIdentity {
  const captured = capturedContainedPathIdentities.get(expected);
  if (captured === undefined) {
    throw new PathIdentityChangedError(relativePath, operation);
  }
  return captured;
}

async function writeFileAtomicContainedWith(
  fileSystem: ConfinedMutationFileSystem,
  root: string,
  relativePath: string,
  bytes: string | Uint8Array,
  options: AtomicContainedWriteOptions,
): Promise<void> {
  const authorized = await authorizeMutation(
    fileSystem,
    'write',
    root,
    relativePath,
    true,
  );
  if (options.expectedIdentity !== undefined) {
    assertAuthorizedContainedPathIdentity(authorized, options.expectedIdentity);
  }
  const temporary = join(
    authorized.parent,
    `.${basename(authorized.destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: ExistingPathIdentity | undefined;
  let published = false;

  try {
    const flags = constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0);
    handle = await fileSystem.open(temporary, flags, options.mode ?? 0o666);
    const handleIdentity = identityFromStats(
      await handle.stat({ bigint: true }),
      temporary,
    );
    const observedTemporary = await snapshotExistingPath(fileSystem, temporary);
    if (
      !isStableExistingIdentity(handleIdentity)
      || !isStableExistingIdentity(observedTemporary)
      || !sameIdentity(handleIdentity, observedTemporary)
    ) {
      throw identityChanged(authorized);
    }
    temporaryIdentity = observedTemporary;

    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await fileSystem.beforeFinalMutation?.(barrierContext(authorized, temporary));
    await assertAuthorizedIdentities(fileSystem, authorized);
    await assertIdentity(fileSystem, temporary, temporaryIdentity, authorized);

    if (options.replace === false) {
      await fileSystem.link(temporary, authorized.destination);
      const publishedIdentity = await snapshotExistingPath(
        fileSystem,
        authorized.destination,
      );
      if (
        !isStableExistingIdentity(publishedIdentity)
        || !sameFilesystemObject(temporaryIdentity, publishedIdentity)
      ) {
        throw identityChanged(authorized);
      }
      await assertRootAndParentIdentities(fileSystem, authorized);
      await assertIdentity(fileSystem, temporary, temporaryIdentity, authorized);
      await fileSystem.unlink(temporary);
    } else {
      await fileSystem.rename(temporary, authorized.destination);
    }
    published = true;

    await syncParentDirectory(fileSystem, authorized);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published && temporaryIdentity) {
      await cleanupTemporaryIfSafe(
        fileSystem,
        authorized,
        temporary,
        temporaryIdentity,
      );
    }
  }
}

async function removeEntryContainedWith(
  fileSystem: ConfinedMutationFileSystem,
  operation: 'unlink' | 'remove',
  root: string,
  relativePath: string,
  options: RemoveContainedOptions | UnlinkContainedOptions = {},
): Promise<void> {
  const { expectedIdentity, ...removeOptions } = (
    options as RemoveContainedOptions
  );
  const allowMissing = operation === 'remove'
    && removeOptions.force === true;
  const authorized = await authorizeMutation(
    fileSystem,
    operation,
    root,
    relativePath,
    allowMissing || expectedIdentity !== undefined,
  );
  if (expectedIdentity !== undefined) {
    assertAuthorizedContainedPathIdentity(authorized, expectedIdentity);
  }

  await fileSystem.beforeFinalMutation?.(barrierContext(authorized));
  await assertAuthorizedIdentities(fileSystem, authorized);
  if (operation === 'unlink') {
    await fileSystem.unlink(authorized.destination);
  } else {
    await fileSystem.rm(authorized.destination, removeOptions);
  }
  await syncParentDirectory(fileSystem, authorized);
}

async function authorizeMutation(
  fileSystem: ConfinedMutationFileSystem,
  operation: ConfinedMutationOperation,
  root: string,
  relativePath: string,
  allowMissingLeaf: boolean,
): Promise<AuthorizedMutation> {
  const lexicalRoot = resolve(root);
  const destination = await resolveContainedPath(lexicalRoot, relativePath, {
    allowMissingLeaf,
    rejectSymlinkLeaf: true,
  });
  const physicalRoot = await fileSystem.realpath(lexicalRoot);
  if (destination === physicalRoot || !isContained(physicalRoot, destination)) {
    throw new PathOutsideRootError(lexicalRoot, relativePath);
  }
  const parent = dirname(destination);
  const observedRoot = await snapshotExistingPath(fileSystem, lexicalRoot);
  const observedParent = await snapshotExistingPath(fileSystem, parent);
  const destinationIdentity = await snapshotPath(
    fileSystem,
    destination,
    allowMissingLeaf,
  );
  if (
    !isStableExistingIdentity(observedRoot)
    || !isStableExistingIdentity(observedParent)
    || (destinationIdentity.exists && !destinationIdentity.stable)
    || observedRoot.realPath !== physicalRoot
    || observedParent.realPath !== parent
    || !isContained(physicalRoot, observedParent.realPath)
    || (
      destinationIdentity.exists
      && (
        destinationIdentity.realPath !== destination
        || !isContained(physicalRoot, destinationIdentity.realPath)
      )
    )
  ) {
    throw new PathIdentityChangedError(relativePath, operation);
  }
  const rootIdentity = observedRoot;
  const parentIdentity = observedParent;

  return {
    operation,
    relativePath,
    lexicalRoot,
    physicalRoot,
    parent,
    destination,
    rootIdentity,
    parentIdentity,
    destinationIdentity,
  };
}

async function assertAuthorizedIdentities(
  fileSystem: ConfinedMutationFileSystem,
  authorized: AuthorizedMutation,
): Promise<void> {
  await assertRootAndParentIdentities(fileSystem, authorized);
  await assertIdentity(
    fileSystem,
    authorized.destination,
    authorized.destinationIdentity,
    authorized,
  );
}

async function assertRootAndParentIdentities(
  fileSystem: ConfinedMutationFileSystem,
  authorized: AuthorizedMutation,
): Promise<void> {
  await assertIdentity(
    fileSystem,
    authorized.lexicalRoot,
    authorized.rootIdentity,
    authorized,
  );
  await assertIdentity(
    fileSystem,
    authorized.parent,
    authorized.parentIdentity,
    authorized,
  );
  let currentRoot: string;
  try {
    currentRoot = await fileSystem.realpath(authorized.lexicalRoot);
  } catch {
    throw identityChanged(authorized);
  }
  if (currentRoot !== authorized.physicalRoot) {
    throw identityChanged(authorized);
  }
}

async function assertIdentity(
  fileSystem: ConfinedMutationFileSystem,
  path: string,
  expected: PathIdentity,
  authorized: AuthorizedMutation,
): Promise<void> {
  let current: PathIdentity;
  try {
    current = await snapshotPath(fileSystem, path, true);
  } catch {
    throw identityChanged(authorized);
  }
  if (!sameIdentity(expected, current)) {
    throw identityChanged(authorized);
  }
}

async function syncParentDirectory(
  fileSystem: ConfinedMutationFileSystem,
  authorized: AuthorizedMutation,
): Promise<void> {
  await assertRootAndParentIdentities(fileSystem, authorized);
  // Windows does not provide portable directory fsync through Node. Keep the
  // identity checks, but accept reduced directory-entry durability there.
  if (fileSystem.directorySync === 'unsupported') return;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const directory = await fileSystem.open(authorized.parent, flags);
  try {
    const openedIdentity = identityFromStats(
      await directory.stat({ bigint: true }),
      authorized.parent,
    );
    if (
      !isStableExistingIdentity(openedIdentity)
      || !sameIdentity(openedIdentity, authorized.parentIdentity)
    ) {
      throw identityChanged(authorized);
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function cleanupTemporaryIfSafe(
  fileSystem: ConfinedMutationFileSystem,
  authorized: AuthorizedMutation,
  temporary: string,
  temporaryIdentity: ExistingPathIdentity,
): Promise<void> {
  try {
    const currentParent = await snapshotPath(fileSystem, authorized.parent, true);
    if (!sameIdentity(currentParent, authorized.parentIdentity)) return;
    const currentTemporary = await snapshotPath(fileSystem, temporary, true);
    if (!sameIdentity(currentTemporary, temporaryIdentity)) return;
    await fileSystem.unlink(temporary);
  } catch {
    // Cleanup must never follow a changed path or mask the primary failure.
  }
}

async function snapshotExistingPath(
  fileSystem: ConfinedMutationFileSystem,
  path: string,
): Promise<ExistingPathIdentity | UnstablePathIdentity> {
  const identity = await snapshotPath(fileSystem, path, false);
  if (!identity.exists) {
    throw new Error(`Expected an existing filesystem entry: ${path}`);
  }
  return identity;
}

async function snapshotPath(
  fileSystem: ConfinedMutationFileSystem,
  path: string,
  allowMissing: boolean,
): Promise<PathIdentity> {
  let stats: BigIntStats;
  try {
    stats = await fileSystem.lstat(path);
  } catch (error) {
    if (allowMissing && isMissingPathError(error)) return { exists: false };
    throw error;
  }
  const realPath = await fileSystem.realpath(path);
  return identityFromStats(stats, realPath);
}

function identityFromStats(
  stats: BigIntStats,
  realPath: string,
): ExistingPathIdentity | UnstablePathIdentity {
  const device = stableMetadata(stats.dev);
  const inode = stableMetadata(stats.ino);
  const fileType = Number(stats.mode & BigInt(constants.S_IFMT));
  if (device === undefined || inode === undefined) {
    return {
      exists: true,
      stable: false,
      realPath,
      fileType,
    };
  }
  return {
    exists: true,
    stable: true,
    realPath,
    device,
    inode,
    fileType,
  };
}

function stableMetadata(value: bigint): string | undefined {
  return value > 0n ? String(value) : undefined;
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  if (!left.stable || !right.stable) return false;
  if (left.realPath !== right.realPath || left.fileType !== right.fileType) {
    return false;
  }
  return left.device === right.device && left.inode === right.inode;
}

function sameFilesystemObject(
  left: ExistingPathIdentity,
  right: ExistingPathIdentity,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.fileType === right.fileType;
}

function isStableExistingIdentity(
  identity: PathIdentity,
): identity is ExistingPathIdentity {
  return identity.exists && identity.stable;
}

function barrierContext(
  authorized: AuthorizedMutation,
  temporary?: string,
): ConfinedMutationBarrierContext {
  return {
    operation: authorized.operation,
    root: authorized.lexicalRoot,
    relativePath: authorized.relativePath,
    parent: authorized.parent,
    destination: authorized.destination,
    ...(temporary === undefined ? {} : { temporary }),
  };
}

function identityChanged(authorized: AuthorizedMutation): PathIdentityChangedError {
  return new PathIdentityChangedError(
    authorized.relativePath,
    authorized.operation,
  );
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
