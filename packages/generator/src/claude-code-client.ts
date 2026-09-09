// Claude Code CLI backend for callClaude.
//
// Spawns the `claude` binary in print mode (`-p`) with `--output-format
// json`, pipes the user prompt over stdin, parses the JSON envelope it
// emits, and returns the same LLMCallResult shape the API backend does.
//
// Auth model: the local Claude Code login (OAuth/keychain). Ambient
// ANTHROPIC_API_KEY is removed from this credential-free route.
//
// Trade-offs vs. the API backend:
//   - The process runs in safe mode with tools, setting sources, MCP, hooks,
//     project context, and slash commands disabled.
//   - Requires the `claude` CLI on PATH.
//   - maxTokens is an API output limit; this CLI route has no hard token cap.
//     Callers reserve estimated tokens and reconcile returned usage.
//
// Use --no-session-persistence so doklo runs don't pollute the user's
// session history.

import { spawn } from 'node:child_process';
import { sanitizeProviderDetail } from './redact.js';
import type {
  LLMCallOptions,
  LLMCallResult,
  LLMClientConfig,
  LLMUsage,
} from './llm-client.js';

const ABORT_KILL_GRACE_MS = 250;

interface ClaudeCodeJsonResult {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export async function callClaudeViaClaudeCode(
  options: LLMCallOptions,
  config: LLMClientConfig,
): Promise<LLMCallResult> {
  const t0 = Date.now();
  const claudeBin = config.claudeBin ?? process.env['DOKLO_CLAUDE_BIN'] ?? 'claude';

  if (options.signal?.aborted) return abortedResult(t0);

  const args: string[] = [
    '-p',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--safe-mode',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
  ];
  if (config.model) {
    args.push('--model', mapModelToClaudeCodeAlias(config.model));
  }
  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }

  return await new Promise<LLMCallResult>((resolve) => {
    let resolved = false;
    let abortRequested = false;
    let timer: NodeJS.Timeout | undefined;
    let abortKillTimer: NodeJS.Timeout | undefined;
    let terminationResult: LLMCallResult | undefined;
    const finish = (r: LLMCallResult) => {
      if (resolved) return;
      resolved = true;
      if (timer !== undefined) clearTimeout(timer);
      if (abortKillTimer !== undefined) clearTimeout(abortKillTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve(r);
    };

    const child = spawn(claudeBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeCodeEnvironment(),
      detached: process.platform !== 'win32',
    });

    const terminateChildTree = (result: LLMCallResult) => {
      if (resolved || terminationResult !== undefined) return;
      terminationResult = result;
      if (timer !== undefined) clearTimeout(timer);
      if (!signalChildTree(child.pid, () => child.kill('SIGTERM'), 'SIGTERM')) {
        finish(result);
        return;
      }
      abortKillTimer = setTimeout(() => {
        signalChildTree(child.pid, () => child.kill('SIGKILL'), 'SIGKILL');
        finish(result);
      }, ABORT_KILL_GRACE_MS);
    };

    const abort = () => {
      if (resolved || abortRequested) return;
      abortRequested = true;
      terminateChildTree(abortedResult(t0));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    let stdout = '';
    let stderr = '';

    timer = setTimeout(() => {
      terminateChildTree({
        success: false,
        content: null,
        error: {
          type: 'timeout',
          message: `claude -p timed out after ${config.timeout}ms`,
        },
        usage: null,
        processingTime: Date.now() - t0,
      });
    }, config.timeout);
    if (abortRequested) clearTimeout(timer);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (terminationResult !== undefined) {
        if (ownedProcessGroupExists(child.pid)) return;
        finish(terminationResult);
        return;
      }
      finish({
        success: false,
        content: null,
        error: {
          type: 'spawn_failed',
          message: 'Could not start the Claude Code provider.',
        },
        usage: null,
        processingTime: Date.now() - t0,
        ...debugProviderField(config, err.message),
      });
    });

    child.on('exit', (code) => {
      if (terminationResult !== undefined) {
        if (ownedProcessGroupExists(child.pid)) return;
        finish(terminationResult);
        return;
      }

      if (code !== 0) {
        const detail = (stderr || stdout).slice(0, 800);
        const type = classifyNonzeroExit(detail);
        finish({
          success: false,
          content: null,
          error: {
            type,
            message: type === 'rate_limit'
              ? 'Claude Code provider rate limited the request.'
              : 'Claude Code provider exited with a nonzero status.',
          },
          usage: null,
          processingTime: Date.now() - t0,
          ...debugProviderField(config, detail),
        });
        return;
      }

      let parsed: ClaudeCodeJsonResult;
      try {
        parsed = JSON.parse(stdout) as ClaudeCodeJsonResult;
      } catch (err) {
        const detail = stdout.slice(0, 800);
        finish({
          success: false,
          content: null,
          error: {
            type: 'parse_envelope',
            message: 'Claude Code provider returned an invalid response.',
          },
          usage: null,
          processingTime: Date.now() - t0,
          ...debugProviderField(config,
            `${err instanceof Error ? err.message : String(err)}\n${detail}`,
          ),
        });
        return;
      }

      const usage = mapUsage(parsed);

      if (parsed.is_error) {
        finish({
          success: false,
          content: null,
          error: {
            type: 'cc_reported_error',
            message: 'Claude Code provider reported an error.',
          },
          usage,
          processingTime: Date.now() - t0,
          ...(parsed.result === undefined ? {} : debugProviderField(config, parsed.result)),
        });
        return;
      }

      finish({
        success: true,
        content: parsed.result ?? '',
        error: null,
        usage,
        processingTime: Date.now() - t0,
      });
    });

    child.stdin.on('error', () => {
      // The child may close stdin while an abort is racing with prompt write.
      // Child exit/error remains the single terminal result source.
    });

    child.stdin.write(options.userPrompt);
    child.stdin.end();
  });
}

