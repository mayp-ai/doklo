import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
} from 'node:fs/promises';
import { isAbsolute, posix, win32 } from 'node:path';
import {
  resolveContainedPath,
  unlinkContained,
  writeFileAtomicContained,
} from '@doklo-beta/core';
import type {
  PublicationRenderEvidence,
  PublicationV1,
} from '@doklo-beta/livedoc-engine';

export const PUBLISH_LEDGER_NAME = 'doklo-publish.json';

const EXCLUDED_FORMATS = new Set(['manifest', 'publication-evidence']);

export interface PublishLedger {
  schema_version: 1;
  publication: string;
  definition_sha256: string;
  published_at: string;
  files: Array<{ path: string; sha256: string }>;
}

export interface PublishPlanEntry {
  path: string;
  action: 'create' | 'replace' | 'unchanged' | 'delete';
  /** Internal precondition used to protect a file between planning and writing. */
  expected_sha256?: string;
}

export interface PublishPlan {
  destinationPath: string;
  entries: PublishPlanEntry[];
  blocked: string[];
  files: Array<{ path: string; bytes: Buffer; sha256: string }>;
  /** Internal ledger precondition; omitted from CLI output. */
  ledgerSha256?: string;
}

export class PublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export async function planPublish(args: {
  workspaceRoot: string;
  publication: PublicationV1;
  evidence: PublicationRenderEvidence;
}): Promise<PublishPlan> {
  const destination = args.publication.destination;
  if (!destination) {
    throw new PublishError(
      'PUBLICATION_DESTINATION_MISSING',
      'This publication has no destination. Re-create it with --destination <path>.',
    );
  }
  if (
    args.evidence.publication.name !== args.publication.name
    || args.evidence.template.name !== args.publication.template
  ) {
    throw new PublishError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Publication evidence does not belong to this publication and template.',
    );
  }

  const destinationAbs = await resolveContainedPath(
    args.workspaceRoot,
    destination.path,
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const destinationStat = await lstat(destinationAbs).catch((error: unknown) => {
    if (isMissingError(error)) return undefined;
    throw error;
  });
  if (destinationStat && !destinationStat.isDirectory()) {
    throw new PublishError(
      'PUBLICATION_PUBLISH_BLOCKED',
      `Publication destination is not a directory: ${destination.path}`,
    );
  }

  const outputPrefix = `.doklo/output/${args.publication.output_dir}/`;
  const files: PublishPlan['files'] = [];
  const sortedOutputs = [...args.evidence.outputs].sort((left, right) =>
    compareText(left.relative_path, right.relative_path),
  );
  const claims = sortedOutputs
    .filter((output) => !EXCLUDED_FORMATS.has(output.format))
    .map((output) => {
      if (!output.relative_path.startsWith(outputPrefix)) {
        throw new PublishError(
          'PUBLICATION_EVIDENCE_INVALID',
          `Evidence output '${output.relative_path}' is outside the publication output directory.`,
        );
      }
      const relativePath = output.relative_path.slice(outputPrefix.length);
      assertSafePublishedPath(relativePath);
      return { output, relativePath };
    });
  assertUniquePublishPaths(
    claims.map((claim) => claim.relativePath),
    'PUBLICATION_EVIDENCE_INVALID',
  );

  for (const { output, relativePath } of claims) {
    let bytes: Buffer;
    try {
      const sourcePath = await resolveContainedPath(
        args.workspaceRoot,
        output.relative_path,
        { rejectSymlinkLeaf: true },
      );
      bytes = await readFile(sourcePath);
    } catch {
      throw staleOutput(relativePath);
    }
    if (
      bytes.byteLength !== output.bytes
      || sha256(bytes) !== output.sha256
    ) {
      throw staleOutput(relativePath);
    }
    files.push({
      path: relativePath,
      bytes,
      sha256: output.sha256,
    });
  }

  const ledgerState = await readLedger(
    args.workspaceRoot,
    destination.path,
  );
  if (
    ledgerState
    && ledgerState.ledger.publication !== args.publication.name
  ) {
    throw new PublishError(
      'PUBLICATION_PUBLISH_BLOCKED',
      `Destination is owned by Publication '${ledgerState.ledger.publication}', not '${args.publication.name}'.`,
    );
  }
  const owned = new Map(
    (ledgerState?.ledger.files ?? []).map((file) => [
      file.path,
      file.sha256,
    ]),
  );
  const nextPaths = new Set(files.map((file) => file.path));
  const entries: PublishPlanEntry[] = [];
  const blocked: string[] = [];

  for (const file of files) {
    const target = await targetState(
      args.workspaceRoot,
      destination.path,
      file.path,
    );
    if (!target.exists) {
      entries.push({ path: file.path, action: 'create' });
      continue;
    }
    const ownedSha = owned.get(file.path);
    if (!ownedSha || !target.isFile || target.sha256 !== ownedSha) {
      blocked.push(file.path);
      continue;
    }
    if (target.sha256 === file.sha256) {
      entries.push({
        path: file.path,
        action: 'unchanged',
        expected_sha256: target.sha256,
      });
    } else {
      entries.push({
        path: file.path,
        action: 'replace',
        expected_sha256: target.sha256,
      });
    }
  }

  for (const [ownedPath, ownedSha] of owned) {
    if (nextPaths.has(ownedPath)) continue;
    assertSafePublishedPath(ownedPath);
    const target = await targetState(
      args.workspaceRoot,
      destination.path,
      ownedPath,
    );
    if (!target.exists) continue;
    if (!target.isFile || target.sha256 !== ownedSha) {
      blocked.push(ownedPath);
      continue;
    }
    entries.push({
      path: ownedPath,
      action: 'delete',
      expected_sha256: target.sha256,
    });
  }

  entries.sort((left, right) => compareText(left.path, right.path));
  blocked.sort(compareText);
  return {
    destinationPath: destination.path,
    entries,
    blocked,
    files,
    ...(ledgerState ? { ledgerSha256: ledgerState.sha256 } : {}),
  };
}

