// Claude client — two backends behind one entry point.
//
// Backends:
//   - 'claude-code'    : shells out to the `claude` CLI (-p / print mode).
//                        Uses whatever auth `claude` itself has (OAuth from
//                        keychain, or API key). Default — most users already
//                        have Claude Code installed and don't want to plumb
//                        a second API key just for doklo.
//   - 'anthropic-api'  : Anthropic via the Vercel AI SDK, BYOK via
//                        ANTHROPIC_API_KEY (or config.apiKey). Prompt caching,
//                        granular usage telemetry. Pick this when you need
//                        direct cost tracking, a non-Sonnet/Haiku/Opus model,
//                        or are running in CI where `claude` isn't installed.
//
// Selection: `config.backend` wins; otherwise DOKLO_LLM_BACKEND env var;
// otherwise 'claude-code'.
//
// Both backends return the same LLMCallResult shape, so callers
// (consolidator, dok-generator) don't need to know which one ran.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { callClaudeViaClaudeCode } from './claude-code-client.js';
import {
  type ProviderHttpDetail,
  type ProviderKind,
  type RunnerDeps,
  parseModelRef,
  mapAiSdkUsage,
  runViaAiSdk,
} from './provider-runner.js';
export type { ProviderHttpDetail, ProviderKind, RunnerDeps };
export { parseModelRef, mapAiSdkUsage };

export type LLMBackend = 'anthropic-api' | 'claude-code';

export interface LLMClientConfig {
  /** Which backend to use. Default: 'claude-code'. */
  backend?: LLMBackend;
  /** Anthropic API key (anthropic-api backend). Falls back to ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** Path to the `claude` binary (claude-code backend). Default: 'claude' on PATH. */
  claudeBin?: string;
  /** Model id (anthropic-api full id, e.g., 'claude-sonnet-4-20250514'; or
   * claude-code alias like 'sonnet'/'opus'/'haiku'). */
  model: string;
  /** API output-token limit. Claude Code reports usage without enforcing this cap. */
  maxTokens: number;
  /** Per-call timeout in milliseconds. */
  timeout: number;
  /**
   * If set, every call writes a JSON record (input/output/usage) here.
   * Recommended: '.doklo/debug'. Failures in debug saving never break the
   * main flow.
   */
  debugDir?: string;
  /** Provider family for the AI SDK path. If unset, derived from backend or model ref. */
  providerKind?: ProviderKind;
  /** Base URL for openai-compatible providers (Ollama, EXAONE, custom). */
  baseURL?: string;
  /**
   * Custom fetch implementation forwarded to AI SDK provider factories.
   * When set, the provider routes HTTP through this function instead of the
   * Node global fetch. Use to inject auth headers (e.g. Bearer token +
   * ChatGPT-Account-Id for Codex) or redirect to a custom endpoint.
   * Default: unset → AI SDK uses Node global fetch.
   */
  fetch?: typeof fetch;
}

/**
 * A provider prompt split for caching: a per-run-stable prefix (system) and a
 * per-item suffix (user). Every call in one run must share the exact same
 * systemPrompt bytes — providers cache by prefix match, so any per-item fact
 * leaking into the systemPrompt kills the cache for the whole run.
 */
