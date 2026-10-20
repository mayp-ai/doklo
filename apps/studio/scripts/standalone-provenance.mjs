// Bind reusable Next output to both its Git revision and actual build inputs.
// Uncommitted edits are supported only after rebuilding those exact contents.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const INPUTS = [
  'apps/studio', 'apps/cli/src', 'apps/cli/scripts', 'apps/cli/package.json',
  'apps/cli/tsconfig.json', 'packages', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', '.npmrc', 'tsconfig.json', 'tsconfig.base.json',
];
export const provenancePath = root => join(root, 'apps/studio/.next/standalone/doklo-build-provenance.json');
const fail = reason => { throw new Error(`Studio standalone ${reason}; rebuild with pnpm -C apps/studio build:standalone before release:pack.`); };

export function captureStudioSource(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  let commit, files;
  try {
    commit = git(['rev-parse', 'HEAD']).trim();
    files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...INPUTS]);
  } catch {
    fail('source revision cannot be verified');
  }
  const hash = createHash('sha256');
  for (const file of [...new Set(files.split('\0').filter(Boolean))].sort()) {
    hash.update(file).update('\0');
    // A tracked deletion is a meaningful input change, not an I/O failure.
    if (existsSync(join(root, file))) hash.update(readFileSync(join(root, file)));
    else hash.update('<deleted>');
    hash.update('\0');
  }
  return { commit, sourceHash: hash.digest('hex') };
}

function assertSameSource(expected, actual) {
  if (expected.commit !== actual.commit) fail('commit does not match HEAD');
  if (expected.sourceHash !== actual.sourceHash) fail('source changed since the build began');
}

function readBuildId(root) {
  try {
    const buildId = readFileSync(join(root, 'apps/studio/.next/BUILD_ID'), 'utf8').trim();
    const embedded = readFileSync(join(root, 'apps/studio/.next/standalone/apps/studio/.next/BUILD_ID'), 'utf8').trim();
    if (!buildId || buildId !== embedded) fail('build IDs do not match');
    return buildId;
  } catch {
    fail('build IDs are missing or inconsistent');
  }
}

export function recordStandaloneProvenance(root, before) {
  assertSameSource(before, captureStudioSource(root));
  const record = { schemaVersion: 1, ...before, buildId: readBuildId(root) };
  writeFileSync(provenancePath(root), JSON.stringify(record, null, 2) + '\n');
}

export function assertFreshStandalone(root) {
  let record;
  try { record = JSON.parse(readFileSync(provenancePath(root), 'utf8')); }
  catch { fail('provenance is missing or invalid'); }
  if (record?.schemaVersion !== 1 || !record.commit || !record.sourceHash || !record.buildId) {
    fail('provenance is invalid');
  }
  assertSameSource(record, captureStudioSource(root));
  if (record.buildId !== readBuildId(root)) fail('build ID changed since provenance was recorded');
}
