import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseModelRef,
  resolveProviderKind,
  mapAiSdkUsage,
  callModel,
} from '../src/llm-client.js';
import { DEFAULT_CONSOLIDATE_OPTIONS } from '../src/consolidator.js';

describe('parseModelRef', () => {
  it('splits on the first slash', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic', modelId: 'claude-sonnet-4-5',
    });
  });
  it('keeps later slashes in the model id (openrouter style)', () => {
    expect(parseModelRef('openrouter/anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4-5',
    });
  });
});

describe('resolveProviderKind', () => {
  const base = { model: 'anthropic/claude-sonnet-4-5', maxTokens: 8192, timeout: 1000 };
  const originalEnv = process.env['DOKLO_LLM_BACKEND'];
  beforeEach(() => {
    delete process.env['DOKLO_LLM_BACKEND'];
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env['DOKLO_LLM_BACKEND'];
    else process.env['DOKLO_LLM_BACKEND'] = originalEnv;
  });
  it('prefers explicit providerKind', () => {
    expect(resolveProviderKind({ ...base, providerKind: 'openai' })).toBe('openai');
  });
  it('maps legacy backend anthropic-api → anthropic', () => {
    expect(resolveProviderKind({ ...base, backend: 'anthropic-api' })).toBe('anthropic');
  });
  it('maps legacy backend claude-code → claude-code', () => {
    expect(resolveProviderKind({ ...base, backend: 'claude-code' })).toBe('claude-code');
  });
  it('derives the kind from the model ref provider when nothing else is set', () => {
    expect(resolveProviderKind({ ...base, model: 'openrouter/x/y' })).toBe('openrouter');
    expect(resolveProviderKind({ ...base, model: 'openai/gpt-4o' })).toBe('openai');
  });
});

