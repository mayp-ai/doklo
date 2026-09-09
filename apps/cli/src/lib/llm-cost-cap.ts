import { randomUUID } from 'node:crypto';
import { access, open, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { LLMUsage } from '@doklo-beta/generator';
import { resolveContainedOutputPath } from '@doklo-beta/generator';
import { CommandContractError } from './command-result.js';
import { writeTextFileAtomic } from './atomic-file.js';
export const DEFAULT_MAX_TOKENS_PER_RUN = 1_000_000;
export const DEFAULT_MAX_TOKENS_TOTAL = 5_000_000;

export interface LlmTokenLimits {
  readonly maxTokensPerRun: number;
  readonly maxTokensTotal: number;
}

export function resolveLlmTokenLimits(
  input: Partial<LlmTokenLimits> = {},
  env: NodeJS.ProcessEnv = process.env,
): LlmTokenLimits {
  const parse = (value: string | number | undefined, fallback: number, field: string): number => {
    const count = value === undefined ? fallback : (typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value);
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError(`${field} must be a positive safe integer.`);
    }
    return count;
  };
  return Object.freeze({
    maxTokensPerRun: parse(input.maxTokensPerRun ?? env.DOKLO_MAX_TOKENS_PER_RUN, DEFAULT_MAX_TOKENS_PER_RUN, 'maxTokensPerRun'),
    maxTokensTotal: parse(input.maxTokensTotal ?? env.DOKLO_MAX_TOKENS_TOTAL, DEFAULT_MAX_TOKENS_TOTAL, 'maxTokensTotal'),
  });
}

/** Legacy accounting is preserved separately; historical usage cannot be reconstructed. */
export async function hasLegacyLlmCostLedger(root: string): Promise<boolean> {
  const cache = await resolveContainedOutputPath(root, '.doklo/cache');
  return lstat(join(cache, 'llm-cost-ledger.json')).then(() => true).catch((error) => {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  });
}

