import { cp } from 'node:fs/promises';

// Deterministic test seam for asynchronous copies. This does not provide a
// descriptor-relative filesystem guarantee; callers still rely on the
// contained mutation identity checks at publication boundaries.
export function createStandaloneAssetFileSystem(options = {}) {
  const { beforeCopy, copy = cp } = options;
  return Object.freeze({
    async copyDirectory(from, to, copyOptions) {
      await beforeCopy?.({ from, to });
      await copy(from, to, copyOptions);
    },
  });
}

export const nativeStandaloneAssetFileSystem =
  createStandaloneAssetFileSystem();
