#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const FROZEN_REPOSITORY_URL =
  'https://github.com/vercel/nextjs-postgres-auth-starter.git';
const FROZEN_REPOSITORY_COMMIT =
  'fde8ecf1da9337223081f70cf88b420060039d6e';
const FROZEN_MODEL = 'anthropic/claude-sonnet-5';
const STARTUP_TIMEOUT_MS = 30_000;
const UI_TIMEOUT_MS = 12_000;
const execFileAsync = promisify(execFile);

const HELP = `Usage:
  pnpm -C apps/studio e2e:tarball -- \\
    --binary <packed-doklo-binary> \\
    --workspace <prepared-public-workspace> \\
    --evidence-dir <output-directory> \\
    --repo-url ${FROZEN_REPOSITORY_URL} \\
    --repo-commit ${FROZEN_REPOSITORY_COMMIT} \\
    --model ${FROZEN_MODEL} \\
    --disposable-workspace

This runner consumes an already installed Doklo tarball and an already prepared
workspace rooted at the exact public Git origin and commit above. It never clones
a repository, generates Doks, or invokes a provider.

WARNING: this E2E intentionally edits the prepared workspace and does not restore
it. Use only a disposable checkout. --disposable-workspace is explicit consent to
leave those runner-owned edits in place.
`;

function usageError(message) {
  const error = new Error(message);
  error.name = 'UsageError';
  return error;
}