export async function executePublish(args: {
  workspaceRoot: string;
  publication: PublicationV1;
  definitionSha256: string;
  plan: PublishPlan;
}): Promise<{ written: number; deleted: number; unchanged: number }> {
  assertPublishPlanPaths(args.publication, args.plan);
  if (args.plan.blocked.length > 0) {
    throw new PublishError(
      'PUBLICATION_PUBLISH_BLOCKED',
      `Destination contains files Doklo cannot safely replace or delete: ${args.plan.blocked.join(', ')}.`,
    );
  }

  await assertLedgerPrecondition(args.workspaceRoot, args.plan);
  await ensureContainedDirectory(
    args.workspaceRoot,
    args.plan.destinationPath,
  );

  let written = 0;
  let deleted = 0;
  let unchanged = 0;
  const byPath = new Map(
    args.plan.files.map((file) => [file.path, file]),
  );
  for (const file of args.plan.files) {
    if (file.sha256 !== sha256(file.bytes)) throw invalidPlan(file.path);
  }

  for (const entry of args.plan.entries) {
    const targetPath = posix.join(
      args.plan.destinationPath,
      entry.path,
    );
    if (entry.action === 'create') {
      await ensureContainedDirectory(
        args.workspaceRoot,
        posix.dirname(targetPath),
      );
      const file = byPath.get(entry.path);
      if (!file) throw invalidPlan(entry.path);
      try {
        await writeFileAtomicContained(
          args.workspaceRoot,
          targetPath,
          file.bytes,
          { replace: false },
        );
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new PublishError(
            'PUBLICATION_PUBLISH_BLOCKED',
            `Destination file appeared after planning: ${entry.path}`,
          );
        }
        throw error;
      }
      written += 1;
      continue;
    }

    await assertTargetDigest(
      args.workspaceRoot,
      targetPath,
      entry.expected_sha256,
    );
    if (entry.action === 'delete') {
      await unlinkContained(args.workspaceRoot, targetPath);
      deleted += 1;
    } else if (entry.action === 'unchanged') {
      unchanged += 1;
    } else {
      const file = byPath.get(entry.path);
      if (!file) throw invalidPlan(entry.path);
      await writeFileAtomicContained(
        args.workspaceRoot,
        targetPath,
        file.bytes,
        { replace: true },
      );
      written += 1;
    }
  }

  const ledger: PublishLedger = {
    schema_version: 1,
    publication: args.publication.name,
    definition_sha256: args.definitionSha256,
    published_at: new Date().toISOString(),
    files: args.plan.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
    })),
  };
  const ledgerPath = posix.join(
    args.plan.destinationPath,
    PUBLISH_LEDGER_NAME,
  );
  try {
    await writeFileAtomicContained(
      args.workspaceRoot,
      ledgerPath,
      `${JSON.stringify(ledger, null, 2)}\n`,
      { replace: args.plan.ledgerSha256 !== undefined },
    );
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new PublishError(
        'PUBLICATION_PUBLISH_BLOCKED',
        'Publish ledger appeared after planning; no foreign ledger was replaced.',
      );
    }
    throw error;
  }

  return { written, deleted, unchanged };
}

