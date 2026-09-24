import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, posix, win32 } from 'node:path';
import { resolveContainedPath } from '@doklo-beta/core';
import JSZip from 'jszip';
import { canonicalizeZipBytes } from './canonical-zip.js';
import {
  publicationDigest,
  type PublicationV1,
} from './publication.js';
import { hasDraftPreviewMarker } from './manifest.js';
import type { PublicationRenderEvidence } from './render.js';

export class PublicationArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublicationArchiveError';
  }
}

export async function buildPublicationArchive(args: {
  workspaceRoot: string;
  publication: PublicationV1;
  evidence: PublicationRenderEvidence;
}): Promise<Buffer> {
  assertMatchingEvidence(args.publication, args.evidence);
  const prefix = `.doklo/output/${args.publication.output_dir}/`;
  const entries = new Map<string, Buffer>();

  for (const output of [...args.evidence.outputs].sort((left, right) =>
    compareText(left.relative_path, right.relative_path),
  )) {
    if (!output.relative_path.startsWith(prefix)) {
      throw invalidEvidence(
        `Evidence output '${output.relative_path}' is outside the publication output directory.`,
      );
    }
    const entryName = output.relative_path.slice(prefix.length);
    assertSafeArchiveEntry(entryName);
    let bytes: Buffer;
    try {
      const path = await resolveContainedPath(
        args.workspaceRoot,
        output.relative_path,
        { rejectSymlinkLeaf: true },
      );
      bytes = await readFile(path);
    } catch {
      throw staleOutput(entryName);
    }
    if (
      bytes.byteLength !== output.bytes
      || sha256(bytes) !== output.sha256
    ) {
      throw staleOutput(entryName);
    }
    if (output.format === 'manifest') {
      let manifest: unknown;
      try { manifest = JSON.parse(bytes.toString('utf8')); }
      catch { throw invalidEvidence('Publication manifest is not valid JSON.'); }
      if (hasDraftPreviewMarker(manifest)) {
        throw invalidEvidence('Draft preview cannot be used as official Publication evidence.');
      }
    }
    if (entries.has(entryName)) {
      throw invalidEvidence(
        `Publication evidence contains a duplicate archive entry: '${entryName}'.`,
      );
    }
    entries.set(entryName, bytes);
  }

  if (
    !args.evidence.outputs.some(
      (output) => output.format === 'manifest',
    )
  ) {
    throw invalidEvidence('Publication evidence does not include its manifest.');
  }

  const evidenceEntry = 'publication-evidence.json';
  const evidencePath = `${prefix}${evidenceEntry}`;
  let evidenceBytes: Buffer;
  try {
    const path = await resolveContainedPath(
      args.workspaceRoot,
      evidencePath,
      { rejectSymlinkLeaf: true },
    );
    evidenceBytes = await readFile(path);
  } catch {
    throw staleOutput(evidenceEntry);
  }
  let persistedEvidence: unknown;
  try {
    persistedEvidence = JSON.parse(evidenceBytes.toString('utf8'));
  } catch {
    throw invalidEvidence('Persisted publication evidence is not valid JSON.');
  }
  if (
    hasDraftPreviewMarker(persistedEvidence)
    || !isRecord(persistedEvidence)
    || !isRecord(persistedEvidence.publication)
    || persistedEvidence.publication.name !== args.evidence.publication.name
    || persistedEvidence.publication.definition_sha256
      !== args.evidence.publication.definition_sha256
  ) {
    throw invalidEvidence(
      'Persisted publication evidence does not match the requested archive.',
    );
  }
  if (entries.has(evidenceEntry)) {
    throw invalidEvidence(
      `Publication evidence claims the reserved archive entry '${evidenceEntry}'.`,
    );
  }
  entries.set(evidenceEntry, evidenceBytes);

  const zip = new JSZip();
  for (const [name, bytes] of [...entries].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    zip.file(name, bytes, { binary: true, createFolders: false });
  }
  const generated = await zip.generateAsync({
    type: 'nodebuffer',
    platform: 'DOS',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  return canonicalizeZipBytes(generated);
}

function assertMatchingEvidence(
  publication: PublicationV1,
  evidence: PublicationRenderEvidence,
): void {
  if (
    hasDraftPreviewMarker(evidence)
    || evidence.publication.name !== publication.name
    || evidence.template.name !== publication.template
    || evidence.publication.definition_sha256
      !== publicationDigest(publication)
  ) {
    throw invalidEvidence(
      'Publication evidence does not match the current Publication definition.',
    );
  }
}

function assertSafeArchiveEntry(value: string): void {
  const segments = value.split('/');
  if (
    value.length === 0
    || value.includes('\0')
    || value.includes('\\')
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
    || posix.normalize(value) !== value
  ) {
    throw invalidEvidence(`Unsafe publication archive entry: '${value}'.`);
  }
}

function staleOutput(path: string): PublicationArchiveError {
  return new PublicationArchiveError(
    'PUBLICATION_OUTPUTS_STALE',
    `Rendered output '${path}' no longer matches its evidence digest. Re-render the Publication before exporting.`,
  );
}

function invalidEvidence(message: string): PublicationArchiveError {
  return new PublicationArchiveError(
    'PUBLICATION_EVIDENCE_INVALID',
    message,
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