function parseArgs(argv) {
  const tokens = argv.filter((token) => token !== '--');
  if (tokens.includes('--help') || tokens.includes('-h')) {
    return { help: true };
  }
  if (tokens.length === 1 && tokens[0] === '--self-test') {
    return { help: false, selfTest: true };
  }

  const valueFlags = new Set([
    '--binary',
    '--workspace',
    '--evidence-dir',
    '--repo-url',
    '--repo-commit',
    '--model',
  ]);
  const values = new Map();
  let disposableWorkspace = false;

  for (let index = 0; index < tokens.length;) {
    const flag = tokens[index];
    if (flag === '--disposable-workspace') {
      if (disposableWorkspace) throw usageError(`Duplicate argument: ${flag}`);
      disposableWorkspace = true;
      index += 1;
      continue;
    }
    const value = tokens[index + 1];
    if (!valueFlags.has(flag)) {
      throw usageError(`Unknown argument: ${flag ?? '<empty>'}`);
    }
    if (values.has(flag)) {
      throw usageError(`Duplicate argument: ${flag}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw usageError(`Missing value for ${flag}`);
    }
    values.set(flag, value);
    index += 2;
  }

  for (const flag of valueFlags) {
    if (!values.has(flag)) throw usageError(`Missing required argument: ${flag}`);
  }
  if (!disposableWorkspace) {
    throw usageError('--disposable-workspace is required because this E2E leaves edits in place');
  }

  const args = {
    help: false,
    binary: resolve(values.get('--binary')),
    workspace: resolve(values.get('--workspace')),
    evidenceDir: resolve(values.get('--evidence-dir')),
    repoUrl: values.get('--repo-url'),
    repoCommit: values.get('--repo-commit'),
    model: values.get('--model'),
    disposableWorkspace,
  };

  if (args.repoUrl !== FROZEN_REPOSITORY_URL) {
    throw usageError(`--repo-url must be ${FROZEN_REPOSITORY_URL}`);
  }
  if (args.repoCommit !== FROZEN_REPOSITORY_COMMIT) {
    throw usageError(`--repo-commit must be ${FROZEN_REPOSITORY_COMMIT}`);
  }
  if (args.model !== FROZEN_MODEL) {
    throw usageError(`--model must be ${FROZEN_MODEL}`);
  }
  return args;
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent))
  );
}

async function resolvePhysicalDestination(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (true) {
    const physical = await realpath(cursor).catch(() => null);
    if (physical) return resolve(physical, ...missingSegments);
    const parent = dirname(cursor);
    if (parent === cursor) throw usageError(`Could not resolve destination parent: ${path}`);
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
}

async function readGit(workspace, gitArgs) {
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  gitEnvironment.GIT_OPTIONAL_LOCKS = '0';
  gitEnvironment.GIT_TERMINAL_PROMPT = '0';
  const { stdout } = await execFileAsync('git', ['-C', workspace, ...gitArgs], {
    encoding: 'utf8',
    env: gitEnvironment,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function verifyWorkspaceProvenance(workspace, args) {
  let topLevel;
  try {
    topLevel = await readGit(workspace, ['rev-parse', '--show-toplevel']);
  } catch {
    throw usageError('--workspace must be the root of a Git checkout');
  }
  const physicalTopLevel = await realpath(topLevel).catch(() => null);
  if (physicalTopLevel !== workspace) {
    throw usageError('--workspace must be the root of its Git checkout');
  }

  let originLines = [];
  try {
    const origin = await readGit(workspace, [
      'config',
      '--local',
      '--get-all',
      'remote.origin.url',
    ]);
    originLines = origin ? origin.split(/\r?\n/u) : [];
  } catch {
    // Missing origin is reported as a provenance mismatch below.
  }
  if (originLines.length !== 1 || originLines[0] !== args.repoUrl) {
    throw usageError('--workspace Git origin does not match --repo-url');
  }

  let head;
  try {
    head = await readGit(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    throw usageError('--workspace Git HEAD could not be verified');
  }
  if (head !== args.repoCommit) {
    throw usageError('--workspace Git HEAD does not match --repo-commit');
  }
}

async function validateInputs(args) {
  if (args.disposableWorkspace !== true) {
    throw usageError('--disposable-workspace is required before validating mutable inputs');
  }
  const workspace = await realpath(args.workspace).catch(() => null);
  if (!workspace || !(await stat(workspace)).isDirectory()) {
    throw usageError('--workspace must identify an existing directory');
  }
  const workspaceFile = join(workspace, 'workspace.json');
  const workspaceFileInfo = await lstat(workspaceFile).catch(() => null);
  if (
    !workspaceFileInfo?.isFile() ||
    workspaceFileInfo.isSymbolicLink()
  ) {
    throw usageError('--workspace must contain workspace.json at its root');
  }
  await verifyWorkspaceProvenance(workspace, args);

  const binaryTarget = await realpath(args.binary).catch(() => null);
  if (!binaryTarget || !(await stat(binaryTarget)).isFile()) {
    throw usageError('--binary must identify the installed packed doklo executable');
  }
  const binaryMode = (await stat(binaryTarget)).mode;
  if ((binaryMode & 0o111) === 0) {
    throw usageError('--binary must be executable');
  }
  if (basename(args.binary) !== 'doklo') {
    throw usageError('--binary must be the installed executable named doklo');
  }

  const evidenceDir = await resolvePhysicalDestination(args.evidenceDir);
  if (isWithin(workspace, evidenceDir)) {
    throw usageError('--evidence-dir must be outside the prepared workspace');
  }

  return { ...args, workspace, evidenceDir };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    // Do not interpolate compared values: they may be sourced from canonical
    // workspace files and therefore must never enter the evidence ledger.
    throw new Error(message);
  }
}

async function waitForVisible(locator, label, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch {
    throw new Error(`Expected ${label} to be visible`);
  }
}

async function waitForText(locator, pattern, label, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const text = (await locator.textContent()) ?? '';
      if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) return text;
      await new Promise((done) => setTimeout(done, 100));
    }
  } catch {
    // Fall through to the controlled error below.
  }
  throw new Error(`Expected ${label}`);
}

function recoveryAlert(page, title) {
  return page.getByRole('alert').filter({ hasText: title });
}

function statusMatches(text, kind, path) {
  if (kind === 'saved') return text === `Saved · ${path}`;
  if (kind === 'error') return text.startsWith(`Save failed · ${path}: `);
  if (kind === 'conflict') return text === `File changed outside Studio · ${path}`;
  return false;
}

async function waitForStatus(locator, kind, path, label, timeout = UI_TIMEOUT_MS) {
  await waitForVisible(locator, label, timeout);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (statusMatches((await locator.textContent()) ?? '', kind, path)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Expected ${label} for the exact affected path`);
}

function safeFailure(error, args) {
  const firstLine = String(error instanceof Error ? error.message : error)
    .split(/\r?\n/u, 1)[0]
    .replaceAll(args.workspace, '<workspace>')
    .replaceAll(args.evidenceDir, '<evidence-dir>')
    .replaceAll(args.binary, '<packed-binary>')
    .replace(/((?:api[_-]?key|authorization|token|secret|password))\s*[:=]\s*\S+/giu, '$1=<redacted>')
    .slice(0, 500);
  return firstLine || 'Studio assertion failed';
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(path, bytes, mode, operations = {}) {
  const parent = dirname(path);
  const temp = join(
    parent,
    `.${basename(path)}.studio-e2e-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(temp, 'wx', mode ?? 0o600);
    if (mode !== undefined) await handle.chmod(mode & 0o777);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await (operations.syncDirectory ?? syncDirectory)(parent);
  } finally {
    try {
      await handle?.close();
    } finally {
      await unlink(temp).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }
}

async function atomicWriteJson(path, value, mode) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function expectedDokDescriptionEdit(current, description) {
  return {
    ...current,
    description,
    _meta: {
      ...current._meta,
      edited_by_human: true,
    },
  };
}

function expectedRoleDescriptionEdit(current, roleId, description, updatedAt) {
  assert(
    typeof updatedAt === 'string' && new Date(updatedAt).toISOString() === updatedAt,
    'Role save did not produce a canonical ISO updated_at',
  );
  let found = false;
  const roles = current.roles.map((role) => {
    if (role.role_id !== roleId) return role;
    found = true;
    return { ...role, description };
  });
  assert(found, 'Role save target disappeared from the expected transaction state');
  return { ...current, updated_at: updatedAt, roles };
}

async function snapshotRunnerOwnedFiles(root, paths) {
  const canonicalRoot = await realpath(root);
  const snapshots = [];
  for (const path of [...new Set(paths)]) {
    const physicalPath = await realpath(path);
    const relativePath = relative(canonicalRoot, physicalPath);
    assert(
      relativePath !== '' && isWithin(canonicalRoot, physicalPath),
      'Runner-owned target escapes the canonical root',
    );
    const containedPath = await requireContainedEntry(canonicalRoot, relativePath, 'file');
    assertEqual(containedPath, physicalPath, 'Runner-owned target changed during snapshot');
    const info = await lstat(containedPath);
    const bytes = await readFile(containedPath);
    snapshots.push({
      root: canonicalRoot,
      path: containedPath,
      relativePath,
      originalBytes: bytes,
      originalMode: info.mode & 0o777,
      expectedBytes: bytes,
      expectedMode: info.mode & 0o777,
    });
  }
  return snapshots;
}

async function expectRunnerOwnedState(snapshots, path, bytes, mode) {
  const physicalPath = await realpath(path);
  const snapshot = snapshots.find((candidate) => candidate.path === physicalPath);
  assert(snapshot, 'Runner tried to advance an untracked mutation target');
  const expectedBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const info = await lstat(physicalPath);
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o777) === mode &&
      Buffer.compare(await readFile(physicalPath), expectedBytes) === 0,
    'Runner-owned file did not reach its exact expected transaction state',
  );
  snapshot.expectedBytes = Buffer.from(expectedBytes);
  snapshot.expectedMode = mode;
}

async function verifyRunnerOwnedStates(snapshots, operations = {}) {
  const outcomes = [];
  for (const snapshot of snapshots) {
    try {
      const containedPath = await (operations.requireContainedEntry ?? requireContainedEntry)(
        snapshot.root,
        snapshot.relativePath,
        'file',
      );
      assertEqual(containedPath, snapshot.path, 'Runner-owned target changed after its snapshot');
      const currentInfo = await lstat(containedPath);
      assert(
        currentInfo.isFile() &&
          !currentInfo.isSymbolicLink() &&
          (currentInfo.mode & 0o777) === snapshot.expectedMode &&
          Buffer.compare(await readFile(containedPath), snapshot.expectedBytes) === 0,
        'Runner-owned file ended outside its expected E2E transaction',
      );
      outcomes.push({ snapshot, status: 'pass' });
    } catch (error) {
      outcomes.push({ snapshot, status: 'fail', error });
    }
  }
  return outcomes;
}

async function hashTree(root) {
  const hash = createHash('sha256');

  async function visit(path, relativePath) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      hash.update(`L\0${relativePath}\0${await readlink(path)}\0`);
      return;
    }
    if (info.isDirectory()) {
      const permissionMode = (info.mode & 0o777).toString(8).padStart(3, '0');
      hash.update(`D\0${relativePath}\0${permissionMode}\0`);
      const entries = (await readdir(path)).sort((left, right) => left.localeCompare(right));
      for (const entry of entries) {
        await visit(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
      }
      return;
    }
    if (info.isFile()) {
      const bytes = await readFile(path);
      const permissionMode = (info.mode & 0o777).toString(8).padStart(3, '0');
      hash.update(`F\0${relativePath}\0${permissionMode}\0${bytes.length}\0`);
      hash.update(bytes);
      hash.update('\0');
    }
  }

  await visit(root, '');
  return hash.digest('hex');
}

async function requireContainedEntry(root, relativePath, expectedKind) {
  const candidate = resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    throw new Error(`Workspace path escapes the canonical root: ${relativePath}`);
  }

  const segments = relativePath.split('/').filter(Boolean);
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(`Workspace path must not be a symlink: ${relativePath}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`Workspace path parent is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      const validKind = expectedKind === 'directory' ? info.isDirectory() : info.isFile();
      if (!validKind) {
        throw new Error(`Workspace path is not a regular ${expectedKind}: ${relativePath}`);
      }
    }
  }

  const physical = await realpath(candidate);
  if (!isWithin(root, physical)) {
    throw new Error(`Workspace path physically escapes the canonical root: ${relativePath}`);
  }
  return candidate;
}

async function preflightWorkspacePaths(workspace) {
  const root = await realpath(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Workspace root must be a canonical regular directory');
  }

  await requireContainedEntry(root, 'workspace.json', 'file');
  await requireContainedEntry(root, '.doklo', 'directory');
  const hubDir = await requireContainedEntry(root, '.doklo/hub', 'directory');
  const doksDir = await requireContainedEntry(root, '.doklo/hub/doks', 'directory');
  const lexiconPath = await requireContainedEntry(root, '.doklo/hub/lexicon.json', 'file');
  const rolesPath = await requireContainedEntry(root, '.doklo/hub/roles.json', 'file');
  const entries = (await readdir(doksDir))
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));
  const dokPaths = [];
  for (const entry of entries) {
    if (entry !== basename(entry)) {
      throw new Error('Dok filename is not a contained leaf');
    }
    dokPaths.push({
      entry,
      path: await requireContainedEntry(root, `.doklo/hub/doks/${entry}`, 'file'),
    });
  }
  return { root, hubDir, doksDir, lexiconPath, rolesPath, dokPaths };
}

async function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Could not reserve a local Studio port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

async function waitForStudio(url, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Packed Doklo Studio process exited before it became ready');
    }
    try {
      const response = await fetch(`${url}/doks`, { redirect: 'manual' });
      if (response.status === 200) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('Packed Doklo Studio did not serve /doks within 30 seconds');
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((done) => {
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      done(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopStudio(
  child,
  { termTimeoutMs = 5_000, killTimeoutMs = 2_000 } = {},
) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let exited = await waitForChildExit(child, termTimeoutMs);
  if (!exited) {
    child.kill('SIGKILL');
    exited = await waitForChildExit(child, killTimeoutMs);
  }
  if (!exited || (child.exitCode === null && child.signalCode === null)) {
    throw new Error('Packed Doklo Studio process did not terminate after SIGKILL');
  }
}

async function startStudio(args, port) {
  const child = spawn(
    args.binary,
    ['serve', '--root', args.workspace, '--port', String(port)],
    {
      cwd: args.workspace,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Drain process output without persisting it: stdout/stderr can contain local
  // paths and must never become release evidence.
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  try {
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    await waitForStudio(`http://127.0.0.1:${port}`, child);
    return child;
  } catch (error) {
    try {
      await stopStudio(child);
    } catch {
      throw new Error('Packed Doklo Studio startup cleanup did not terminate the child process');
    }
    throw error;
  }
}

function browserRecord(type, text, location) {
  let urlPath = '';
  try {
    const parsed = new URL(location?.url ?? '');
    urlPath = parsed.pathname;
  } catch {
    urlPath = '';
  }
  return {
    type,
    message_sha256: sha256(text),
    message_bytes: Buffer.byteLength(text),
    location: {
      path: urlPath,
      line: location?.lineNumber ?? 0,
      column: location?.columnNumber ?? 0,
    },
  };
}

function appendLedgerFailure(result, name, error, args) {
  result.assertions.push({
    name,
    status: 'fail',
    evidence: 'studio-result.json',
    error: safeFailure(error, args),
  });
}

async function finalizeEvidence({
  browser,
  child,
  scanned,
  result,
  args,
  trackedMutations = [],
  operations = {},
}) {
  try {
    await browser?.close();
  } catch (error) {
    appendLedgerFailure(result, 'browser-cleanup', error, args);
  }
  let studioStopped = true;
  try {
    await (operations.stopStudio ?? stopStudio)(child);
  } catch (error) {
    studioStopped = false;
    appendLedgerFailure(result, 'studio-process-cleanup', error, args);
  }
  let terminalOutcomes = [];
  if (trackedMutations.length > 0) {
    if (!studioStopped) {
      terminalOutcomes = trackedMutations.map((snapshot) => ({
        snapshot,
        status: 'fail',
        error: new Error('Terminal state was not verified because Studio did not stop'),
      }));
    } else {
      try {
        terminalOutcomes = await (operations.verifyRunnerOwnedStates ?? verifyRunnerOwnedStates)(
          trackedMutations,
        );
      } catch (error) {
        terminalOutcomes = trackedMutations.map((snapshot) => ({
          snapshot,
          status: 'fail',
          error,
        }));
      }
    }
  }
  result.runner_owned_mutations = terminalOutcomes.map(({ snapshot, status }) => ({
    path: snapshot.relativePath,
    original_sha256: sha256(snapshot.originalBytes),
    expected_terminal_sha256: sha256(snapshot.expectedBytes),
    original_mode: snapshot.originalMode.toString(8).padStart(3, '0'),
    expected_terminal_mode: snapshot.expectedMode.toString(8).padStart(3, '0'),
    status,
  }));
  for (const outcome of terminalOutcomes) {
    const entry = {
      name: 'runner-owned-terminal-state',
      status: outcome.status,
      evidence: 'studio-result.json',
      target: outcome.snapshot.relativePath,
    };
    if (outcome.status === 'fail') {
      entry.error = safeFailure(outcome.error, args);
    }
    result.assertions.push(entry);
  }
  try {
    result.fs_after_sha256 = await (operations.hashTree ?? hashTree)(scanned.hubDir);
  } catch (error) {
    result.fs_after_sha256 = '';
    appendLedgerFailure(result, 'final-filesystem-hash', error, args);
  }
  await (operations.atomicWrite ?? atomicWrite)(
    join(args.evidenceDir, 'studio-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    0o600,
  );
}

async function scanWorkspace(workspace) {
  const { DokSchema, RolesFileSchema } = await import('@doklo-beta/core');
  const paths = await preflightWorkspacePaths(workspace);
  const doks = [];
  const invalidDokFiles = [];
  for (const { entry, path } of paths.dokPaths) {
    try {
      const parsed = DokSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (parsed.success) doks.push({ path, file: entry, dok: parsed.data });
      else invalidDokFiles.push(entry);
    } catch {
      invalidDokFiles.push(entry);
    }
  }

  let roles = [];
  try {
    const parsed = RolesFileSchema.safeParse(JSON.parse(await readFile(paths.rolesPath, 'utf8')));
    if (parsed.success) roles = parsed.data.roles;
  } catch {
    // The real assertion reports the missing usable role without leaking bytes.
  }

  return { ...paths, doks, invalidDokFiles, roles };
}

async function runEvidence(args) {
  await mkdir(args.evidenceDir, { recursive: true, mode: 0o700 });
  const result = {
    schema_version: 1,
    repository: { url: args.repoUrl, commit: args.repoCommit },
    model: args.model,
    workspace_mode: 'disposable-prepared-checkout',
    studio_url: '',
    assertions: [],
    screenshots: [],
    browser_console: [],
    fs_before_sha256: '',
    fs_after_sha256: '',
    runner_owned_mutations: [],
  };
  let scanned;
  let anchored;
  let editableDok;
  let trackedMutations = [];
  let expectedDokState;
  let expectedRolesState;
  try {
    scanned = await scanWorkspace(args.workspace);
    anchored = scanned.doks.find(
      ({ dok }) => (dok._meta.source_anchors?.length ?? 0) > 0,
    );
    editableDok = anchored ?? scanned.doks[0];
    trackedMutations = await snapshotRunnerOwnedFiles(
      scanned.root,
      [editableDok?.path, scanned.rolesPath].filter(Boolean),
    );
    if (editableDok) {
      const snapshot = trackedMutations.find(({ path }) => path === editableDok.path);
      assert(snapshot, 'Editable Dok mutation snapshot is missing');
      expectedDokState = JSON.parse(snapshot.originalBytes.toString('utf8'));
    }
    const rolesSnapshot = trackedMutations.find(({ path }) => path === scanned.rolesPath);
    assert(rolesSnapshot, 'Roles mutation snapshot is missing');
    expectedRolesState = JSON.parse(rolesSnapshot.originalBytes.toString('utf8'));
    result.fs_before_sha256 = await hashTree(scanned.hubDir);
  } catch (error) {
    result.assertions.push({
      name: 'studio-runner',
      status: 'fail',
      evidence: 'studio-result.json',
      error: safeFailure(error, args),
    });
    await atomicWrite(
      join(args.evidenceDir, 'studio-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      0o600,
    );
    return false;
  }
  let port;
  try {
    port = await reservePort();
  } catch (error) {
    appendLedgerFailure(result, 'studio-runner', error, args);
    await finalizeEvidence({
      browser: undefined,
      child: undefined,
      scanned,
      result,
      args,
      trackedMutations,
    });
    return false;
  }
  const studioUrl = `http://127.0.0.1:${port}`;
  result.studio_url = studioUrl;

  let child;
  let browser;
  let page;

  async function screenshot(name) {
    assert(name === basename(name) && name.endsWith('.png'), 'Unsafe screenshot evidence path');
    await page.screenshot({ path: join(args.evidenceDir, name), fullPage: false });
    result.screenshots.push(name);
  }

  async function recordAssertion(name, evidence, check) {
    let failure = null;
    try {
      await check();
    } catch (error) {
      failure = error;
    }
    try {
      await screenshot(evidence);
    } catch (error) {
      failure ??= new Error('Could not capture the required browser screenshot');
    }
    const entry = {
      name,
      status: failure ? 'fail' : 'pass',
      evidence,
    };
    if (failure) entry.error = safeFailure(failure, args);
    result.assertions.push(entry);
    return !failure;
  }

  try {
    child = await startStudio(args, port);
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    page.on('console', (message) => {
      result.browser_console.push(
        browserRecord(message.type(), message.text(), message.location()),
      );
    });
    page.on('pageerror', (error) => {
      result.browser_console.push(browserRecord('pageerror', error.message, null));
    });

    await recordAssertion('real-dok-count', 'real-dok-count.png', async () => {
      assert(scanned.doks.length > 0, 'Prepared workspace has no valid Doks');
      assertEqual(
        scanned.invalidDokFiles.length,
        0,
        'Prepared workspace contains schema-invalid Dok files',
      );
      await page.goto(`${studioUrl}/doks`, { waitUntil: 'domcontentloaded' });
      await waitForVisible(page.getByRole('heading', { name: 'Doks', exact: true }), 'Doks heading');
      const rendered = await page.locator('[data-row-id]').count();
      assertEqual(rendered, scanned.doks.length, 'Studio Dok rows do not match valid Dok files');
    });

    await recordAssertion(
      'truthful-onboarding-entry',
      'truthful-onboarding-entry.png',
      async () => {
        const before = await hashTree(scanned.hubDir);
        let generationRequests = 0;
        const countGenerationRequest = (request) => {
          if (new URL(request.url()).pathname === '/api/wizard/generate') generationRequests += 1;
        };
        page.on('request', countGenerationRequest);
        await page.goto(`${studioUrl}/onboarding`, { waitUntil: 'domcontentloaded' });
        await waitForVisible(page.getByRole('heading', { name: /Hello/ }), 'onboarding heading');
        assertEqual(new URL(page.url()).pathname, '/onboarding', 'Production onboarding did not render');
        assertEqual(generationRequests, 0, 'Onboarding started generation on load');
        page.off('request', countGenerationRequest);
        assertEqual(
          await hashTree(scanned.hubDir),
          before,
          'Onboarding entry changed canonical workspace bytes',
        );
      },
    );

    await recordAssertion('real-source-anchor', 'real-source-anchor.png', async () => {
      assert(anchored, 'Prepared workspace has no Dok with a real source anchor');
      await page.goto(`${studioUrl}/doks`, { waitUntil: 'domcontentloaded' });
      const row = page.locator(`[data-row-id="${anchored.dok.dok_id}"]`);
      await waitForVisible(row, 'anchored Dok row');
      await row.click();
      await waitForVisible(
        page.getByText(anchored.dok._meta.source_anchors[0].file, { exact: false }),
        'real source anchor',
      );
    });

    let persistedDescription = '';
    await recordAssertion(
      'recursive-unknown-field-preservation',
      'recursive-unknown-field-preservation.png',
      async () => {
        assert(editableDok, 'Prepared workspace has no editable Dok');
        assert(expectedDokState, 'Editable Dok expected transaction state is missing');
        const currentBytes = await readFile(editableDok.path);
        const snapshot = trackedMutations.find(({ path }) => path === editableDok.path);
        assert(snapshot, 'Editable Dok mutation snapshot is missing');
        assertEqual(
          Buffer.compare(currentBytes, snapshot.expectedBytes),
          0,
          'Editable Dok changed before the runner-owned edit began',
        );
        const current = JSON.parse(currentBytes.toString('utf8'));
        current.future_studio_root = { retained: true };
        current._meta = {
          ...current._meta,
          future_studio_nested: { retained: true },
        };
        const fileMode = (await stat(editableDok.path)).mode & 0o777;
        const seededBytes = jsonBytes(current);
        await atomicWrite(editableDok.path, seededBytes, fileMode);
        await expectRunnerOwnedState(
          trackedMutations,
          editableDok.path,
          seededBytes,
          fileMode,
        );
        expectedDokState = current;

        await page.goto(
          `${studioUrl}/doks/${encodeURIComponent(editableDok.dok.dok_id)}`,
          { waitUntil: 'domcontentloaded' },
        );
        const description = page.getByRole('textbox', { name: 'Description' });
        await waitForVisible(description, 'Dok description editor');
        persistedDescription = `Studio tarball persistence ${Date.now()}`;
        const savedState = expectedDokDescriptionEdit(expectedDokState, persistedDescription);
        const savedBytes = jsonBytes(savedState);
        let savedStateObserved = false;
        await description.fill(persistedDescription);
        try {
          await waitForStatus(
            page.getByRole('status'),
            'saved',
            editableDok.path,
            'a truthful saved status',
          );
        } finally {
          try {
            await expectRunnerOwnedState(
              trackedMutations,
              editableDok.path,
              savedBytes,
              fileMode,
            );
            expectedDokState = savedState;
            savedStateObserved = true;
          } catch {
            // Terminal verification must reject any state outside this exact edit.
          }
        }
        assert(savedStateObserved, 'Dok save produced bytes outside the expected transaction');

        const saved = JSON.parse(await readFile(editableDok.path, 'utf8'));
        assertEqual(saved.description, persistedDescription, 'Dok description was not saved');
        assertEqual(
          saved.future_studio_root?.retained,
          true,
          'Unknown root field was discarded',
        );
        assertEqual(
          saved._meta?.future_studio_nested?.retained,
          true,
          'Unknown nested field was discarded',
        );
      },
    );

    await recordAssertion('restart-persistence', 'restart-persistence.png', async () => {
      assert(persistedDescription, 'The persisted Dok edit prerequisite did not complete');
      await stopStudio(child);
      child = await startStudio(args, port);
      await page.goto(
        `${studioUrl}/doks/${encodeURIComponent(editableDok.dok.dok_id)}`,
        { waitUntil: 'domcontentloaded' },
      );
      const description = page.getByRole('textbox', { name: 'Description' });
      await waitForVisible(description, 'Dok description after Studio restart');
      assertEqual(
        await description.inputValue(),
        persistedDescription,
        'Restarted Studio did not read the saved Dok description',
      );
    });

    const lexiconOriginal = await readFile(scanned.lexiconPath);
    const lexiconMode = (await stat(scanned.lexiconPath)).mode & 0o777;
    try {
      await atomicWrite(scanned.lexiconPath, '{"terms":', lexiconMode);
      const invalidLexiconHash = await hashTree(scanned.hubDir);
      await recordAssertion('invalid-lexicon-no-write', 'invalid-lexicon-no-write.png', async () => {
        await page.goto(`${studioUrl}/lexicon`, { waitUntil: 'domcontentloaded' });
        const alert = recoveryAlert(page, 'lexicon could not be loaded');
        await waitForText(alert, 'lexicon could not be loaded', 'invalid Lexicon recovery alert');
        await waitForText(alert, 'No files were changed.', 'invalid Lexicon no-write message');
        assertEqual(
          await hashTree(scanned.hubDir),
          invalidLexiconHash,
          'Viewing invalid Lexicon data changed canonical bytes',
        );
      });
    } finally {
      await atomicWrite(scanned.lexiconPath, lexiconOriginal, lexiconMode);
    }

    const rolesOriginal = await readFile(scanned.rolesPath);
    const rolesMode = (await stat(scanned.rolesPath)).mode & 0o777;
    try {
      await atomicWriteJson(
        scanned.rolesPath,
        { version: 1, roles: [{ role_id: 'schema-invalid-role' }] },
        rolesMode,
      );
      const invalidRolesHash = await hashTree(scanned.hubDir);
      await recordAssertion('invalid-roles-no-write', 'invalid-roles-no-write.png', async () => {
        await page.goto(`${studioUrl}/roles`, { waitUntil: 'domcontentloaded' });
        const alert = recoveryAlert(page, 'roles could not be loaded');
        await waitForText(alert, 'roles could not be loaded', 'schema-invalid Roles recovery alert');
        await waitForText(alert, 'No files were changed.', 'invalid Roles no-write message');
        assertEqual(
          await hashTree(scanned.hubDir),
          invalidRolesHash,
          'Viewing schema-invalid Roles changed canonical bytes',
        );
      });
    } finally {
      await atomicWrite(scanned.rolesPath, rolesOriginal, rolesMode);
    }

    const unreadableDok = editableDok ?? scanned.doks[0];
    if (unreadableDok) {
      const unreadableOriginal = await readFile(unreadableDok.path);
      const unreadableMode = (await stat(unreadableDok.path)).mode & 0o777;
      const beforeUnreadable = await hashTree(scanned.hubDir);
      try {
        await chmod(unreadableDok.path, 0o000);
        await recordAssertion('unreadable-dok-no-write', 'unreadable-dok-no-write.png', async () => {
          await page.goto(`${studioUrl}/doks`, { waitUntil: 'domcontentloaded' });
          const alert = recoveryAlert(page, 'doks could not be loaded');
          await waitForText(alert, 'doks could not be loaded', 'unreadable Dok recovery alert');
          await waitForText(alert, 'No files were changed.', 'unreadable Dok no-write message');
          await chmod(unreadableDok.path, unreadableMode);
          assertEqual(
            Buffer.compare(await readFile(unreadableDok.path), unreadableOriginal),
            0,
            'Unreadable Dok bytes changed',
          );
          assertEqual(
            await hashTree(scanned.hubDir),
            beforeUnreadable,
            'Viewing an unreadable Dok changed canonical bytes',
          );
        });
      } finally {
        await chmod(unreadableDok.path, unreadableMode);
      }
    } else {
      await recordAssertion('unreadable-dok-no-write', 'unreadable-dok-no-write.png', async () => {
        throw new Error('Prepared workspace has no Dok for the unreadable-file assertion');
      });
    }

    const role = scanned.roles[0];
    let retainedRoleDescription = '';
    if (!role) {
      await recordAssertion('read-only-save-failure', 'read-only-save-failure.png', async () => {
        throw new Error('Prepared workspace has no Role for the permission assertion');
      });
      await recordAssertion(
        'retry-after-permission-restore',
        'retry-after-permission-restore.png',
        async () => {
          throw new Error('Prepared workspace has no Role for the retry assertion');
        },
      );
    } else {
      await page.goto(`${studioUrl}/roles/${encodeURIComponent(role.role_id)}`, {
        waitUntil: 'domcontentloaded',
      });
      const roleDescription = page.getByPlaceholder('Describe this role…');
      await waitForVisible(roleDescription, 'Role description editor');
      const beforePermissionBytes = await readFile(scanned.rolesPath);
      const hubMode = (await stat(scanned.hubDir)).mode & 0o777;
      retainedRoleDescription = `Studio retry persistence ${Date.now()}`;
      try {
        await chmod(scanned.hubDir, 0o555);
        await recordAssertion('read-only-save-failure', 'read-only-save-failure.png', async () => {
          await roleDescription.fill(retainedRoleDescription);
          await waitForStatus(
            page.getByRole('status'),
            'error',
            scanned.rolesPath,
            'persistent read-only save failure',
          );
          await page.waitForTimeout(1_500);
          await waitForStatus(
            page.getByRole('status'),
            'error',
            scanned.rolesPath,
            'save failure after persistence interval',
            1_000,
          );
          assertEqual(
            await roleDescription.inputValue(),
            retainedRoleDescription,
            'Failed Role input was not retained',
          );
          assertEqual(
            Buffer.compare(await readFile(scanned.rolesPath), beforePermissionBytes),
            0,
            'Read-only save attempt changed Roles bytes',
          );
        });
      } finally {
        await chmod(scanned.hubDir, hubMode);
      }

      await recordAssertion(
        'retry-after-permission-restore',
        'retry-after-permission-restore.png',
        async () => {
          assert(expectedRolesState, 'Roles expected transaction state is missing');
          const retry = page.getByRole('button', { name: 'Retry', exact: true });
          await waitForVisible(retry, 'Retry control after a save failure');
          let roleStateObserved = false;
          await retry.click();
          try {
            await waitForStatus(
              page.getByRole('status'),
              'saved',
              scanned.rolesPath,
              'saved status after restoring permission and retrying',
            );
          } finally {
            try {
              const observed = JSON.parse(await readFile(scanned.rolesPath, 'utf8'));
              const savedState = expectedRoleDescriptionEdit(
                expectedRolesState,
                role.role_id,
                retainedRoleDescription,
                observed.updated_at,
              );
              await expectRunnerOwnedState(
                trackedMutations,
                scanned.rolesPath,
                jsonBytes(savedState),
                rolesMode,
              );
              expectedRolesState = savedState;
              roleStateObserved = true;
            } catch {
              // Terminal verification must reject any state outside this exact edit.
            }
          }
          assert(roleStateObserved, 'Role retry produced bytes outside the expected transaction');
          const saved = JSON.parse(await readFile(scanned.rolesPath, 'utf8'));
          const savedRole = saved.roles.find((candidate) => candidate.role_id === role.role_id);
          assertEqual(
            savedRole?.description,
            retainedRoleDescription,
            'Retry did not persist the retained Role input',
          );
        },
      );
    }

    await recordAssertion('external-revision-conflict', 'external-revision-conflict.png', async () => {
      assert(role, 'Prepared workspace has no Role for the revision-conflict assertion');
      assert(expectedRolesState, 'Roles expected transaction state is missing');
      await page.goto(`${studioUrl}/roles/${encodeURIComponent(role.role_id)}`, {
        waitUntil: 'domcontentloaded',
      });
      const roleDescription = page.getByPlaceholder('Describe this role…');
      await waitForVisible(roleDescription, 'Role description editor for conflict assertion');
      await roleDescription.fill(`Studio conflict candidate ${Date.now()}`);

      assertEqual(
        Buffer.compare(await readFile(scanned.rolesPath), jsonBytes(expectedRolesState)),
        0,
        'Roles changed before the runner-owned external revision began',
      );
      const external = {
        ...expectedRolesState,
        future_external_revision: { retained: true },
      };
      const externalBytes = jsonBytes(external);
      await atomicWrite(scanned.rolesPath, externalBytes, rolesMode);
      await expectRunnerOwnedState(
        trackedMutations,
        scanned.rolesPath,
        externalBytes,
        rolesMode,
      );
      expectedRolesState = external;
      await waitForStatus(
        page.getByRole('status'),
        'conflict',
        scanned.rolesPath,
        'external revision conflict',
      );
      assertEqual(
        Buffer.compare(await readFile(scanned.rolesPath), externalBytes),
        0,
        'Studio overwrote the externally changed Roles file',
      );
    });

    await recordAssertion(
      'immediate-navigation-flush-or-block',
      'immediate-navigation-flush-or-block.png',
      async () => {
        assert(editableDok, 'Prepared workspace has no Dok for the navigation assertion');
        assert(expectedDokState, 'Editable Dok expected transaction state is missing');
        await page.goto(
          `${studioUrl}/doks/${encodeURIComponent(editableDok.dok.dok_id)}`,
          { waitUntil: 'domcontentloaded' },
        );
        const description = page.getByRole('textbox', { name: 'Description' });
        await waitForVisible(description, 'Dok description for navigation assertion');
        const navigationDescription = `Studio immediate navigation ${Date.now()}`;
        const navigationState = expectedDokDescriptionEdit(
          expectedDokState,
          navigationDescription,
        );
        const navigationBytes = jsonBytes(navigationState);
        const dokMode = trackedMutations.find(({ path }) => path === editableDok.path)?.expectedMode;
        assert(dokMode !== undefined, 'Editable Dok expected permission mode is missing');
        const originalUrl = page.url();
        await description.fill(navigationDescription);
        const sameOriginLink = page
          .locator('nav[aria-label="Dok tree"] a:not([aria-current="page"])')
          .first();
        await waitForVisible(sameOriginLink, 'different same-origin Dok navigation link');
        const destinationHref = await sameOriginLink.getAttribute('href');
        assert(destinationHref, 'Different Dok navigation link has no href');
        const destinationPath = new URL(destinationHref, studioUrl).pathname;
        await sameOriginLink.click();

        const deadline = Date.now() + UI_TIMEOUT_MS;
        let flushAndNavigation = false;
        let explicitBlock = false;
        let navigationStateObserved = false;
        try {
          while (Date.now() < deadline) {
            const current = JSON.parse(await readFile(editableDok.path, 'utf8'));
            const flushed = current.description === navigationDescription;
            const currentPath = new URL(page.url()).pathname;
            flushAndNavigation = flushed && currentPath === destinationPath;
            const statusText = (await page.getByRole('status').textContent().catch(() => '')) ?? '';
            explicitBlock =
              page.url() === originalUrl &&
              (statusMatches(statusText, 'error', editableDok.path) ||
                statusMatches(statusText, 'conflict', editableDok.path));
            if (flushAndNavigation || explicitBlock) break;
            await new Promise((done) => setTimeout(done, 100));
          }
          assert(
            flushAndNavigation || explicitBlock,
            'Immediate navigation neither flushed and changed route nor remained blocked with an error',
          );
        } finally {
          try {
            await expectRunnerOwnedState(
              trackedMutations,
              editableDok.path,
              navigationBytes,
              dokMode,
            );
            expectedDokState = navigationState;
            navigationStateObserved = true;
          } catch {
            // A blocked navigation retains the previous expected state instead.
          }
        }
        if (flushAndNavigation) {
          assert(
            navigationStateObserved,
            'Navigation save produced bytes outside the expected transaction',
          );
        }
      },
    );

    await recordAssertion(
      'no-browser-runtime-errors',
      'browser-runtime-errors.png',
      async () => {
        await page.waitForTimeout(0);
        assert(
          !result.browser_console.some(
            (record) => record.type === 'error' || record.type === 'pageerror',
          ),
          'Browser emitted console.error or an uncaught page error',
        );
      },
    );
  } catch (error) {
    result.assertions.push({
      name: 'studio-runner',
      status: 'fail',
      evidence: 'studio-result.json',
      error: safeFailure(error, args),
    });
  } finally {
    await finalizeEvidence({ browser, child, scanned, result, args, trackedMutations });
  }

  return result.assertions.every((entry) => entry.status === 'pass');
}

async function expectRejected(action, message) {
  let rejection = null;
  try {
    await action();
  } catch (error) {
    rejection = error;
  }
  assert(rejection, message);
  return rejection;
}

async function createContainmentFixture(root) {
  const workspace = join(root, 'workspace');
  const hubDir = join(workspace, '.doklo', 'hub');
  const doksDir = join(hubDir, 'doks');
  await mkdir(doksDir, { recursive: true });
  await writeFile(join(workspace, 'workspace.json'), '{}\n');
  await writeFile(join(hubDir, 'lexicon.json'), '{"version":1,"terms":[]}\n');
  await writeFile(join(hubDir, 'roles.json'), '{"version":1,"roles":[]}\n');
  await writeFile(join(doksDir, 'TEST.json'), '{"dok_id":"TEST"}\n');
  return { workspace, hubDir, doksDir };
}

async function runContractTests() {
  const tests = [
    {
      name: 'CLI requires an explicit disposable-workspace acknowledgement',
      run: async () => {
        const valueArgs = [
          '--binary',
          '/tmp/doklo',
          '--workspace',
          '/tmp/workspace',
          '--evidence-dir',
          '/tmp/evidence',
          '--repo-url',
          FROZEN_REPOSITORY_URL,
          '--repo-commit',
          FROZEN_REPOSITORY_COMMIT,
          '--model',
          FROZEN_MODEL,
        ];
        await expectRejected(
          async () => parseArgs(valueArgs),
          'CLI accepted a mutable workspace without disposable acknowledgement',
        );
        const parsed = parseArgs([...valueArgs, '--disposable-workspace']);
        assertEqual(
          parsed.disposableWorkspace,
          true,
          'CLI did not retain the disposable workspace acknowledgement',
        );
        await expectRejected(
          async () => parseArgs([
            ...valueArgs,
            '--disposable-workspace',
            '--disposable-workspace',
          ]),
          'CLI accepted duplicate disposable workspace acknowledgements',
        );
      },
    },
    {
      name: 'recovery alerts ignore the Next route announcer',
      run: async () => {
        function fakeLocator(elements) {
          return {
            filter: ({ hasText }) =>
              fakeLocator(elements.filter((element) => element.text.includes(hasText))),
            waitFor: async () => {
              assertEqual(
                elements.length,
                1,
                'Recovery alert locator did not resolve to exactly one element',
              );
              assert(elements[0].visible, 'Recovery alert locator selected a hidden element');
            },
            textContent: async () => elements[0]?.text ?? '',
          };
        }

        const page = {
          getByRole: (role) => {
            assertEqual(role, 'alert', 'Recovery alert queried the wrong semantic role');
            return fakeLocator([
              {
                visible: true,
                text: 'lexicon could not be loaded No files were changed.',
              },
              { visible: true, text: '' },
            ]);
          },
        };
        const alert = recoveryAlert(page, 'lexicon could not be loaded');
        await waitForText(alert, 'No files were changed.', 'truthful no-write recovery copy');
      },
    },
    {
      name: 'workspace provenance fails closed without changing bytes or modes',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-provenance-'));
        const runGitForTest = (gitArgs) =>
          new Promise((resolveCommand, rejectCommand) => {
            const child = spawn('git', gitArgs, {
              env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: '0',
                GIT_TERMINAL_PROMPT: '0',
              },
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => {
              stdout += chunk;
            });
            child.stderr.on('data', (chunk) => {
              stderr += chunk;
            });
            child.once('error', rejectCommand);
            child.once('close', (code) => {
              if (code === 0) resolveCommand(stdout.trim());
              else rejectCommand(new Error(stderr.trim() || 'git fixture command failed'));
            });
          });
        try {
          const binary = join(root, 'doklo');
          const evidenceDir = join(root, 'evidence');
          await writeFile(binary, '#!/bin/sh\nexit 0\n');
          await chmod(binary, 0o755);

          const workspace = join(root, 'workspace');
          await mkdir(workspace);
          await writeFile(join(workspace, 'workspace.json'), '{}\n');
          await runGitForTest(['init', '--quiet', workspace]);
          await runGitForTest(['-C', workspace, 'config', 'user.email', 'studio@example.invalid']);
          await runGitForTest(['-C', workspace, 'config', 'user.name', 'Studio Contract']);
          await runGitForTest(['-C', workspace, 'add', 'workspace.json']);
          await runGitForTest(['-C', workspace, 'commit', '--quiet', '-m', 'fixture']);
          await runGitForTest([
            '-C',
            workspace,
            'remote',
            'add',
            'origin',
            FROZEN_REPOSITORY_URL,
          ]);
          const head = await runGitForTest(['-C', workspace, 'rev-parse', 'HEAD']);
          const baseArgs = {
            binary,
            workspace,
            evidenceDir,
            repoUrl: FROZEN_REPOSITORY_URL,
            repoCommit: head,
            model: FROZEN_MODEL,
            disposableWorkspace: true,
          };

          const noConsentBefore = await hashTree(workspace);
          await expectRejected(
            () => validateInputs({ ...baseArgs, disposableWorkspace: false }),
            'Input validation accepted a workspace without disposable consent',
          );
          assertEqual(
            await hashTree(workspace),
            noConsentBefore,
            'Missing disposable consent changed workspace bytes or modes',
          );
          assertEqual(
            await lstat(evidenceDir).catch(() => null),
            null,
            'Missing disposable consent created evidence before failing closed',
          );

          const validBefore = await hashTree(workspace);
          const validated = await validateInputs(baseArgs);
          assertEqual(
            validated.workspace,
            await realpath(workspace),
            'Valid Git provenance did not retain the physical workspace root',
          );
          assertEqual(
            await hashTree(workspace),
            validBefore,
            'Valid Git provenance verification changed workspace bytes or modes',
          );

          const nonGitWorkspace = join(root, 'non-git-workspace');
          await mkdir(nonGitWorkspace);
          await writeFile(join(nonGitWorkspace, 'workspace.json'), '{}\n');
          const nonGitBefore = await hashTree(nonGitWorkspace);
          await expectRejected(
            () => validateInputs({ ...baseArgs, workspace: nonGitWorkspace }),
            'Non-Git workspace was accepted as public-repository evidence',
          );
          assertEqual(
            await hashTree(nonGitWorkspace),
            nonGitBefore,
            'Non-Git provenance rejection changed workspace bytes or modes',
          );

          await runGitForTest([
            '-C',
            workspace,
            'remote',
            'set-url',
            'origin',
            'https://example.invalid/wrong.git',
          ]);
          const wrongOriginBefore = await hashTree(workspace);
          await expectRejected(
            () => validateInputs(baseArgs),
            'Wrong Git origin was accepted as public-repository evidence',
          );
          assertEqual(
            await hashTree(workspace),
            wrongOriginBefore,
            'Wrong-origin rejection changed workspace bytes or modes',
          );

          await runGitForTest([
            '-C',
            workspace,
            'remote',
            'set-url',
            'origin',
            FROZEN_REPOSITORY_URL,
          ]);
          const wrongCommitBefore = await hashTree(workspace);
          await expectRejected(
            () => validateInputs({ ...baseArgs, repoCommit: '0'.repeat(40) }),
            'Wrong Git HEAD was accepted as public-repository evidence',
          );
          assertEqual(
            await hashTree(workspace),
            wrongCommitBefore,
            'Wrong-HEAD rejection changed workspace bytes or modes',
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'finalization verifies disposable runner-owned states without fake restoration',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-restore-'));
        try {
          const evidenceDir = join(root, 'evidence');
          const hubDir = join(root, 'hub');
          const dokPath = join(hubDir, 'dok.json');
          const rolesPath = join(hubDir, 'roles.json');
          const unrelatedPath = join(hubDir, 'unrelated.json');
          await mkdir(evidenceDir, { recursive: true });
          await mkdir(hubDir, { recursive: true });
          await writeFile(dokPath, '{"description":"original"}\n');
          await writeFile(rolesPath, '{"roles":[]}\n');
          await writeFile(unrelatedPath, '{"unchanged":true}\n');
          await chmod(dokPath, 0o640);
          await chmod(rolesPath, 0o660);
          const baseline = await hashTree(hubDir);
          let restorations = await snapshotRunnerOwnedFiles(hubDir, [dokPath, rolesPath]);
          const dokEdit = Buffer.from('{"description":"runner edit"}\n');
          const rolesEdit = Buffer.from('{"roles":[{"edited":true}]}\n');

          await atomicWrite(dokPath, dokEdit, 0o600);
          await atomicWrite(rolesPath, rolesEdit, 0o600);
          await expectRunnerOwnedState(restorations, dokPath, dokEdit, 0o600);
          await expectRunnerOwnedState(restorations, rolesPath, rolesEdit, 0o600);
          const args = {
            binary: join(root, 'doklo'),
            workspace: hubDir,
            evidenceDir,
          };
          const result = {
            assertions: [],
            workspace_mode: 'disposable-prepared-checkout',
            fs_before_sha256: baseline,
            fs_after_sha256: '',
          };
          await finalizeEvidence({
            browser: undefined,
            child: undefined,
            scanned: { hubDir },
            result,
            args,
            trackedMutations: restorations,
            operations: { stopStudio: async () => {} },
          });

          assertEqual(
            await readFile(dokPath, 'utf8'),
            '{"description":"runner edit"}\n',
            'Finalization unexpectedly rewrote disposable Dok bytes',
          );
          assertEqual(
            await readFile(rolesPath, 'utf8'),
            '{"roles":[{"edited":true}]}\n',
            'Finalization unexpectedly rewrote disposable Roles bytes',
          );
          assertEqual(
            (await stat(dokPath)).mode & 0o777,
            0o600,
            'Finalization unexpectedly rewrote disposable Dok permissions',
          );
          assertEqual(
            (await stat(rolesPath)).mode & 0o777,
            0o600,
            'Finalization unexpectedly rewrote disposable Roles permissions',
          );
          let ledger = JSON.parse(
            await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
          );
          assert(
            ledger.fs_after_sha256 !== baseline,
            'Disposable runner edits were falsely reported as filesystem identity',
          );
          assertEqual(
            ledger.workspace_mode,
            'disposable-prepared-checkout',
            'Evidence did not disclose disposable workspace mutation mode',
          );
          assert(
            ledger.assertions.filter(
              (entry) => entry.name === 'runner-owned-terminal-state' && entry.status === 'pass',
            ).length === 2,
            'Final evidence omitted exact runner-owned terminal state verification',
          );
          assert(
            !ledger.assertions.some((entry) => entry.name === 'final-filesystem-identity'),
            'Final evidence made a false filesystem identity claim',
          );

          restorations = await snapshotRunnerOwnedFiles(hubDir, [dokPath]);
          await atomicWrite(dokPath, dokEdit, 0o600);
          await expectRunnerOwnedState(restorations, dokPath, dokEdit, 0o600);
          const unexpectedDok = Buffer.from('{"description":"unexpected same-file edit"}\n');
          await atomicWrite(dokPath, unexpectedDok, 0o600);
          result.assertions = [];
          await finalizeEvidence({
            browser: undefined,
            child: undefined,
            scanned: { hubDir },
            result,
            args,
            trackedMutations: restorations,
            operations: { stopStudio: async () => {} },
          });
          ledger = JSON.parse(
            await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
          );
          assertEqual(
            Buffer.compare(await readFile(dokPath), unexpectedDok),
            0,
            'Terminal verification rewrote an unexpected same-file mutation',
          );
          assert(
            ledger.assertions.some(
              (entry) => entry.name === 'runner-owned-terminal-state' && entry.status === 'fail',
            ),
            'Same-file mismatch was not recorded as a terminal-state failure',
          );

          await atomicWrite(dokPath, '{"description":"original"}\n', 0o640);
          restorations = await snapshotRunnerOwnedFiles(hubDir, [dokPath]);
          await atomicWrite(dokPath, dokEdit, 0o600);
          await expectRunnerOwnedState(restorations, dokPath, dokEdit, 0o600);
          await atomicWrite(unrelatedPath, '{"unexpected":true}\n', 0o600);
          result.assertions = [];
          await finalizeEvidence({
            browser: undefined,
            child: undefined,
            scanned: { hubDir },
            result,
            args,
            trackedMutations: restorations,
            operations: { stopStudio: async () => {} },
          });
          ledger = JSON.parse(
            await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
          );
          assert(
            ledger.fs_before_sha256 !== ledger.fs_after_sha256 &&
              !ledger.assertions.some((entry) => entry.name === 'final-filesystem-identity'),
            'Evidence made a false identity claim after an unrelated disposable mutation',
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'terminal verification rejects parent symlinks without touching external targets',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-restore-symlink-'));
        try {
          const evidenceDir = join(root, 'evidence');
          const hubDir = join(root, 'hub');
          const doksDir = join(hubDir, 'doks');
          const parkedDoks = join(hubDir, 'parked-doks');
          const dokPath = join(doksDir, 'AUTH.json');
          const externalDir = join(root, 'external');
          const externalDok = join(externalDir, 'AUTH.json');
          await mkdir(evidenceDir, { recursive: true });
          await mkdir(doksDir, { recursive: true });
          await mkdir(externalDir);
          await writeFile(dokPath, '{"description":"original"}\n');
          await writeFile(externalDok, '{"external":"untouched"}\n');
          await chmod(externalDok, 0o640);
          const externalBytes = await readFile(externalDok);
          const externalMode = (await stat(externalDok)).mode & 0o777;
          const baseline = await hashTree(hubDir);
          const restorations = await snapshotRunnerOwnedFiles(hubDir, [dokPath]);
          const dokEdit = Buffer.from('{"description":"runner edit"}\n');
          await atomicWrite(dokPath, dokEdit, 0o600);
          await expectRunnerOwnedState(restorations, dokPath, dokEdit, 0o600);
          await rename(doksDir, parkedDoks);
          await symlink(externalDir, doksDir, 'dir');

          const result = {
            assertions: [],
            fs_before_sha256: baseline,
            fs_after_sha256: '',
          };
          await finalizeEvidence({
            browser: undefined,
            child: undefined,
            scanned: { hubDir },
            result,
            args: { binary: join(root, 'doklo'), workspace: hubDir, evidenceDir },
            trackedMutations: restorations,
            operations: { stopStudio: async () => {} },
          });
          const ledger = JSON.parse(
            await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
          );
          assertEqual(
            Buffer.compare(await readFile(externalDok), externalBytes),
            0,
            'Terminal verification followed a symlink parent and changed external bytes',
          );
          assertEqual(
            (await stat(externalDok)).mode & 0o777,
            externalMode,
            'Terminal verification followed a symlink parent and changed external permissions',
          );
          assert(
            ledger.assertions.some(
              (entry) => entry.name === 'runner-owned-terminal-state' && entry.status === 'fail',
            ),
            'Terminal parent-symlink rejection was not persisted as failed evidence',
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'terminal verification continues after one target fails',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-restore-partial-'));
        try {
          const evidenceDir = join(root, 'evidence');
          const hubDir = join(root, 'hub');
          const firstPath = join(hubDir, 'first.json');
          const secondPath = join(hubDir, 'second.json');
          await mkdir(evidenceDir, { recursive: true });
          await mkdir(hubDir);
          await writeFile(firstPath, 'first original\n');
          await writeFile(secondPath, 'second original\n');
          const baseline = await hashTree(hubDir);
          const restorations = await snapshotRunnerOwnedFiles(hubDir, [firstPath, secondPath]);
          await atomicWrite(firstPath, 'first runner edit\n', 0o600);
          await atomicWrite(secondPath, 'second runner edit\n', 0o600);
          await expectRunnerOwnedState(restorations, firstPath, 'first runner edit\n', 0o600);
          await expectRunnerOwnedState(restorations, secondPath, 'second runner edit\n', 0o600);
          await atomicWrite(firstPath, 'unexpected first edit\n', 0o600);

          const result = {
            assertions: [],
            fs_before_sha256: baseline,
            fs_after_sha256: '',
          };
          await finalizeEvidence({
            browser: undefined,
            child: undefined,
            scanned: { hubDir },
            result,
            args: { binary: join(root, 'doklo'), workspace: hubDir, evidenceDir },
            trackedMutations: restorations,
            operations: { stopStudio: async () => {} },
          });
          const ledger = JSON.parse(
            await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
          );
          assertEqual(
            await readFile(firstPath, 'utf8'),
            'unexpected first edit\n',
            'Terminal verification rewrote the failed first target',
          );
          assertEqual(
            await readFile(secondPath, 'utf8'),
            'second runner edit\n',
            'Terminal verification rewrote the passing second target',
          );
          assert(
            ledger.assertions.some(
              (entry) =>
                entry.name === 'runner-owned-terminal-state' &&
                entry.status === 'fail' &&
                entry.target === 'first.json',
            ) &&
              ledger.assertions.some(
                (entry) =>
                  entry.name === 'runner-owned-terminal-state' &&
                  entry.status === 'pass' &&
                  entry.target === 'second.json',
              ),
            'Per-target terminal verification did not continue after the first failure',
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'atomic writes clean temporary files and permit restore after directory fsync failure',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-atomic-'));
        const previousUmask = process.umask(0o022);
        try {
          const path = join(root, 'result.json');
          const original = Buffer.from('{"state":"original"}\n');
          await writeFile(path, original);
          await chmod(path, 0o660);
          await atomicWrite(path, '{"state":"updated"}\n', 0o660);
          assertEqual(
            await readFile(path, 'utf8'),
            '{"state":"updated"}\n',
            'Normal atomic write did not replace the destination',
          );
          assertEqual(
            (await stat(path)).mode & 0o777,
            0o660,
            'Normal atomic write changed the requested 0660 permission mode',
          );
          assertEqual(
            (await readdir(root)).filter((entry) => entry.includes('.studio-e2e-')).length,
            0,
            'Normal atomic write left a temporary file',
          );

          await expectRejected(
            () => atomicWrite(path, '{"state":"renamed"}\n', 0o660, {
              syncDirectory: async () => {
                throw new Error('injected directory fsync failure');
              },
            }),
            'Post-rename directory fsync failure was not reported',
          );
          assertEqual(
            await readFile(path, 'utf8'),
            '{"state":"renamed"}\n',
            'Injected fsync failure did not occur after rename',
          );
          assertEqual(
            (await stat(path)).mode & 0o777,
            0o660,
            'Post-rename fsync failure changed the requested 0660 permission mode',
          );
          assertEqual(
            (await readdir(root)).filter((entry) => entry.includes('.studio-e2e-')).length,
            0,
            'Failed atomic write left a temporary file',
          );
          await atomicWrite(path, original, 0o660);
          assertEqual(
            Buffer.compare(await readFile(path), original),
            0,
            'Caller could not restore original bytes after post-rename failure',
          );
          assertEqual(
            (await stat(path)).mode & 0o777,
            0o660,
            'Caller restore changed the original 0660 permission mode',
          );
        } finally {
          process.umask(previousUmask);
          await rm(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'filesystem hashes change for file-only and directory-only permission mutations',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-hash-mode-'));
        try {
          const childDir = join(root, 'child');
          const file = join(childDir, 'file.json');
          await mkdir(childDir);
          await writeFile(file, '{}\n');
          await chmod(root, 0o750);
          await chmod(childDir, 0o750);
          await chmod(file, 0o640);
          const baseline = await hashTree(root);

          await chmod(file, 0o600);
          const fileModeChanged = await hashTree(root);
          assert(
            fileModeChanged !== baseline,
            'Regular-file permission-only mutation did not change the filesystem hash',
          );

          await chmod(file, 0o640);
          assertEqual(
            await hashTree(root),
            baseline,
            'Restoring regular-file permissions did not restore the filesystem hash',
          );
          await chmod(childDir, 0o700);
          assert(
            (await hashTree(root)) !== baseline,
            'Directory permission-only mutation did not change the filesystem hash',
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'workspace preflight rejects root parent and leaf symlinks without touching targets',
      run: async () => {
        for (const attack of ['hub', 'doks-parent', 'lexicon-leaf', 'dok-leaf']) {
          const root = await mkdtemp(join(tmpdir(), `doklo-studio-${attack}-`));
          try {
            const fixture = await createContainmentFixture(root);
            const externalDir = join(root, 'external');
            const externalFile = join(externalDir, 'sentinel.json');
            await mkdir(externalDir, { recursive: true });
            await writeFile(externalFile, '{"external":"unchanged"}\n', { mode: 0o640 });
            const externalBytes = await readFile(externalFile);
            const externalMode = (await stat(externalFile)).mode & 0o777;

            if (attack === 'hub') {
              const externalHub = join(externalDir, 'hub');
              const externalDoks = join(externalHub, 'doks');
              await mkdir(externalDoks, { recursive: true });
              await writeFile(
                join(externalHub, 'lexicon.json'),
                '{"version":1,"terms":[]}\n',
              );
              await writeFile(
                join(externalHub, 'roles.json'),
                '{"version":1,"roles":[]}\n',
              );
              await writeFile(
                join(externalDoks, 'TEST.json'),
                '{"dok_id":"TEST","name":"Test","status":"active","tags":[],"surfaces":[],"description":"Test","_meta":{"version":1,"history":[]}}\n',
              );
              await rm(fixture.hubDir, { recursive: true, force: true });
              await symlink(externalHub, fixture.hubDir, 'dir');
            } else if (attack === 'doks-parent') {
              const externalDoks = join(externalDir, 'doks');
              await mkdir(externalDoks, { recursive: true });
              await writeFile(
                join(externalDoks, 'TEST.json'),
                '{"dok_id":"TEST","name":"Test","status":"active","tags":[],"surfaces":[],"description":"Test","_meta":{"version":1,"history":[]}}\n',
              );
              await rm(fixture.doksDir, { recursive: true, force: true });
              await symlink(externalDoks, fixture.doksDir, 'dir');
            } else if (attack === 'lexicon-leaf') {
              const lexiconPath = join(fixture.hubDir, 'lexicon.json');
              await unlink(lexiconPath);
              await symlink(externalFile, lexiconPath, 'file');
            } else {
              const dokPath = join(fixture.doksDir, 'TEST.json');
              await unlink(dokPath);
              await symlink(externalFile, dokPath, 'file');
            }
            const externalTreeBefore = await hashTree(externalDir);

            const containmentError = await expectRejected(
              () => preflightWorkspacePaths(fixture.workspace),
              `Workspace preflight accepted ${attack} symlink attack`,
            );
            assert(
              String(containmentError instanceof Error ? containmentError.message : containmentError)
                .includes('symlink'),
              `${attack} fixture failed for a reason other than symlink containment`,
            );
            assertEqual(
              Buffer.compare(await readFile(externalFile), externalBytes),
              0,
              `Workspace preflight changed ${attack} external bytes`,
            );
            assertEqual(
              (await stat(externalFile)).mode & 0o777,
              externalMode,
              `Workspace preflight changed ${attack} external permissions`,
            );
            assertEqual(
              await hashTree(externalDir),
              externalTreeBefore,
              `Workspace preflight changed ${attack} external tree bytes or permissions`,
            );

            if (attack === 'hub') {
              const evidenceDir = join(root, 'evidence');
              const passed = await runEvidence({
                binary: join(root, 'doklo'),
                workspace: fixture.workspace,
                evidenceDir,
                repoUrl: FROZEN_REPOSITORY_URL,
                repoCommit: FROZEN_REPOSITORY_COMMIT,
                model: FROZEN_MODEL,
              });
              assertEqual(passed, false, 'Symlink preflight failure returned success');
              const ledger = JSON.parse(
                await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
              );
              assert(
                ledger.assertions.some((entry) =>
                  entry.name === 'studio-runner' &&
                  entry.status === 'fail' &&
                  entry.error.includes('symlink')),
                'Symlink preflight failure did not write failed evidence',
              );
              assertEqual(
                Buffer.compare(await readFile(externalFile), externalBytes),
                0,
                'Failed evidence path changed external bytes',
              );
              assertEqual(
                (await stat(externalFile)).mode & 0o777,
                externalMode,
                'Failed evidence path changed external permissions',
              );
              assertEqual(
                await hashTree(externalDir),
                externalTreeBefore,
                'Failed evidence path changed external tree bytes or permissions',
              );
            }
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
      },
    },
    {
      name: 'process cleanup rejects a child that ignores TERM and KILL',
      run: async () => {
        class NeverExitChild extends EventEmitter {
          exitCode = null;
          signalCode = null;
          signals = [];

          kill(signal) {
            this.signals.push(signal);
            return true;
          }
        }
        const child = new NeverExitChild();
        await expectRejected(
          () => stopStudio(child, { termTimeoutMs: 1, killTimeoutMs: 1 }),
          'Non-terminating Studio child was treated as stopped',
        );
        assertEqual(child.signals.join(','), 'SIGTERM,SIGKILL', 'Cleanup signals were incomplete');
      },
    },
    {
      name: 'save statuses require the exact expected affected path',
      run: async () => {
        const path = '/workspace/.doklo/hub/roles.json';
        assert(statusMatches(`Saved · ${path}`, 'saved', path), 'Exact saved path did not match');
        assert(
          !statusMatches(`Saved · ${path}.stale`, 'saved', path),
          'Saved path prefix incorrectly matched',
        );
        assert(
          statusMatches(`Save failed · ${path}: permission denied`, 'error', path),
          'Exact failed path did not match',
        );
        assert(
          !statusMatches(`Save failed · ${path}.stale: denied`, 'error', path),
          'Failed path prefix incorrectly matched',
        );
        assert(
          statusMatches(`File changed outside Studio · ${path}`, 'conflict', path),
          'Exact conflict path did not match',
        );
      },
    },
    {
      name: 'cleanup and final hash failures are persisted as failed evidence',
      run: async () => {
        const root = await mkdtemp(join(tmpdir(), 'doklo-studio-finalize-'));
        try {
          const evidenceDir = join(root, 'evidence');
          const hubDir = join(root, 'hub');
          const targetPath = join(hubDir, 'runner-owned.json');
          await mkdir(evidenceDir, { recursive: true });
          await mkdir(hubDir, { recursive: true });
          await writeFile(targetPath, 'original\n');
          const restorations = await snapshotRunnerOwnedFiles(hubDir, [targetPath]);
          await atomicWrite(targetPath, 'runner edit\n', 0o600);
          await expectRunnerOwnedState(restorations, targetPath, 'runner edit\n', 0o600);
          const args = {
            binary: join(root, 'doklo'),
            workspace: join(root, 'workspace'),
            evidenceDir,
          };
          const result = {
            assertions: [],
            fs_before_sha256: await hashTree(hubDir),
            fs_after_sha256: '',
          };
          await finalizeEvidence({
            browser: {
              close: async () => {
                throw new Error('injected browser close failure');
              },
            },
            child: {},
            scanned: { hubDir },
            result,
            args,
            trackedMutations: restorations,
            operations: {
              stopStudio: async () => {
                throw new Error('injected Studio stop failure');
              },
              hashTree: async () => {
                throw new Error('injected final hash failure');
              },
            },
          });
          const ledger = JSON.parse(
            await readFile(join(evidenceDir, 'studio-result.json'), 'utf8'),
          );
          for (const name of [
            'browser-cleanup',
            'studio-process-cleanup',
            'runner-owned-terminal-state',
            'final-filesystem-hash',
          ]) {
            assert(
              ledger.assertions.some(
                (entry) => entry.name === name && entry.status === 'fail',
              ),
              `Final evidence omitted ${name} failure`,
            );
          }
          assertEqual(
            await readFile(targetPath, 'utf8'),
            'runner edit\n',
            'Cleanup failure rewrote runner-owned bytes while Studio remained live',
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    },
  ];

  for (const test of tests) {
    try {
      await test.run();
      process.stdout.write(`PASS ${test.name}\n`);
    } catch (error) {
      throw new Error(
        `Contract test failed: ${test.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (args.selfTest) {
      await runContractTests();
      process.stdout.write('Studio tarball contract tests passed.\n');
      return 0;
    }
    args = await validateInputs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 1;
  }

  return (await runEvidence(args)) ? 0 : 1;
}

process.exitCode = await main();
