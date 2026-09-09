import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { resolveContainedPath } from '@doklo-beta/core';
import type { PublicationWorkspaceModel } from './publication-read-model';

export class PublicationExportNotFoundError extends Error {
  readonly code = 'PUBLICATION_EXPORT_NOT_FOUND';

  constructor(readonly name: string) {
    super(`Export for Publication '${name}' was not found.`);
    this.name = 'PublicationExportNotFoundError';
  }
}

export async function readPublicationExport(input: {
  root: string;
  name: string;
  model: PublicationWorkspaceModel;
}): Promise<{ bytes: Buffer; filename: string }> {
  const entry = input.model.publications.find(
    (candidate) => candidate.publication.name === input.name,
  );
  if (!entry) throw new PublicationExportNotFoundError(input.name);
  const relativePath =
    `.doklo/output/${entry.publication.output_dir}.zip`;
  try {
    const path = await resolveContainedPath(input.root, relativePath, {
      rejectSymlinkLeaf: true,
    });
    return {
      bytes: await readFile(path),
      filename: basename(path),
    };
  } catch {
    throw new PublicationExportNotFoundError(input.name);
  }
}