async function readLedger(
  workspaceRoot: string,
  destinationPath: string,
): Promise<{ ledger: PublishLedger; sha256: string } | undefined> {
  const relativePath = posix.join(
    destinationPath,
    PUBLISH_LEDGER_NAME,
  );
  const path = await resolveContainedPath(workspaceRoot, relativePath, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidLedger();
  }
  if (!isPublishLedger(parsed)) throw invalidLedger();
  try {
    assertUniquePublishPaths(
      parsed.files.map((file) => file.path),
      'PUBLICATION_PUBLISH_LEDGER_INVALID',
    );
  } catch {
    throw invalidLedger();
  }
  return { ledger: parsed, sha256: sha256(bytes) };
}

async function targetState(
  workspaceRoot: string,
  destinationPath: string,
  publishedPath: string,
): Promise<
  | { exists: false }
  | { exists: true; isFile: boolean; sha256?: string }
> {
  const relativePath = posix.join(destinationPath, publishedPath);
  const path = await resolveContainedPath(workspaceRoot, relativePath, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissingError(error)) return { exists: false };
    throw error;
  }
  if (!stats.isFile()) return { exists: true, isFile: false };
  return {
    exists: true,
    isFile: true,
    sha256: sha256(await readFile(path)),
  };
}

async function assertLedgerPrecondition(
  workspaceRoot: string,
  plan: PublishPlan,
): Promise<void> {
  const current = await readLedger(
    workspaceRoot,
    plan.destinationPath,
  );
  if (
    (plan.ledgerSha256 === undefined && current !== undefined)
    || (
      plan.ledgerSha256 !== undefined
      && current?.sha256 !== plan.ledgerSha256
    )
  ) {
    throw new PublishError(
      'PUBLICATION_PUBLISH_BLOCKED',
      'Publish ledger changed after planning; retry the publish.',
    );
  }
}

async function assertTargetDigest(
  workspaceRoot: string,
  relativePath: string,
  expected: string | undefined,
): Promise<void> {
  if (!expected) throw invalidPlan(relativePath);
  const target = await targetState(
    workspaceRoot,
    posix.dirname(relativePath),
    posix.basename(relativePath),
  );
  if (!target.exists || !target.isFile || target.sha256 !== expected) {
    throw new PublishError(
      'PUBLICATION_PUBLISH_BLOCKED',
      `Destination file changed after planning: ${relativePath}`,
    );
  }
}

async function ensureContainedDirectory(
  workspaceRoot: string,
  relativePath: string,
): Promise<void> {
  if (relativePath === '.') return;
  const candidate = await resolveContainedPath(
    workspaceRoot,
    relativePath,
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  await mkdir(candidate, { recursive: true });
  const resolved = await resolveContainedPath(
    workspaceRoot,
    relativePath,
    { rejectSymlinkLeaf: true },
  );
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) {
    throw new PublishError(
      'PUBLICATION_PUBLISH_BLOCKED',
      `Publish path is not a directory: ${relativePath}`,
    );
  }
}