/** Read-only snapshot; reservations recheck the current totals under the ledger lock. */
export async function readLlmTokenBudget(root: string): Promise<{
  chargedTokens: number;
  legacyLedgerPresent: boolean;
}> {
  const paths = await ledgerPaths(root);
  const stat = await lstat(paths.ledger).catch((error) => {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    throw new LlmTokenCapError('LLM_TOKEN_LEDGER_INVALID', 'LLM token ledger cannot be a symlink.');
  }
  const ledger = await readLedger(paths.ledger);
  return { chargedTokens: chargedTotal(ledger.calls), legacyLedgerPresent: await hasLegacyLlmCostLedger(root) };
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 10;

type CallState = 'reserved' | 'settled' | 'retained' | 'overrun';

interface LedgerCall {
  callId: string;
  runId: string;
  receiptId: string;
  callKey: string;
  state: CallState;
  reservedTokens: number;
  actualTokens?: number;
  createdAt: string;
  updatedAt: string;
}

interface LedgerRun extends LlmTokenLimits {
  runId: string;
  receiptId: string;
  planDigest: string;
  maxCalls: number;
  createdAt: string;
}

interface Ledger {
  schema_version: 1;
  runs: LedgerRun[];
  calls: LedgerCall[];
}

export interface RegisteredLlmRun extends LlmTokenLimits {
  readonly root: string;
  readonly runId: string;
  readonly receiptId: string;
  readonly planDigest: string;
  readonly maxCalls: number;
}

class RegisteredWorkspaceLlmRun implements RegisteredLlmRun {
  constructor(
    readonly root: string,
    readonly runId: string,
    readonly receiptId: string,
    readonly planDigest: string,
    readonly maxCalls: number,
    readonly maxTokensPerRun: number,
    readonly maxTokensTotal: number,
  ) {}
}

export interface LlmCallReservation {
  readonly callId: string;
  readonly runId: string;
  readonly receiptId: string;
  readonly callKey: string;
  readonly reservedTokens: number;
}

export class LlmTokenCapError extends CommandContractError {
  readonly code:
    | 'LLM_RUN_TOKEN_CAP'
    | 'LLM_TOTAL_TOKEN_CAP'
    | 'LLM_CALL_ALREADY_RESERVED'
    | 'LLM_RECEIPT_ALREADY_CONSUMED'
    | 'LLM_CALL_COUNT_EXCEEDED'
    | 'LLM_TOKEN_LEDGER_INVALID'
    | 'LLM_TOKEN_LEDGER_LOCKED';

  constructor(code: LlmTokenCapError['code'], message: string) {
    super({
      schema_version: 1,
      command: 'llm',
      status: 'cancelled',
      data: null,
      diagnostics: [{ code, message }],
    }, 2);
    this.name = 'LlmTokenCapError';
    this.code = code;
  }
}

/**
 * Atomically consumes a consent receipt and opens its durable workspace run.
 * The returned identity is nominal and is only useful to the authorized-run
 * capability created by llm-preflight.ts.
 */
export async function registerLlmRun(
  root: string,
  input: { receiptId: string; planDigest: string; maxCalls: number } & Partial<LlmTokenLimits>,
): Promise<RegisteredLlmRun> {
  if (input.receiptId.trim() === '' || input.planDigest.trim() === '') {
    throw new TypeError('receiptId and planDigest must be non-empty strings.');
  }
  if (!Number.isInteger(input.maxCalls) || input.maxCalls <= 0) {
    throw new TypeError('maxCalls must be a positive integer.');
  }
  const limits = resolveLlmTokenLimits(input);
  const cacheDir = await resolveContainedOutputPath(root, '.doklo/cache');
  await mkdir(cacheDir, { recursive: true });
  const runId = randomUUID();
  await mutateLedger(root, (ledger) => {
    if (
      ledger.runs.some((run) => run.receiptId === input.receiptId)
      || ledger.calls.some((call) => call.receiptId === input.receiptId)
    ) {
      throw new LlmTokenCapError(
        'LLM_RECEIPT_ALREADY_CONSUMED',
        `LLM consent receipt "${input.receiptId}" was already consumed.`,
      );
    }
    ledger.runs.push({
      runId,
      receiptId: input.receiptId,
      planDigest: input.planDigest,
      maxCalls: input.maxCalls,
      ...limits,
      createdAt: new Date().toISOString(),
    });
  });
  return new RegisteredWorkspaceLlmRun(
    root,
    runId,
    input.receiptId,
    input.planDigest,
    input.maxCalls,
    limits.maxTokensPerRun,
    limits.maxTokensTotal,
  );
}

export async function reserveRegisteredLlmCall(
  run: RegisteredLlmRun,
  input: { callKey: string; reservedTokens: number },
): Promise<LlmCallReservation> {
  const registered = requireRegisteredRun(run);
  const reservedTokens = checkedTokens(input.reservedTokens, 'reservedTokens');
  if (input.callKey.trim() === '') throw new TypeError('callKey must be a non-empty string.');
  const call = await mutateLedger(registered.root, (ledger) => {
    const persistedRun = ledger.runs.find((item) =>
      item.runId === registered.runId
      && item.receiptId === registered.receiptId
      && item.planDigest === registered.planDigest);
    if (!persistedRun || persistedRun.maxCalls !== registered.maxCalls) {
      throw new LlmTokenCapError('LLM_TOKEN_LEDGER_INVALID', 'Authorized LLM run is not registered.');
    }
    const runCalls = ledger.calls.filter((item) => item.runId === registered.runId);
    if (runCalls.length >= persistedRun.maxCalls) {
      throw new LlmTokenCapError(
        'LLM_CALL_COUNT_EXCEEDED',
        'The authorized LLM run exhausted its durable call allowance.',
      );
    }
    if (ledger.calls.some((item) =>
      item.receiptId === registered.receiptId && item.callKey === input.callKey)) {
      throw new LlmTokenCapError(
        'LLM_CALL_ALREADY_RESERVED',
        `LLM call "${input.callKey}" was already reserved for this receipt.`,
      );
    }
    const runTokens = chargedTotal(runCalls);
    assertCaps(ledger, runTokens, reservedTokens, persistedRun);
    const now = new Date().toISOString();
    const next: LedgerCall = {
      callId: randomUUID(),
      runId: registered.runId,
      receiptId: registered.receiptId,
      callKey: input.callKey,
      state: 'reserved',
      reservedTokens,
      createdAt: now,
      updatedAt: now,
    };
    ledger.calls.push(next);
    return next;
  });
  return freezeReservation(call);
}

export async function reconcileRegisteredLlmCall(
  run: RegisteredLlmRun,
  reservation: LlmCallReservation,
  usage: LLMUsage | null | undefined,
): Promise<number> {
  const registered = requireRegisteredRun(run);
  return reconcilePersistedCall(registered.root, registered.runId, reservation, usage);
}

async function reconcilePersistedCall(
  root: string,
  runId: string,
  reservation: LlmCallReservation,
  usage: LLMUsage | null | undefined,
  setRunTokens?: (value: number) => void,
): Promise<number> {
  const outcome = await mutateLedger(root, (ledger): {
    actualTokens: number;
    breach?: LlmTokenCapError;
  } => {
    const call = ledger.calls.find((item) =>
      item.callId === reservation.callId
      && item.runId === runId
      && item.receiptId === reservation.receiptId
      && item.callKey === reservation.callKey);
    if (!call || call.state !== 'reserved') {
      throw new LlmTokenCapError('LLM_TOKEN_LEDGER_INVALID', 'LLM reservation is missing or settled.');
    }
    call.updatedAt = new Date().toISOString();
    const actualTokens = usageToTokens(usage);
    if (actualTokens === null) {
      call.state = 'retained';
      setRunTokens?.(chargedTotal(ledger.calls.filter((item) => item.runId === runId)));
      return { actualTokens: call.reservedTokens };
    }

    const limits = ledger.runs.find((run) => run.runId === runId)!;
    call.actualTokens = actualTokens;
    call.state = actualTokens > call.reservedTokens ? 'overrun' : 'settled';
    const runTokens = chargedTotal(ledger.calls.filter((item) =>
      item.runId === runId));
    const totalTokens = chargedTotal(ledger.calls);
    setRunTokens?.(runTokens);
    if (runTokens > limits.maxTokensPerRun) {
      return {
        actualTokens: actualTokens,
        breach: new LlmTokenCapError(
          'LLM_RUN_TOKEN_CAP',
          `Provider usage exceeded the ${limits.maxTokensPerRun} token run cap.`,
        ),
      };
    }
    if (totalTokens > limits.maxTokensTotal) {
      return {
        actualTokens: actualTokens,
        breach: new LlmTokenCapError(
          'LLM_TOTAL_TOKEN_CAP',
          `Provider usage exceeded the ${limits.maxTokensTotal} token total cap.`,
        ),
      };
    }
    return { actualTokens: actualTokens };
  });
  if (outcome.breach) throw outcome.breach;
  return outcome.actualTokens;
}

export function estimateConservativeLlmCallTokens(
  prompt: string,
  maxOutputTokens: number,
): number {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 0) {
    throw new TypeError('maxOutputTokens must be a non-negative integer.');
  }
  return checkedTokens(Buffer.byteLength(prompt, 'utf8') + maxOutputTokens, 'reservation');
}

function usageToTokens(usage: LLMUsage | null | undefined): number | null {
  if (!usage) return null;
  const counts = [usage.input_tokens, usage.output_tokens,
    usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)) return null;
  const total = counts.reduce((sum, count) => sum + count, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function chargedTotal(calls: readonly LedgerCall[]): number {
  return calls.reduce((sum, call) => sum + (
    call.state === 'settled' || call.state === 'overrun'
      ? (call.actualTokens ?? call.reservedTokens)
      : call.reservedTokens
  ), 0);
}

function requireRegisteredRun(run: RegisteredLlmRun): RegisteredWorkspaceLlmRun {
  if (!(run instanceof RegisteredWorkspaceLlmRun)) {
    throw new TypeError('A registered workspace LLM run is required.');
  }
  return run;
}

function assertCaps(ledger: Ledger, runTokens: number, reservedTokens: number, limits: LlmTokenLimits): void {
  if (runTokens + reservedTokens > limits.maxTokensPerRun) {
    throw new LlmTokenCapError(
      'LLM_RUN_TOKEN_CAP',
      `Next LLM call would exceed the ${limits.maxTokensPerRun} token run cap.`,
    );
  }
  if (chargedTotal(ledger.calls) + reservedTokens > limits.maxTokensTotal) {
    throw new LlmTokenCapError(
      'LLM_TOTAL_TOKEN_CAP',
      `Next LLM call would exceed the ${limits.maxTokensTotal} token total cap.`,
    );
  }
}

function freezeReservation(call: LedgerCall): LlmCallReservation {
  return Object.freeze({
    callId: call.callId,
    runId: call.runId,
    receiptId: call.receiptId,
    callKey: call.callKey,
    reservedTokens: call.reservedTokens,
  });
}

function checkedTokens(count: number, field: string): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return count;
}

async function mutateLedger<T>(root: string, mutation: (ledger: Ledger) => T): Promise<T> {
  const paths = await ledgerPaths(root);
  const release = await acquireLock(paths.lock, paths.queue);
  try {
    const ledgerStat = await lstat(paths.ledger).catch((error) => {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (ledgerStat?.isSymbolicLink()) {
      throw new LlmTokenCapError('LLM_TOKEN_LEDGER_INVALID', 'LLM token ledger cannot be a symlink.');
    }
    const ledger = await readLedger(paths.ledger);
    const value = mutation(ledger);
    await writeTextFileAtomic(paths.ledger, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    return value;
  } finally {
    await release();
  }
}

async function ledgerPaths(root: string): Promise<{ ledger: string; lock: string; queue: string }> {
  const cacheDir = await resolveContainedOutputPath(root, '.doklo/cache');
  return {
    ledger: join(cacheDir, 'llm-token-ledger.json'),
    lock: join(cacheDir, 'llm-token-ledger.lock'),
    queue: join(cacheDir, 'llm-token-ledger.queue'),
  };
}

async function readLedger(path: string): Promise<Ledger> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { schema_version: 1, runs: [], calls: [] };
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Ledger;
    if (value.schema_version !== 1 || !Array.isArray(value.calls)
      || !value.calls.every(isLedgerCall)
      || (value.runs !== undefined && (!Array.isArray(value.runs) || !value.runs.every(isLedgerRun)))) {
      throw new Error('invalid ledger schema');
    }
    return { ...value, runs: value.runs ?? [] };
  } catch {
    throw new LlmTokenCapError('LLM_TOKEN_LEDGER_INVALID', 'LLM token ledger is invalid.');
  }
}

function isLedgerRun(value: unknown): value is LedgerRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<LedgerRun>;
  return typeof run.runId === 'string'
    && typeof run.receiptId === 'string'
    && typeof run.planDigest === 'string'
    && Number.isInteger(run.maxCalls) && (run.maxCalls ?? 0) > 0
    && Number.isSafeInteger(run.maxTokensPerRun) && (run.maxTokensPerRun ?? 0) > 0
    && Number.isSafeInteger(run.maxTokensTotal) && (run.maxTokensTotal ?? 0) > 0
    && typeof run.createdAt === 'string';
}

function isLedgerCall(value: unknown): value is LedgerCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<LedgerCall>;
  return typeof call.callId === 'string'
    && typeof call.runId === 'string'
    && typeof call.receiptId === 'string'
    && typeof call.callKey === 'string'
    && ['reserved', 'settled', 'retained', 'overrun'].includes(call.state ?? '')
    && Number.isSafeInteger(call.reservedTokens) && (call.reservedTokens ?? -1) >= 0
    && (call.actualTokens === undefined
      || (Number.isSafeInteger(call.actualTokens) && call.actualTokens >= 0))
    && typeof call.createdAt === 'string'
    && typeof call.updatedAt === 'string';
}