export interface PromptParts {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Canonical serialization of a split prompt. This exact string is what the
 * trust gate digests and the user approves, so it must stay deterministic:
 * changing the separator invalidates every previously approved plan digest.
 */
export function joinPromptParts(parts: PromptParts): string {
  return `${parts.systemPrompt}\n\n${parts.userPrompt}`;
}

export interface LLMCallOptions {
  /** System prompt content. */
  systemPrompt?: string;
  /** User prompt content. */
  userPrompt: string;
  /**
   * If true, mark the system prompt with cache_control:'ephemeral' so
   * Anthropic caches it across calls within ~5 minutes (90% input discount
   * on hit). Use for stable, large system prompts.
   */
  cacheableSystemPrompt?: boolean;
  /** Short label for the debug filename (e.g., feature id). */
  label?: string;
  /** Cancels an in-flight provider call. */
  signal?: AbortSignal;
}

export interface LLMUsage {
  /** Uncached input only; cache reads/writes are separate, disjoint counters. */
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type LLMFailureKind =
  | 'aborted'
  | 'timeout'
  | 'spawn_failed'
  | 'rate_limit'
  | 'truncated_response'
  | 'nonzero_exit'
  | 'parse_envelope'
  | 'cc_reported_error'
  | 'config_missing_api_key'
  | 'ai_sdk_error';

export interface LLMCallResult {
  success: boolean;
  content: string | null;
  error: { type: LLMFailureKind; message: string } | null;
  usage: LLMUsage | null;
  /** Wall-clock duration of the call in milliseconds. */
  processingTime: number;
  /**
   * Why the model stopped generating, when the backend reports it (AI SDK
   * path). 'length' means the output hit maxTokens and may be truncated
   * mid-JSON — callers use this to emit an actionable error. Undefined for the
   * claude-code CLI backend, which doesn't expose a finish reason.
   */
  finishReason?: string;
  /**
   * Sanitized provider-only context for an explicitly authorized debug file.
   * Callers must never copy this field into command diagnostics or ledgers.
   */
  debug?: {
    sanitizedProviderDetail: string;
    /**
     * The provider's HTTP failure, as reported by the AI SDK's APICallError.
     * The response body is what separates causes an HTTP status alone can't —
     * an unknown model id vs. a key without access to a known one — so it is
     * recorded verbatim (minus credentials) rather than folded into a message.
     */
    providerHttp?: ProviderHttpDetail;
  };
}

export const DEFAULT_LLM_CONFIG: LLMClientConfig = {
  model: 'claude-sonnet-4-20250514',
  maxTokens: 8192,
  timeout: 300_000,
};

export async function callClaude(
  options: LLMCallOptions,
  config: LLMClientConfig = DEFAULT_LLM_CONFIG,
): Promise<LLMCallResult> {
  return callModel(options, config);
}

/** Type guard for the LLMBackend union — use to validate user-supplied
 * backend names (CLI flags, env vars) before routing. */
export function isLLMBackend(value: string): value is LLMBackend {
  return value === 'claude-code' || value === 'anthropic-api';
}

export function resolveBackend(config: LLMClientConfig): LLMBackend {
  if (config.backend) return config.backend;
  const env = process.env['DOKLO_LLM_BACKEND'];
  if (env && isLLMBackend(env)) return env;
  return 'claude-code';
}

export function resolveProviderKind(config: LLMClientConfig): ProviderKind {
  if (config.providerKind) return config.providerKind;
  if (config.backend === 'claude-code') return 'claude-code';
  if (config.backend === 'anthropic-api') return 'anthropic';
  const env = process.env['DOKLO_LLM_BACKEND'];
  if (env === 'claude-code') return 'claude-code';
  if (env === 'anthropic-api') return 'anthropic';
  const { provider } = parseModelRef(config.model);
  if (provider === 'anthropic' || provider === 'openai' || provider === 'openrouter') {
    return provider;
  }
  if (provider) return 'openai-compatible';
  return 'claude-code';
}

export async function callModel(
  options: LLMCallOptions,
  config: LLMClientConfig = DEFAULT_LLM_CONFIG,
  deps?: RunnerDeps,
): Promise<LLMCallResult> {
  const kind = resolveProviderKind(config);
  if (kind === 'claude-code') {
    const result = await callClaudeViaClaudeCode(options, config);
    if (config.debugDir) await safeSaveDebug(config.debugDir, options, result, config);
    return withoutDebugDetail(result);
  }
  const result = await runViaAiSdk(options, config, kind, deps);
  if (config.debugDir) await safeSaveDebug(config.debugDir, options, result, config);
  return withoutDebugDetail(result);
}

function withoutDebugDetail(result: LLMCallResult): LLMCallResult {
  if (result.debug === undefined) return result;
  const publicResult = { ...result };
  delete publicResult.debug;
  return publicResult;
}

// Debug saving must never break the main flow — wrap in try/catch.
async function safeSaveDebug(
  debugDir: string,
  options: LLMCallOptions,
  result: LLMCallResult,
  config: LLMClientConfig,
): Promise<void> {
  try {
    await mkdir(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const status = result.success ? 'ok' : 'fail';
    const labelPart = options.label ? `-${options.label.replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
    const filename = `${ts}-${status}${labelPart}.json`;
    const record = {
      timestamp: new Date().toISOString(),
      config: { model: config.model, maxTokens: config.maxTokens },
      input: {
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        cacheableSystemPrompt: options.cacheableSystemPrompt ?? false,
      },
      output: result,
    };
    await writeFile(join(debugDir, filename), JSON.stringify(record, null, 2));
  } catch {
    // Intentional swallow — debug failures must not affect the call.
  }
}
