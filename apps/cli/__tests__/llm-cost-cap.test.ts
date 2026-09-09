import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  estimateConservativeLlmCallTokens,
  reconcileRegisteredLlmCall,
  registerLlmRun,
  reserveRegisteredLlmCall,
} from '../src/lib/llm-cost-cap.js';

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-spend-'));
  await mkdir(join(root, '.doklo/cache'), { recursive: true });
  return root;
}

async function ledgerTotal(root: string): Promise<number> {
  const raw = JSON.parse(await readFile(join(root, '.doklo/cache/llm-token-ledger.json'), 'utf8')) as {
    calls: Array<{
      state: 'reserved' | 'settled' | 'retained' | 'overrun';
      reservedTokens: number;
      actualTokens?: number;
    }>;
  };
  return raw.calls.reduce((sum, call) => sum + (
    call.state === 'settled' || call.state === 'overrun'
      ? (call.actualTokens ?? call.reservedTokens)
      : call.reservedTokens
  ), 0);
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`timed out waiting for recovery barrier ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

let callSerial = 0;
const openRun = (root: string, maxCalls = 100) => registerLlmRun(root, {
  receiptId: `receipt-${callSerial++}`,
  planDigest: `plan-${callSerial}`,
  maxCalls,
});
const reserve = (run: Awaited<ReturnType<typeof registerLlmRun>>, reservedTokens: number) =>
  reserveRegisteredLlmCall(run, {
    callKey: `test/call-${callSerial++}`,
    reservedTokens,
  });

describe('workspace-persistent LLM token caps', () => {
  it('reserves UTF-8 bytes plus the full allowed output token budget', () => {
    expect(estimateConservativeLlmCallTokens('한', 32_768)).toBeCloseTo(
      3 + 32_768,
      12,
    );
  });

  it('does not let a new caller forge a zero total', async () => {
    const root = await workspace();
    for (let i = 0; i < 5; i++) {
      const priorRun = await openRun(root);
      await reserve(priorRun, 996000);
    }

    const nextRun = await openRun(root);

    await expect(reserve(nextRun, 22000)).rejects.toMatchObject({
      code: 'LLM_TOTAL_TOKEN_CAP',
      exitCode: 2,
    });
    expect(await ledgerTotal(root)).toBeCloseTo(4_980_000, 8);
  });

  it('serializes concurrent reservations so only 5,000,000 total tokens can be reserved', async () => {
    const root = await workspace();
    const meters = await Promise.all(
      Array.from({ length: 6 }, () => openRun(root)),
    );

    const results = await Promise.allSettled(meters.map((meter) => reserve(meter, 1000000)));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await ledgerTotal(root)).toBe(5_000_000);
  });

  it('retains a conservative reservation when provider usage is missing', async () => {
    const root = await workspace();
    const meter = await openRun(root);
    const reservation = await reserve(meter, 520000);

    await reconcileRegisteredLlmCall(meter, reservation, null);

    await expect(reserve(meter, 500000)).rejects.toMatchObject({
      code: 'LLM_RUN_TOKEN_CAP',
      exitCode: 2,
    });
    expect(await ledgerTotal(root)).toBe(520_000);
  });

  it('retains a reservation after a failed or crashed provider attempt', async () => {
    const root = await workspace();
    const failedRun = await openRun(root);
    await reserve(failedRun, 980000);

    const newProcessRun = await openRun(root);
    await expect(reserve(newProcessRun, 980000)).resolves.toBeDefined();
    expect(await ledgerTotal(root)).toBe(1_960_000);
  });

  it('reconciles a conservative reservation downward only when usage is reported', async () => {
    const root = await workspace();
    const meter = await openRun(root);
    const reservation = await reserve(meter, 800000);

    const actual = await reconcileRegisteredLlmCall(meter, reservation, {
      input_tokens: 100_000,
      output_tokens: 0,
    });

    expect(actual).toBeCloseTo(100_000, 8);
    expect(await ledgerTotal(root)).toBeCloseTo(100_000, 8);
  });

  it('rejects duplicate deterministic call keys and records an actual-token overrun', async () => {
    const root = await workspace();
    const meter = await openRun(root, 2);
    const input = { callKey: 'generate/web/AUTH', reservedTokens: 20000 };
    const reservation = await reserveRegisteredLlmCall(meter, input);

    await expect(reserveRegisteredLlmCall(meter, input)).rejects.toMatchObject({
      code: 'LLM_CALL_ALREADY_RESERVED',
      exitCode: 2,
    });
    await expect(reconcileRegisteredLlmCall(meter, reservation, {
      input_tokens: 2_000_000,
      output_tokens: 0,
    })).rejects.toMatchObject({ code: 'LLM_RUN_TOKEN_CAP', exitCode: 2 });
    expect(await ledgerTotal(root)).toBe(2_000_000);
  });

  it('rejects the same receipt and call key globally across newly opened runs', async () => {
    const root = await workspace();
    const first = await registerLlmRun(root, {
      receiptId: 'receipt-global', planDigest: 'plan-a', maxCalls: 1,
    });
    await reserveRegisteredLlmCall(first, {
      callKey: 'generate/web/AUTH', reservedTokens: 20000,
    });

    await expect(
      registerLlmRun(root, {
        receiptId: 'receipt-global', planDigest: 'plan-b', maxCalls: 1,
      }),
    ).rejects.toMatchObject({
      code: 'LLM_RECEIPT_ALREADY_CONSUMED',
      exitCode: 2,
    });
  });

  it('enforces the registered call-count maximum in the durable ledger', async () => {
    const root = await workspace();
    const run = await registerLlmRun(root, {
      receiptId: 'receipt-count-max', planDigest: 'plan-count-max', maxCalls: 1,
    });
    await reserveRegisteredLlmCall(run, { callKey: 'generate/web/AUTH', reservedTokens: 20000 });

    await expect(reserveRegisteredLlmCall(run, {
      callKey: 'generate/web/USER', reservedTokens: 20000,
    })).rejects.toMatchObject({ code: 'LLM_CALL_COUNT_EXCEEDED', exitCode: 2 });
  });

  it('uses the filesystem lock across child processes and retains a crashed child reservation', async () => {
    const root = await workspace();
    const fixture = fileURLToPath(new URL('./fixtures/llm-cost-child.ts', import.meta.url));
    const runChild = (mode: 'reserve' | 'crash', amount: string, index: number) =>
      promisify(execFile)(process.execPath, [
        '--import', 'tsx', fixture, root, mode, amount, String(index),
      ], { cwd: process.cwd() });

    const concurrent = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => runChild('reserve', '800000', index)),
    );
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    expect(await ledgerTotal(root)).toBe(4_800_000);

    await expect(runChild('crash', '100000', 99)).rejects.toBeDefined();
    expect(await ledgerTotal(root)).toBe(4_900_000);

    await expect(reserve(await openRun(root), 120000)).rejects.toMatchObject({
      code: 'LLM_TOTAL_TOKEN_CAP',
    });
  });

  it('serializes concurrent stale-lock recovery across processes without unlinking a new owner', async () => {
    const root = await workspace();
    const fixture = fileURLToPath(new URL('./fixtures/llm-cost-child.ts', import.meta.url));
    const lockPath = join(root, '.doklo/cache/llm-token-ledger.lock');
    await writeFile(lockPath, JSON.stringify({
      token: 'dead-owner',
      pid: 999_999_999,
      hostname: hostname(),
      createdAt: '2020-01-01T00:00:00.000Z',
    }), { mode: 0o600 });
    const runChild = (index: number) => promisify(execFile)(process.execPath, [
      '--import', 'tsx', fixture, root, 'reserve', '20000', String(index),
    ], { cwd: process.cwd() });

    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, index) => runChild(index)),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected, rejected.map((result) => String(result.reason))).toHaveLength(0);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(24);
    expect(await ledgerTotal(root)).toBeCloseTo(480_000, 8);
  }, 60_000);

  it('recovers after a process crashes while holding the queue-head role', async () => {
    const root = await workspace();
    const fixture = fileURLToPath(new URL('./fixtures/llm-cost-child.ts', import.meta.url));
    const readyPath = join(root, '.doklo/cache/queue-head-ready');
    const child = spawn(process.execPath, [
      '--import', 'tsx', fixture, root, 'reserve', '20000', '100',
    ], {
      cwd: process.cwd(),
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DOKLO_TEST_LLM_LOCK_HEAD_READY: readyPath,
        DOKLO_TEST_LLM_LOCK_HEAD_CONTINUE: join(root, '.doklo/cache/queue-head-continue'),
      },
    });
    await waitForFile(readyPath);
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    await expect(promisify(execFile)(process.execPath, [
      '--import', 'tsx', fixture, root, 'reserve', '20000', '101',
    ], { cwd: process.cwd() })).resolves.toBeDefined();
    expect(await ledgerTotal(root)).toBeCloseTo(20_000, 8);
  }, 15_000);

  it.each(['foreign', 'unknown'] as const)('fails closed on a %s queue entry', async (kind) => {
    const root = await workspace();
    const fixture = fileURLToPath(new URL('./fixtures/llm-cost-child.ts', import.meta.url));
    const queuePath = join(root, '.doklo/cache/llm-token-ledger.queue');
    await mkdir(queuePath, { mode: 0o700 });
    if (kind === 'foreign') {
      const token = '00000000-0000-4000-8000-000000000001';
      await writeFile(join(queuePath, `ticket-${token}.json`), JSON.stringify({
        schema_version: 1,
        kind: 'ticket',
        token,
        pid: 999_999_999,
        hostname: 'foreign-host.invalid',
        number: 1,
        createdAt: '2020-01-01T00:00:00.000Z',
      }), { mode: 0o600 });
    } else {
      await writeFile(join(queuePath, 'unknown-entry'), 'unverifiable', { mode: 0o600 });
    }
    const child = spawn(process.execPath, [
      '--import', 'tsx', fixture, root, 'reserve', '20000', `blocked-${kind}`,
    ], { cwd: process.cwd(), stdio: 'ignore' });
    const startedAt = Date.now();
    for (;;) {
      const names = await readdir(queuePath);
      if (names.some((name) => name.startsWith('ticket-')
        && !name.includes('00000000-0000-4000-8000-000000000001'))) break;
      if (Date.now() - startedAt > 2_000) throw new Error('blocked contender did not enter queue');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let settled = false;
    child.once('close', () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await expect(access(join(root, '.doklo/cache/llm-token-ledger.json'))).rejects.toBeDefined();
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }, 15_000);
});

describe('adjustable token limits', () => {
  it('resolves defaults, environment values, and explicit overrides', async () => {
    const { resolveLlmTokenLimits } = await import('../src/lib/llm-cost-cap.js');
    expect(resolveLlmTokenLimits({}, {})).toEqual({ maxTokensPerRun: 1_000_000, maxTokensTotal: 5_000_000 });
    expect(resolveLlmTokenLimits({ maxTokensPerRun: 20 }, { DOKLO_MAX_TOKENS_PER_RUN: '10', DOKLO_MAX_TOKENS_TOTAL: '100' }))
      .toEqual({ maxTokensPerRun: 20, maxTokensTotal: 100 });
    for (const value of ['', '0', '-1', '1.5', 'Infinity', '9007199254740992']) {
      expect(() => resolveLlmTokenLimits({}, { DOKLO_MAX_TOKENS_PER_RUN: value })).toThrow();
    }
  });

  it('honors exact custom run and cumulative boundaries across runs', async () => {
    const root = await workspace();
    const first = await registerLlmRun(root, { receiptId: 'custom-a', planDigest: 'a', maxCalls: 3, maxTokensPerRun: 10, maxTokensTotal: 15 });
    await reserve(first, 10);
    await expect(reserve(first, 1)).rejects.toMatchObject({ code: 'LLM_RUN_TOKEN_CAP' });
    const second = await registerLlmRun(root, { receiptId: 'custom-b', planDigest: 'b', maxCalls: 3, maxTokensPerRun: 10, maxTokensTotal: 15 });
    await reserve(second, 5);
    await expect(reserve(second, 1)).rejects.toMatchObject({ code: 'LLM_TOTAL_TOKEN_CAP' });
    expect(await ledgerTotal(root)).toBe(15);
  });

  it('counts normalized uncached, cached input and output once each', async () => {
    const root = await workspace();
    const run = await openRun(root);
    const reservation = await reserve(run, 100);
    expect(await reconcileRegisteredLlmCall(run, reservation, {
      input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
    })).toBe(100);
    expect(await ledgerTotal(root)).toBe(100);
  });

  it('retains the reservation when usage has incomplete or invalid counters', async () => {
    const root = await workspace();
    const run = await openRun(root);
    for (const usage of [{ input_tokens: 0 }, { input_tokens: -1, output_tokens: 0 }, { input_tokens: NaN, output_tokens: 0 }]) {
      const reservation = await reserve(run, 100);
      await reconcileRegisteredLlmCall(run, reservation, usage as import('@doklo-beta/generator').LLMUsage);
    }
    expect(await ledgerTotal(root)).toBe(300);
  });

  it('preserves legacy accounting without converting it into token history', async () => {
    const { hasLegacyLlmCostLedger } = await import('../src/lib/llm-cost-cap.js');
    const root = await workspace();
    expect(await hasLegacyLlmCostLedger(root)).toBe(false);
    const path = join(root, '.doklo/cache/llm-cost-ledger.json');
    const legacy = '{"schema_version":1,"calls":[{"reservedNanoUsd":999}]}';
    await writeFile(path, legacy);
    expect(await hasLegacyLlmCostLedger(root)).toBe(true);
    await reserve(await openRun(root), 10);
    expect(await ledgerTotal(root)).toBe(10);
    expect(await readFile(path, 'utf8')).toBe(legacy);
  });
});

describe('read-only token budget summary', () => {
  it('reports no usage without creating a ledger, then reports retained usage and legacy presence', async () => {
    const { readLlmTokenBudget } = await import('../src/lib/llm-cost-cap.js');
    const root = await workspace();
    expect(await readLlmTokenBudget(root)).toEqual({ chargedTokens: 0, legacyLedgerPresent: false });
    await expect(access(join(root, '.doklo/cache/llm-token-ledger.json'))).rejects.toBeDefined();
    await reserve(await openRun(root), 123);
    expect(await readLlmTokenBudget(root)).toEqual({ chargedTokens: 123, legacyLedgerPresent: false });
    await writeFile(join(root, '.doklo/cache/llm-cost-ledger.json'), '{}');
    expect(await readLlmTokenBudget(root)).toEqual({ chargedTokens: 123, legacyLedgerPresent: true });
  });
});