interface OwnedLock {
  token: string;
  dev: number;
  ino: number;
}

interface QueueDirectory {
  path: string;
  dev: number;
  ino: number;
}

interface QueueEntry extends OwnedLock {
  path: string;
  kind: 'choosing' | 'ticket';
  pid: number;
  hostname: string;
  number?: number;
}

interface QueueState {
  blocked: boolean;
  choosing: QueueEntry[];
  tickets: QueueEntry[];
}

const QUEUE_ENTRY_PATTERN = /^(choosing|ticket)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

async function acquireLock(path: string, queuePath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const queue = await ensureQueueDirectory(queuePath);
  const token = randomUUID();
  const choosingPath = join(queue.path, `choosing-${token}.json`);
  const choosing = await createQueueEntry(choosingPath, {
    kind: 'choosing',
    token,
    pid: process.pid,
    hostname: hostname(),
  });
  let ticket: QueueEntry | undefined;

  try {
    const initial = await readQueueState(queue);
    const maxNumber = initial.tickets.reduce((max, entry) => Math.max(max, entry.number ?? 0), 0);
    if (maxNumber >= Number.MAX_SAFE_INTEGER - 1) {
      throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'LLM token ledger queue is exhausted.');
    }
    const number = maxNumber + 1;
    const ticketPath = join(queue.path, `ticket-${token}.json`);
    ticket = await createQueueEntry(ticketPath, {
      kind: 'ticket',
      token,
      pid: process.pid,
      hostname: hostname(),
      number,
    });
    await unlinkOwnedLock(choosing.path, choosing);

    for (;;) {
      const state = await readQueueState(queue);
      const earlierTicket = state.tickets.some((entry) => (
        entry.token !== token
        && compareTicket(entry, ticket as QueueEntry) < 0
      ));
      if (!state.blocked && state.choosing.length === 0 && !earlierTicket) {
        await waitAtQueueHeadTestBarrier();
        await recoverDeadSameHostLock(path);
        const owned = await tryCreateOwnedLock(path);
        if (owned) {
          const ownedTicket = ticket;
          return async () => {
            await unlinkOwnedLock(path, owned);
            await unlinkOwnedLock(ownedTicket.path, ownedTicket);
          };
        }
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'Timed out waiting for LLM token ledger lock.');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  } catch (error) {
    if (ticket) await unlinkOwnedLock(ticket.path, ticket).catch(() => undefined);
    await unlinkOwnedLock(choosing.path, choosing).catch(() => undefined);
    throw error;
  }
}