function classifyNonzeroExit(detail: string): 'rate_limit' | 'nonzero_exit' {
  return /(?:^|\s)HTTP\s+429(?:\s|[;:])/iu.test(detail)
    && /\brate[\s-]?limit(?:ed|ing)?\b/iu.test(detail)
    ? 'rate_limit'
    : 'nonzero_exit';
}

function debugProviderField(
  config: LLMClientConfig,
  detail: string,
): Pick<LLMCallResult, 'debug'> | Record<never, never> {
  return config.debugDir === undefined
    ? {}
    : { debug: { sanitizedProviderDetail: sanitizeProviderDetail(detail) } };
}

function abortedResult(startedAt: number): LLMCallResult {
  return {
    success: false,
    content: null,
    error: {
      type: 'aborted',
      message: 'Claude Code generation interrupted.',
    },
    usage: null,
    processingTime: Date.now() - startedAt,
  };
}

function mapUsage(parsed: ClaudeCodeJsonResult): LLMUsage | null {
  if (!parsed.usage) return null;
  const input = parsed.usage.input_tokens;
  const output = parsed.usage.output_tokens;
  if (input === undefined || output === undefined
    || ![input, output, parsed.usage.cache_creation_input_tokens ?? 0,
      parsed.usage.cache_read_input_tokens ?? 0]
      .every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const u: LLMUsage = {
    input_tokens: input,
    output_tokens: output,
  };
  if (parsed.usage.cache_creation_input_tokens != null) {
    u.cache_creation_input_tokens = parsed.usage.cache_creation_input_tokens;
  }
  if (parsed.usage.cache_read_input_tokens != null) {
    u.cache_read_input_tokens = parsed.usage.cache_read_input_tokens;
  }
  return u;
}

// Claude Code accepts model aliases ('haiku' / 'sonnet' / 'opus') or full
// model ids. Our default config uses Anthropic SDK ids; map them to
// aliases so callers don't have to.
export function mapModelToClaudeCodeAlias(model: string): string {
  const modelId = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  if (modelId.startsWith('claude-haiku')) return 'haiku';
  if (modelId.startsWith('claude-sonnet')) return 'sonnet';
  if (modelId.startsWith('claude-opus')) return 'opus';
  return model;
}

function claudeCodeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment['ANTHROPIC_API_KEY'];
  return environment;
}

function signalChildTree(
  pid: number | undefined,
  signalChild: () => boolean,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform === 'win32' || pid === undefined) return signalChild();
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return signalChild();
  }
}

function ownedProcessGroupExists(pid: number | undefined): boolean {
  if (process.platform === 'win32' || pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
