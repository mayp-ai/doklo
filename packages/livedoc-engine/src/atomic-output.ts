import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  resolveContainedPath,
  writeFileAtomicContained,
} from '@doklo-beta/core';
import {
  isWritablePlannedOutput,
  plannedOutputReplace,
  type PlannedOutput,
} from './output-plan.js';

export class OutputExistsError extends Error {
  readonly code = 'OUTPUT_EXISTS';

  constructor(relativePath: string) {
    super(`output exists: ${relativePath}`);
    this.name = 'OutputExistsError';
  }
}

export async function writeArtifactAtomic(
  outputRoot: string,
  relativePath: string,
  bytes: string | Uint8Array,
  options: { overwrite?: boolean; mode?: number } = {},
): Promise<string> {
  const relativeParent = dirname(relativePath);
  const parent = await resolveContainedPath(outputRoot, relativeParent, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
  await mkdir(parent, { recursive: true });
  const destination = await resolveContainedPath(outputRoot, relativePath, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });

  try {
    await writeFileAtomicContained(outputRoot, relativePath, bytes, {
      mode: options.mode,
      replace: options.overwrite === true,
    });
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new OutputExistsError(relativePath);
    }
    throw error;
  }
}

export async function writePlannedArtifact(
  outputRoot: string,
  output: PlannedOutput,
  bytes: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<string> {
  if (!isWritablePlannedOutput(output)) {
    throw new OutputExistsError(output.relative_path);
  }
  return writeArtifactAtomic(outputRoot, output.relative_path, bytes, {
    mode: options.mode,
    overwrite: plannedOutputReplace(output),
  });
}