async function ensureQueueDirectory(path: string): Promise<QueueDirectory> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'LLM token ledger queue is invalid.');
  }
  return { path, dev: stat.dev, ino: stat.ino };
}

async function assertQueueDirectory(queue: QueueDirectory): Promise<void> {
  const stat = await lstat(queue.path).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()
    || stat.dev !== queue.dev || stat.ino !== queue.ino) {
    throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'LLM token ledger queue ownership changed.');
  }
}

async function createQueueEntry(
  path: string,
  input: {
    kind: 'choosing' | 'ticket';
    token: string;
    pid: number;
    hostname: string;
    number?: number;
  },
): Promise<QueueEntry> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    throw new LlmTokenCapError(
      'LLM_TOKEN_LEDGER_LOCKED',
      isNodeError(error, 'EEXIST')
        ? 'LLM token ledger queue token collided.'
        : 'Unable to create LLM token ledger queue entry.',
    );
  }
  const acquiredStat = await handle.stat();
  const owned: QueueEntry = {
    ...input,
    path,
    dev: acquiredStat.dev,
    ino: acquiredStat.ino,
  };
  try {
    await handle.writeFile(JSON.stringify({
      schema_version: 1,
      ...input,
      createdAt: new Date().toISOString(),
    }));
    await handle.sync();
    return owned;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkOwnedLock(path, owned).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readQueueState(queue: QueueDirectory): Promise<QueueState> {
  await assertQueueDirectory(queue);
  const names = (await readdir(queue.path)).sort();
  const state: QueueState = { blocked: false, choosing: [], tickets: [] };

  for (const name of names) {
    const match = QUEUE_ENTRY_PATTERN.exec(name);
    if (!match) {
      state.blocked = true;
      continue;
    }
    const expectedKind = match[1] as 'choosing' | 'ticket';
    const expectedToken = match[2] as string;
    const entry = await readQueueEntry(join(queue.path, name), expectedKind, expectedToken);
    if (!entry) {
      state.blocked = true;
      continue;
    }
    if (entry.hostname !== hostname()) {
      state.blocked = true;
      continue;
    }
    if (await isDeadPid(entry.pid)) {
      const removed = await unlinkOwnedLock(entry.path, entry)
        .then(() => true)
        .catch(() => false);
      if (!removed) state.blocked = true;
      continue;
    }
    if (entry.kind === 'choosing') state.choosing.push(entry);
    else state.tickets.push(entry);
  }
  return state;
}

async function readQueueEntry(
  path: string,
  expectedKind: 'choosing' | 'ticket',
  expectedToken: string,
): Promise<QueueEntry | null> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (value['schema_version'] !== 1
      || value['kind'] !== expectedKind
      || value['token'] !== expectedToken
      || typeof value['hostname'] !== 'string'
      || !Number.isInteger(value['pid'])
      || (value['pid'] as number) <= 0
      || typeof value['createdAt'] !== 'string'
      || (expectedKind === 'ticket'
        && (!Number.isSafeInteger(value['number']) || (value['number'] as number) <= 0))) {
      return null;
    }
    return {
      path,
      kind: expectedKind,
      token: expectedToken,
      pid: value['pid'] as number,
      hostname: value['hostname'],
      number: expectedKind === 'ticket' ? value['number'] as number : undefined,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    return null;
  }
}

