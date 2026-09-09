// AI SDK execution path for callModel. Pure helpers (parseModelRef,
// mapAiSdkUsage) are unit-tested; runViaAiSdk is exercised via an injected
// generateText so tests never hit the network.
import { generateText as realGenerateText, streamText as realStreamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { redactHeaders, sanitizeProviderDetail } from './redact.js';
import type { LLMCallOptions, LLMCallResult, LLMUsage, LLMClientConfig } from './llm-client.js';

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'claude-code';

export interface AiSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}
export type GenerateTextFn = (args: Record<string, unknown>) => Promise<{
  text: string;
  usage?: AiSdkUsage;
  /** Why generation stopped (e.g. 'stop', 'length'). AI SDK generateText result. */
  finishReason?: string;
}>;
export type StreamTextFn = (args: Record<string, unknown>) => {
  textStream: AsyncIterable<string>;
  usage: Promise<AiSdkUsage | undefined>;
  /** Resolves to why generation stopped (e.g. 'stop', 'length'). */
  finishReason?: Promise<string | undefined>;
};
export interface RunnerDeps {
  generateText?: GenerateTextFn;
  streamText?: StreamTextFn;
}

export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf('/');
  if (slash < 0) return { provider: '', modelId: ref };
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function mapAiSdkUsage(usage: AiSdkUsage): LLMUsage | null {
  const total = usage.inputTokens;
  const output = usage.outputTokens;
  const read = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  // AI SDK inputTokens is a total including cached tokens. LLMUsage follows
  // Anthropic/Claude Code semantics: input_tokens is the uncached portion.
  // Unknown counters must stay unknown instead of becoming measured zero.
  if (total === undefined || output === undefined
    || ![total, output, read, write].every((value) => Number.isSafeInteger(value) && value >= 0)
    || read + write > total) return null;
  const out: LLMUsage = { input_tokens: total - read - write, output_tokens: output };
  if (usage.inputTokenDetails?.cacheReadTokens != null) out.cache_read_input_tokens = read;
  if (usage.inputTokenDetails?.cacheWriteTokens != null) out.cache_creation_input_tokens = write;
  return out;
}

const STD_ENV: Partial<Record<ProviderKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Options passed to AI SDK provider factories. Pure helper — unit-testable. */
export interface FactoryOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

/**
 * Build the options object forwarded to every AI SDK provider factory.
 * Uses conditional spread so keys that are `undefined` are omitted entirely
 * (safe under `exactOptionalPropertyTypes`).
 */
