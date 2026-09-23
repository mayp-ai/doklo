export {
  assertContainedPathIdentity,
  captureContainedPathIdentity,
  captureDirectoryPublishDestination,
  publishDirectoryContained,
  removeContained,
  unlinkContained,
  writeFileAtomic,
  writeFileAtomicContained,
} from './atomic-file.js';
export {
  PathIdentityChangedError,
  PathOutsideRootError,
  resolveContainedPath,
  resolveContainedPathSync,
} from './path-containment.js';
export type {
  ConfinedMutationOperation,
  ContainedPathOptions,
} from './path-containment.js';
export type {
  ContainedPathIdentity,
  DirectoryPublishDestinationSnapshot,
  PublishDirectoryContainedOptions,
  RemoveContainedOptions,
  UnlinkContainedOptions,
  WriteFileAtomicContainedOptions,
} from './atomic-file.js';

export { isSensitiveSourcePath, isExcludedSourcePath } from './source-policy.js';
export { currentSourcePathsSync } from './source-inventory.js';