describe('mapAiSdkUsage', () => {
  it('maps v6 usage shape to LLMUsage', () => {
    expect(mapAiSdkUsage({
      inputTokens: 100, outputTokens: 50,
      inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 20 },
    })).toEqual({
      input_tokens: 0, output_tokens: 50,
      cache_read_input_tokens: 80, cache_creation_input_tokens: 20,
    });
  });
  it('preserves missing token counts as unknown', () => {
    expect(mapAiSdkUsage({})).toBeNull();
    expect(mapAiSdkUsage({ inputTokens: 12 })).toBeNull();
    expect(mapAiSdkUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('callModel (AI SDK path, injected generateText)', () => {
  const config = {
    model: 'anthropic/claude-sonnet-4-5', maxTokens: 256, timeout: 1000,
    providerKind: 'anthropic' as const, apiKey: 'sk-test',
  };
  it('returns a successful LLMCallResult and maps content + usage', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fakeGen = async (args: Record<string, unknown>) => {
      capturedArgs = args;
      return {
      text: 'hello',
      usage: { inputTokens: 10, outputTokens: 3, inputTokenDetails: { cacheReadTokens: 5 } },
      };
    };
    const res = await callModel(
      { userPrompt: 'hi', systemPrompt: 'sys' }, config, { generateText: fakeGen as never },
    );
    expect(res.success).toBe(true);
    expect(res.content).toBe('hello');
    expect(res.usage).toEqual({ input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 5 });
    expect(capturedArgs['maxRetries']).toBe(0);
  });
  it('returns config_missing_api_key when no key and no env', async () => {
    const prev = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const res = await callModel(
        { userPrompt: 'hi' }, { ...config, apiKey: undefined }, { generateText: (async () => ({ text: '', usage: {} })) as never },
      );
      expect(res.success).toBe(false);
      expect(res.error?.type).toBe('config_missing_api_key');
    } finally {
      if (prev !== undefined) process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });
  it('maps a thrown error into an error result', async () => {
    const fakeGen = async () => { throw new Error('boom'); };
    const res = await callModel({ userPrompt: 'hi' }, config, { generateText: fakeGen as never });
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('boom');
  });
  it('wires Anthropic cache control via providerOptions on the system message', async () => {
    let capturedArgs: Record<string, unknown> = {};
    const fakeGen = async (args: Record<string, unknown>) => {
      capturedArgs = args;
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const res = await callModel(
      { userPrompt: 'hi', systemPrompt: 'sys', cacheableSystemPrompt: true },
      config,
      { generateText: fakeGen as never },
    );
    expect(res.success).toBe(true);
    const messages = capturedArgs['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'sys',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
    // MAYP-66: the system-role message is Doklo's own prompt; suppress the AI SDK warning.
    expect(capturedArgs['allowSystemInMessages']).toBe(true);
  });
  it('resolves API key from env when config.apiKey is absent', async () => {
    const prevKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-env';
    try {
      const fakeGen = async () => ({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
      const res = await callModel(
        { userPrompt: 'hi' },
        { model: 'anthropic/x', maxTokens: 8, timeout: 100, providerKind: 'anthropic' },
        { generateText: fakeGen as never },
      );
      expect(res.success).toBe(true);
    } finally {
      if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
  });

  // Regression guard: the OAuth/Codex path must NOT be rejected by the missing-key
  // guard, and it must use the STREAMING API (the Codex backend requires stream:true).
  it('codex-oauth-custom-fetch: streams (no config_missing_api_key) when fetch is provided and no apiKey/env', async () => {
    const prevKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const stubFetch: typeof fetch = async () => new Response('{}', { status: 200 });
      let capturedArgs: Record<string, unknown> = {};
      const fakeStream = (args: Record<string, unknown>) => {
        capturedArgs = args;
        return {
          textStream: (async function* () { yield 'codex'; yield '-response'; })(),
          usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        };
      };
      const res = await callModel(
        { userPrompt: 'hello' },
        {
          model: 'openai/gpt-5.5',
          maxTokens: 8,
          timeout: 100,
          providerKind: 'openai',
          fetch: stubFetch,
          apiKey: undefined,
        },
        { streamText: fakeStream as never },
      );
      expect(res.success).toBe(true);
      expect(res.error).toBeNull();
      expect(res.content).toBe('codex-response');
      expect(res.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
      expect(capturedArgs['maxRetries']).toBe(0);
    } finally {
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });

  it('keeps the legacy consolidator retry setting at zero provider attempts', () => {
    expect(DEFAULT_CONSOLIDATE_OPTIONS.maxRetries).toBe(0);
  });

  it('codex path uses streamText, not generateText', async () => {
    const prevKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      let genCalled = false;
      const res = await callModel(
        { userPrompt: 'hi' },
        {
          model: 'openai/gpt-5.5', maxTokens: 8, timeout: 100,
          providerKind: 'openai', fetch: (async () => new Response('{}')) as never, apiKey: undefined,
        },
        {
          generateText: (async () => { genCalled = true; return { text: '', usage: {} }; }) as never,
          streamText: (() => ({
            textStream: (async function* () { yield 'ok'; })(),
            usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
          })) as never,
        },
      );
      expect(genCalled).toBe(false);
      expect(res.success).toBe(true);
      expect(res.content).toBe('ok');
    } finally {
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });

  it('surfaces provider HTTP status + response body in the error message', async () => {
    const apiErr = Object.assign(new Error('Bad Request'), {
      statusCode: 400,
      responseBody: '{"detail":"Store must be set to false"}',
    });
    const res = await callModel(
      { userPrompt: 'hi' },
      { model: 'openai/gpt-4o', maxTokens: 8, timeout: 100, providerKind: 'openai', apiKey: 'sk-x' },
      { generateText: (async () => { throw apiErr; }) as never },
    );
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('HTTP 400');
    expect(res.error?.message).toContain('Store must be set to false');
  });

  // finishReason surfacing (truncation diagnosis): the AI SDK reports why the
  // model stopped. 'length' means the output hit maxTokens and the JSON may be
  // truncated — callers use this to emit an actionable error instead of a
  // cryptic parse failure.
  it('maps finishReason from the injected generateText result', async () => {
    const fakeGen = async () => ({
      text: '{"partial":',
      usage: { inputTokens: 10, outputTokens: 8192 },
      finishReason: 'length',
    });
    const res = await callModel(
      { userPrompt: 'hi' }, config, { generateText: fakeGen as never },
    );
    expect(res.success).toBe(true);
    expect(res.finishReason).toBe('length');
  });

  it('leaves finishReason undefined when the generateText result omits it', async () => {
    const fakeGen = async () => ({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
    const res = await callModel(
      { userPrompt: 'hi' }, config, { generateText: fakeGen as never },
    );
    expect(res.success).toBe(true);
    expect(res.finishReason).toBeUndefined();
  });

  it('maps finishReason from the injected streamText result (fetch/streaming branch)', async () => {
    const prevKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const fakeStream = () => ({
        textStream: (async function* () { yield '{"partial":'; })(),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 8192 }),
        finishReason: Promise.resolve('length'),
      });
      const res = await callModel(
        { userPrompt: 'hello' },
        {
          model: 'openai/gpt-5.5', maxTokens: 8, timeout: 100,
          providerKind: 'openai', fetch: (async () => new Response('{}')) as never, apiKey: undefined,
        },
        { streamText: fakeStream as never },
      );
      expect(res.success).toBe(true);
      expect(res.finishReason).toBe('length');
    } finally {
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });
});

describe('callModel (Claude Code cancellation)', () => {
  it('classifies a known Claude Code HTTP 429 without exposing raw provider output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-provider-rate-limit-'));
    const executable = join(root, 'fake-claude.mjs');
    const debugDir = join(root, 'debug');
    const secretCanary = 'sk-ant-SECRET_CANARY_0123456789';
    await writeFile(executable, `#!/usr/bin/env node
process.stderr.write('HTTP 429 rate limit; secret=${secretCanary}; cwd=' + process.cwd() + '; home=' + (process.env.HOME ?? '') + '\\n');
process.exitCode = 1;
`);
    await chmod(executable, 0o755);

    try {
      const result = await callModel(
        { userPrompt: 'authorized prompt' },
        {
          model: 'anthropic/claude-sonnet-5',
          maxTokens: 8,
          timeout: 1_000,
          providerKind: 'claude-code',
          claudeBin: executable,
          debugDir,
        },
      );

      expect(result).toMatchObject({
        success: false,
        content: null,
        error: {
          type: 'rate_limit',
          message: 'Claude Code provider rate limited the request.',
        },
      });
      expect(result.debug).toBeUndefined();
      const publicResult = JSON.stringify({
        success: result.success,
        content: result.content,
        error: result.error,
        usage: result.usage,
        processingTime: result.processingTime,
      });
      expect(publicResult).not.toContain('HTTP 429 rate limit');
      expect(publicResult).not.toContain(secretCanary);
      expect(publicResult).not.toContain(process.cwd());
      if (process.env.HOME) expect(publicResult).not.toContain(process.env.HOME);

      const [debugFile] = await readdir(debugDir);
      const debugRecord = await readFile(join(debugDir, debugFile!), 'utf8');
      expect(debugRecord).toContain('[REDACTED]');
      expect(debugRecord).toContain('[REDACTED_CWD]');
      if (process.env.HOME) expect(debugRecord).toContain('[REDACTED_HOME]');
      expect(debugRecord).not.toContain(secretCanary);
      expect(debugRecord).not.toContain(process.cwd());
      if (process.env.HOME) expect(debugRecord).not.toContain(process.env.HOME);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a near-miss nonzero message as a generic provider exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-provider-rate-near-miss-'));
    const executable = join(root, 'fake-claude.mjs');
    await writeFile(executable, `#!/usr/bin/env node
process.stderr.write('HTTP 429ish rate limit words from a wrapper\\n');
process.exitCode = 1;
`);
    await chmod(executable, 0o755);

    try {
      const result = await callModel(
        { userPrompt: 'authorized prompt' },
        {
          model: 'anthropic/claude-sonnet-5',
          maxTokens: 8,
          timeout: 1_000,
          providerKind: 'claude-code',
          claudeBin: executable,
        },
      );

      expect(result).toMatchObject({
        success: false,
        content: null,
        error: {
          type: 'nonzero_exit',
          message: 'Claude Code provider exited with a nonzero status.',
        },
      });
      expect(JSON.stringify(result.error)).not.toContain('HTTP 429ish');
      expect(result.debug).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a Claude-reported error body out of public content and sanitizes debug detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-provider-reported-error-'));
    const executable = join(root, 'fake-claude.mjs');
    const debugDir = join(root, 'debug');
    const secretCanary = 'sk-ant-REPORTED_SECRET_0123456789';
    await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  is_error: true,
  result: 'secret=${secretCanary}; cwd=' + process.cwd() + '; home=' + (process.env.HOME ?? ''),
}));
`);
    await chmod(executable, 0o755);

    try {
      const result = await callModel(
        { userPrompt: 'authorized prompt' },
        {
          model: 'anthropic/claude-sonnet-5',
          maxTokens: 8,
          timeout: 1_000,
          providerKind: 'claude-code',
          claudeBin: executable,
          debugDir,
        },
      );

      expect(result).toMatchObject({
        success: false,
        content: null,
        error: {
          type: 'cc_reported_error',
          message: 'Claude Code provider reported an error.',
        },
      });
      expect(result.debug).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(secretCanary);
      expect(JSON.stringify(result)).not.toContain(process.cwd());
      if (process.env.HOME) expect(JSON.stringify(result)).not.toContain(process.env.HOME);
      const [debugFile] = await readdir(debugDir);
      const debugRecord = await readFile(join(debugDir, debugFile!), 'utf8');
      expect(debugRecord).toContain('[REDACTED]');
      expect(debugRecord).toContain('[REDACTED_CWD]');
      if (process.env.HOME) expect(debugRecord).toContain('[REDACTED_HOME]');
      expect(debugRecord).not.toContain(secretCanary);
      expect(debugRecord).not.toContain(process.cwd());
      if (process.env.HOME) expect(debugRecord).not.toContain(process.env.HOME);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses isolated Claude Code argv and ignores obsolete monetary limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-provider-argv-'));
    const capture = join(root, 'capture.json');
    const executable = join(root, 'fake-claude.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
}));
process.stdout.write(JSON.stringify({ type: 'result', result: '{}' }));
`);
    await chmod(executable, 0o755);
    const previousKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'ambient-test-key';

    try {
      const result = await callModel(
        { userPrompt: 'authorized prompt' },
        {
          model: 'anthropic/claude-sonnet-5',
          maxTokens: 8,
          timeout: 1_000,
          // Older JavaScript callers may still pass this removed setting.
          ...{ maxBudgetUsd: 0.314159 },
          providerKind: 'claude-code',
          claudeBin: executable,
        },
      );
      const observed = JSON.parse(await readFile(capture, 'utf8')) as {
        argv: string[];
        anthropicApiKey: string | null;
      };

      expect(result.success).toBe(true);
      expect(observed.argv).toEqual(expect.arrayContaining([
        '--safe-mode',
        '--disable-slash-commands',
        '--strict-mcp-config',
      ]));
      expect(observed.argv.slice(observed.argv.indexOf('--model'), observed.argv.indexOf('--model') + 2))
        .toEqual(['--model', 'sonnet']);
      expect(observed.argv).not.toContain('--max-budget-usd');
      expect(observed.argv.slice(observed.argv.indexOf('--tools'), observed.argv.indexOf('--tools') + 2))
        .toEqual(['--tools', '']);
      expect(observed.argv.slice(observed.argv.indexOf('--setting-sources'), observed.argv.indexOf('--setting-sources') + 2))
        .toEqual(['--setting-sources', '']);
      expect(observed.argv.slice(observed.argv.indexOf('--mcp-config'), observed.argv.indexOf('--mcp-config') + 2))
        .toEqual(['--mcp-config', '{"mcpServers":{}}']);
      expect(observed.argv).not.toContain('--bare');
      expect(observed.argv).not.toContain('anthropic/claude-sonnet-5');
      expect(observed.anthropicApiKey).toBeNull();
    } finally {
      if (previousKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previousKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not spawn Claude when the signal is already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-provider-aborted-'));
    const marker = join(root, 'spawned.txt');
    const executable = join(root, 'fake-claude.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(marker)}, 'spawned');
process.stdout.write(JSON.stringify({ type: 'result', result: '{}' }));
`);
    await chmod(executable, 0o755);
    const controller = new AbortController();
    controller.abort(new Error('SIGINT'));

    try {
      const result = await callModel(
        { userPrompt: 'never send', signal: controller.signal },
        {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8,
          timeout: 1_000,
          providerKind: 'claude-code',
          claudeBin: executable,
        },
      );

      expect(result).toMatchObject({
        success: false,
        error: { type: 'aborted' },
        usage: null,
      });
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates an in-flight Claude child once and ignores its late success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-provider-abort-live-'));
    const ready = join(root, 'ready.txt');
    const signals = join(root, 'signals.txt');
    const executable = join(root, 'fake-claude.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import { appendFile, writeFile } from 'node:fs/promises';
let exiting = false;
process.on('SIGTERM', async () => {
  await appendFile(${JSON.stringify(signals)}, 'SIGTERM\\n');
  if (exiting) return;
  exiting = true;
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'result', result: '{}' }));
    process.exit(0);
  }, 120);
});
await writeFile(${JSON.stringify(ready)}, 'ready');
setInterval(() => {}, 1000);
`);
    await chmod(executable, 0o755);
    const controller = new AbortController();

    try {
      const pending = callModel(
        { userPrompt: 'wait', signal: controller.signal },
        {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8,
          timeout: 1_000,
          providerKind: 'claude-code',
          claudeBin: executable,
        },
      );
      await waitForFile(ready);
      controller.abort(new Error('SIGINT'));

      await expect(pending).resolves.toMatchObject({
        success: false,
        content: null,
        error: { type: 'aborted' },
      });
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect((await readFile(signals, 'utf8')).trim().split('\n')).toEqual(['SIGTERM']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'kills an aborting Claude process group after grace when child and grandchild ignore SIGTERM',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'doklo-provider-abort-tree-'));
      const ready = join(root, 'ready.json');
      const executable = join(root, 'fake-claude.mjs');
      await writeFile(executable, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
  stdio: 'ignore',
});
await writeFile(${JSON.stringify(ready)}, JSON.stringify({
  childPid: process.pid,
  grandchildPid: grandchild.pid,
}));
setInterval(() => {}, 1000);
`);
      await chmod(executable, 0o755);
      const controller = new AbortController();
      let pids: { childPid: number; grandchildPid: number } | undefined;
      let pending: Promise<Awaited<ReturnType<typeof callModel>>> | undefined;

      try {
        pending = callModel(
          { userPrompt: 'wait', signal: controller.signal },
          {
            model: 'anthropic/claude-sonnet-5',
            maxTokens: 8,
            timeout: 5_000,
            providerKind: 'claude-code',
            claudeBin: executable,
          },
        );
        pids = await waitForJsonFile<typeof pids>(ready);
        const startedAt = Date.now();
        controller.abort(new Error('SIGINT'));
        const result = await Promise.race([
          pending,
          new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 1_200)),
        ]);

        expect(result).not.toBe('did-not-settle');
        expect(result).toMatchObject({
          success: false,
          error: { type: 'aborted' },
        });
        expect(Date.now() - startedAt).toBeLessThan(1_200);
        await waitForProcessExit(pids!.childPid);
        await waitForProcessExit(pids!.grandchildPid);
      } finally {
        for (const pid of [pids?.childPid, pids?.grandchildPid]) {
          if (pid === undefined) continue;
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        if (pending !== undefined) await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        await rm(root, { recursive: true, force: true });
      }
    },
    5_000,
  );

  it.runIf(process.platform !== 'win32')(
    'keeps group escalation alive when the direct child exits on SIGTERM but its grandchild does not',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'doklo-provider-abort-orphan-'));
      const ready = join(root, 'ready.json');
      const grandchildReady = join(root, 'grandchild-ready.txt');
      const executable = join(root, 'fake-claude.mjs');
      await writeFile(executable, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
const grandchild = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`
  import { writeFile } from 'node:fs/promises';
  process.on('SIGTERM', () => {});
  await writeFile(process.env.GRANDCHILD_READY, 'ready');
  setInterval(() => {}, 1000);
`)}], {
  stdio: 'ignore',
  env: { ...process.env, GRANDCHILD_READY: ${JSON.stringify(grandchildReady)} },
});
process.on('SIGTERM', () => process.exit(0));
while (true) {
  try {
    await access(${JSON.stringify(grandchildReady)});
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
await writeFile(${JSON.stringify(ready)}, JSON.stringify({
  childPid: process.pid,
  grandchildPid: grandchild.pid,
}));
setInterval(() => {}, 1000);
`);
      await chmod(executable, 0o755);
      const controller = new AbortController();
      let pids: { childPid: number; grandchildPid: number } | undefined;
      let pending: Promise<Awaited<ReturnType<typeof callModel>>> | undefined;

      try {
        pending = callModel(
          { userPrompt: 'wait', signal: controller.signal },
          {
            model: 'anthropic/claude-sonnet-5',
            maxTokens: 8,
            timeout: 5_000,
            providerKind: 'claude-code',
            claudeBin: executable,
          },
        );
        pids = await waitForJsonFile<typeof pids>(ready);
        const startedAt = Date.now();
        controller.abort(new Error('SIGINT'));
        const result = await Promise.race([
          pending,
          new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 1_200)),
        ]);

        expect(result).not.toBe('did-not-settle');
        expect(result).toMatchObject({
          success: false,
          error: { type: 'aborted' },
        });
        expect(Date.now() - startedAt).toBeLessThan(1_200);
        await waitForProcessExit(pids!.childPid);
        await waitForProcessExit(pids!.grandchildPid);
      } finally {
        for (const pid of [pids?.childPid, pids?.grandchildPid]) {
          if (pid === undefined) continue;
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        if (pending !== undefined) await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        await rm(root, { recursive: true, force: true });
      }
    },
    5_000,
  );

  it.runIf(process.platform !== 'win32')(
    'kills the owned provider process group after a timeout when child and grandchild ignore SIGTERM',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'doklo-provider-timeout-tree-'));
      const ready = join(root, 'ready.json');
      const grandchildReady = join(root, 'grandchild-ready.txt');
      const executable = join(root, 'fake-claude.mjs');
      await writeFile(executable, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
process.on('SIGTERM', () => {});
const grandchild = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`
  import { writeFile } from 'node:fs/promises';
  process.on('SIGTERM', () => {});
  await writeFile(process.env.GRANDCHILD_READY, 'ready');
  setInterval(() => {}, 1000);
`)}], {
  stdio: 'ignore',
  env: { ...process.env, GRANDCHILD_READY: ${JSON.stringify(grandchildReady)} },
});
while (true) {
  try {
    await access(${JSON.stringify(grandchildReady)});
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
await writeFile(${JSON.stringify(ready)}, JSON.stringify({
  childPid: process.pid,
  grandchildPid: grandchild.pid,
}));
setInterval(() => {}, 1000);
`);
      await chmod(executable, 0o755);
      let pids: { childPid: number; grandchildPid: number } | undefined;
      let pending: Promise<Awaited<ReturnType<typeof callModel>>> | undefined;

      try {
        const startedAt = Date.now();
        pending = callModel(
          { userPrompt: 'wait' },
          {
            model: 'anthropic/claude-sonnet-5',
            maxTokens: 8,
            timeout: 500,
            providerKind: 'claude-code',
            claudeBin: executable,
          },
        );
        pids = await waitForJsonFile<typeof pids>(ready);
        const result = await Promise.race([
          pending,
          new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 1_500)),
        ]);

        expect(result).not.toBe('did-not-settle');
        expect(result).toMatchObject({
          success: false,
          error: { type: 'timeout' },
        });
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        await waitForProcessExit(pids!.childPid);
        await waitForProcessExit(pids!.grandchildPid);
      } finally {
        for (const pid of [pids?.childPid, pids?.grandchildPid]) {
          if (pid === undefined) continue;
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        if (pending !== undefined) await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
        await rm(root, { recursive: true, force: true });
      }
    },
    5_000,
  );
});

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filename);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

async function waitForJsonFile<T>(filename: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filename, 'utf8')) as T;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
        && !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for valid JSON in ${filename}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} survived cancellation`);
}

describe('Claude Code usage measurement', () => {
  it.each([
    [{}, null],
    [{ input_tokens: 3 }, null],
    [{ input_tokens: 0, output_tokens: 0 }, { input_tokens: 0, output_tokens: 0 }],
    [{ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 8 },
      { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 8 }],
  ])('preserves missing counters and exclusive cache semantics (%j)', async (usage, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-usage-'));
    const executable = join(root, 'fake-claude.mjs');
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(' +
      JSON.stringify(JSON.stringify({ type: 'result', is_error: false, result: 'ok', usage })) + ');\n');
    await chmod(executable, 0o755);
    try {
      const result = await callModel({ userPrompt: 'test' }, {
        model: 'anthropic/claude-sonnet-5', maxTokens: 8, timeout: 1000, providerKind: 'claude-code', claudeBin: executable,
      });
      expect(result.success).toBe(true);
      expect(result.usage).toEqual(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