export function buildFactoryOptions(
  config: Pick<LLMClientConfig, 'apiKey' | 'baseURL' | 'fetch'>,
  apiKey: string | undefined,
): FactoryOptions {
  // When a custom fetch is supplied it overwrites the Authorization header, so a
  // real API key is not required. However, the AI SDK provider constructors throw
  // "API key is missing" before the custom fetch runs if no key is found at all.
  // Use a placeholder so the SDK builds the request; the custom fetch replaces
  // the header. Only inject the placeholder when fetch is present AND no real key
  // exists — never on the normal (no-fetch) path.
  const resolvedKey =
    apiKey !== undefined
      ? apiKey
      : config.fetch !== undefined
        ? 'codex-oauth'
        : undefined;
  return {
    ...(resolvedKey !== undefined ? { apiKey: resolvedKey } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
  };
}

// Build the AI SDK language model for a non-CLI provider kind.
function buildModel(kind: ProviderKind, config: LLMClientConfig, apiKey: string | undefined): unknown {
  const { provider, modelId } = parseModelRef(config.model);
  const opts = buildFactoryOptions(config, apiKey);
  switch (kind) {
    case 'anthropic':
      return createAnthropic(opts)(modelId);
    case 'openai':
      return createOpenAI(opts)(modelId);
    case 'openrouter':
      // openrouter model ids keep their internal slashes (e.g. anthropic/claude-...)
      return createOpenRouter(opts)(modelId);
    case 'openai-compatible': {
      if (!config.baseURL) {
        throw new Error('baseURL is required for openai-compatible providers');
      }
      // baseURL is guaranteed string here; spread opts then override so TS sees the non-optional type.
      return createOpenAICompatible({
        name: provider || 'custom',
        ...opts,
        baseURL: config.baseURL,
      })(modelId);
    }
    case 'claude-code':
      throw new Error('claude-code is not an AI SDK provider');
  }
}

export async function runViaAiSdk(
  options: LLMCallOptions,
  config: LLMClientConfig,
  kind: ProviderKind,
  deps: RunnerDeps = {},
): Promise<LLMCallResult> {
  const t0 = Date.now();
  const envVar = STD_ENV[kind];
  const apiKey = config.apiKey ?? (envVar ? process.env[envVar] : undefined);
  if (envVar !== undefined && !apiKey && !config.fetch) {
    return {
      success: false,
      content: null,
      error: {
        type: 'config_missing_api_key',
        message: `No API key provided for provider kind "${kind}".`,
      },
      usage: null,
      processingTime: Date.now() - t0,
    };
  }
  const gen = deps.generateText ?? (realGenerateText as unknown as GenerateTextFn);
  // System prompt as a system-role message so Anthropic cache_control applies.
  // The AI SDK warns about system-role messages unless allowSystemInMessages is
  // set; the prompt is Doklo's own, so the warning is noise for the user (MAYP-66).
  const messages: Array<Record<string, unknown>> = [];
  if (options.systemPrompt) {
    messages.push({
      role: 'system',
      content: options.systemPrompt,
      ...(kind === 'anthropic' && options.cacheableSystemPrompt
        ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
        : {}),
    });
  }
  messages.push({ role: 'user', content: options.userPrompt });
  try {
    const model = buildModel(kind, config, apiKey);
    // The Codex OAuth backend (chatgpt.com/backend-api/codex) only accepts
    // streaming requests (stream:true) and rejects non-streaming calls and the
    // max_output_tokens field; makeCodexFetch sanitises the body (store:false,
    // drop max_output_tokens). A custom fetch is set ONLY for that path, so it
    // is our signal to use the streaming API (which parses the SSE response).
    if (config.fetch !== undefined) {
      const stream = deps.streamText ?? (realStreamText as unknown as StreamTextFn);
      const res = stream({
        model,
        messages,
        maxOutputTokens: config.maxTokens,
        maxRetries: 0,
        allowSystemInMessages: true,
      });
      let text = '';
      for await (const chunk of res.textStream) text += chunk;
      const usage = await res.usage;
      const finishReason = res.finishReason ? await res.finishReason : undefined;
      return {
        success: true,
        content: text,
        error: null,
        usage: usage ? mapAiSdkUsage(usage) : null,
        processingTime: Date.now() - t0,
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
    }
    const result = await gen({
      model,
      messages,
      maxOutputTokens: config.maxTokens,
      maxRetries: 0,
      allowSystemInMessages: true,
    });
    return {
      success: true,
      content: result.text,
      error: null,
      usage: result.usage ? mapAiSdkUsage(result.usage) : null,
      processingTime: Date.now() - t0,
      ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
    };
  } catch (err) {
    const providerHttp = extractProviderHttpDetail(err);
    return {
      success: false,
      content: null,
      error: { type: 'ai_sdk_error', message: describeAiSdkError(err) },
      usage: null,
      processingTime: Date.now() - t0,
      // The status code and response body ride the debug channel, which is
      // stripped from the public result and only ever reaches an authorized
      // debug file — the error message above carries a shortened copy.
      ...(config.debugDir !== undefined && providerHttp !== undefined
        ? {
            debug: {
              sanitizedProviderDetail: sanitizeProviderDetail(
                err instanceof Error ? err.message : String(err),
              ),
              providerHttp,
            },
          }
        : {}),
    };
  }
}

/**
 * The provider's HTTP failure as the AI SDK's APICallError reports it, with
 * credentials and local paths scrubbed. Written only to an authorized debug
 * file — never returned to callers.
 */
export interface ProviderHttpDetail {
  statusCode?: number;
  url?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
}

/**
 * Pull the HTTP failure off an AI SDK error. Everything is optional because
 * non-HTTP failures (network, abort, a plain Error) carry none of it — those
 * return undefined so the debug record doesn't grow an empty stub.
 */
export function extractProviderHttpDetail(err: unknown): ProviderHttpDetail | undefined {
  const e = err as {
    statusCode?: unknown;
    url?: unknown;
    responseBody?: unknown;
    responseHeaders?: unknown;
  };
  const detail: ProviderHttpDetail = {};
  if (typeof e.statusCode === 'number') detail.statusCode = e.statusCode;
  if (typeof e.url === 'string' && e.url !== '') detail.url = sanitizeProviderDetail(e.url);
  if (typeof e.responseBody === 'string' && e.responseBody.trim() !== '') {
    detail.responseBody = sanitizeProviderDetail(e.responseBody.trim());
  }
  if (isStringRecord(e.responseHeaders)) {
    detail.responseHeaders = redactHeaders(e.responseHeaders);
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * Build an error message that includes the provider's HTTP status + response
 * body when present. The AI SDK's APICallError `.message` is often just
 * "Bad Request" or "Not Found"; the response body carries the real reason (e.g.
 * `{"detail":"Store must be set to false"}`, or whether a 404 means an unknown
 * model or a key without access), so surface it for diagnosis. This string goes
 * to the CLI and the ledger, so it is sanitized and kept short — the full body
 * lives in the debug record.
 */
function describeAiSdkError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as { statusCode?: unknown; responseBody?: unknown };
  const parts: string[] = [];
  if (typeof e.statusCode === 'number') parts.push(`HTTP ${e.statusCode}`);
  if (typeof e.responseBody === 'string' && e.responseBody.trim() !== '') {
    parts.push(truncate(sanitizeProviderDetail(e.responseBody.trim()), MESSAGE_BODY_LIMIT));
  }
  return parts.length > 0 ? `${message} — ${parts.join(' ')}` : message;
}

/** How much provider body to inline in a user-facing error message. */
const MESSAGE_BODY_LIMIT = 300;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