function assertSafePublishedPath(value: string): void {
  const segments = value.split('/');
  if (
    value.length === 0
    || portablePublishPath(value) === portablePublishPath(PUBLISH_LEDGER_NAME)
    || value.includes('\0')
    || value.includes('\\')
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new PublishError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Unsafe publication output path: '${value}'.`,
    );
  }
}

function assertUniquePublishPaths(
  paths: string[],
  code: string,
): void {
  const byPortablePath = new Map<string, string>();
  for (const path of paths) {
    assertSafePublishedPath(path);
    const portable = portablePublishPath(path);
    const previous = byPortablePath.get(portable);
    if (previous !== undefined) {
      throw new PublishError(
        code,
        `Publication output paths collide on portable filesystems: '${previous}' and '${path}'.`,
      );
    }
    byPortablePath.set(portable, path);
  }
  for (const [portable, path] of byPortablePath) {
    let ancestor = posix.dirname(portable);
    while (ancestor !== '.') {
      const claimedAncestor = byPortablePath.get(ancestor);
      if (claimedAncestor !== undefined) {
        throw new PublishError(
          code,
          `Publication output path '${path}' is nested beneath file '${claimedAncestor}'.`,
        );
      }
      ancestor = posix.dirname(ancestor);
    }
  }
}

function assertPublishPlanPaths(
  publication: PublicationV1,
  plan: PublishPlan,
): void {
  if (
    !publication.destination
    || plan.destinationPath !== publication.destination.path
  ) {
    throw new PublishError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Publish plan destination does not match the Publication definition.',
    );
  }
  assertUniquePublishPaths(
    plan.files.map((file) => file.path),
    'PUBLICATION_EVIDENCE_INVALID',
  );
  assertUniquePublishPaths(
    plan.entries.map((entry) => entry.path),
    'PUBLICATION_EVIDENCE_INVALID',
  );
  assertUniquePublishPaths(
    plan.blocked,
    'PUBLICATION_EVIDENCE_INVALID',
  );
  if (plan.blocked.length > 0) return;

  const filePaths = new Set(
    plan.files.map((file) => portablePublishPath(file.path)),
  );
  const entryPaths = new Map(
    plan.entries.map((entry) => [
      portablePublishPath(entry.path),
      entry,
    ]),
  );
  for (const entry of plan.entries) {
    const hasFile = filePaths.has(portablePublishPath(entry.path));
    if (entry.action === 'delete' ? hasFile : !hasFile) {
      throw invalidPlan(entry.path);
    }
  }
  for (const file of plan.files) {
    if (!entryPaths.has(portablePublishPath(file.path))) {
      throw invalidPlan(file.path);
    }
  }
}

function portablePublishPath(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function isPublishLedger(value: unknown): value is PublishLedger {
  if (!isRecord(value)) return false;
  return value.schema_version === 1
    && typeof value.publication === 'string'
    && typeof value.definition_sha256 === 'string'
    && typeof value.published_at === 'string'
    && Array.isArray(value.files)
    && value.files.every(
      (file) =>
        isRecord(file)
        && typeof file.path === 'string'
        && typeof file.sha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(file.sha256),
    );
}

function staleOutput(path: string): PublishError {
  return new PublishError(
    'PUBLICATION_OUTPUTS_STALE',
    `Rendered output '${path}' no longer matches its evidence digest. Re-render the publication before publishing.`,
  );
}

function invalidLedger(): PublishError {
  return new PublishError(
    'PUBLICATION_PUBLISH_LEDGER_INVALID',
    'The destination contains an invalid Doklo publish ledger; it was not overwritten.',
  );
}

function invalidPlan(path: string): PublishError {
  return new PublishError(
    'PUBLICATION_PUBLISH_PLAN_INVALID',
    `Publish plan is missing verified bytes for '${path}'.`,
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

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isAlreadyExistsError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && error.code === 'EEXIST';
}