async function isDeadPid(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, 'ESRCH');
  }
}

function compareTicket(left: QueueEntry, right: QueueEntry): number {
  const numberDifference = (left.number ?? 0) - (right.number ?? 0);
  return numberDifference === 0 ? left.token.localeCompare(right.token) : numberDifference;
}

async function tryCreateOwnedLock(path: string): Promise<OwnedLock | null> {
  const token = randomUUID();
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return null;
    throw error;
  }
  try {
    const metadata = JSON.stringify({
      schema_version: 1,
      token,
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    });
    await handle.writeFile(metadata);
    await handle.sync();
    const acquiredStat = await handle.stat();
    return { token, dev: acquiredStat.dev, ino: acquiredStat.ino };
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function unlinkOwnedLock(path: string, owned: OwnedLock): Promise<void> {
  const pathStat = await lstat(path).catch(() => undefined);
  if (!pathStat || pathStat.dev !== owned.dev || pathStat.ino !== owned.ino) {
    throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'LLM token lock ownership changed.');
  }
  const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
  if (current.token !== owned.token) {
    throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'LLM token lock token changed.');
  }
  await unlink(path);
}

async function recoverDeadSameHostLock(path: string): Promise<void> {
  let before;
  try {
    before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) return;
    const lock = JSON.parse(await readFile(path, 'utf8')) as {
      hostname?: unknown;
      pid?: unknown;
      token?: unknown;
    };
    if (
      lock.hostname !== hostname()
      || !Number.isInteger(lock.pid)
      || (lock.pid as number) <= 0
      || typeof lock.token !== 'string'
    ) return;
    try {
      process.kill(lock.pid as number, 0);
      return;
    } catch (error) {
      if (!isNodeError(error, 'ESRCH')) return;
    }
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino) return;
    const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
    if (current.token !== lock.token) return;
    await unlink(path);
  } catch {
    // Malformed, foreign-host, and racy locks fail closed until the bounded timeout.
  }
}

async function waitAtQueueHeadTestBarrier(): Promise<void> {
  if (process.env['NODE_ENV'] !== 'test') return;
  const ready = process.env['DOKLO_TEST_LLM_LOCK_HEAD_READY'];
  const proceed = process.env['DOKLO_TEST_LLM_LOCK_HEAD_CONTINUE'];
  if (!ready || !proceed) return;
  await writeFile(ready, 'ready', { mode: 0o600 });
  const startedAt = Date.now();
  for (;;) {
    try {
      await access(proceed);
      return;
    } catch {
      if (Date.now() - startedAt >= 10_000) {
        throw new LlmTokenCapError('LLM_TOKEN_LEDGER_LOCKED', 'Timed out at queue-head test barrier.');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === code;
}
