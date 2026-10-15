// User-global, non-secret config: model role bindings + provider defs +
// credential rotation order. Lives at ~/.config/doklo/config.json. Secrets
// are resolved from the CredentialStore, never stored here.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseModelRef, type ProviderKind } from '@doklo-beta/generator';
import type { CredentialStore } from './credentials.js';
import { makeCodexFetch, type CodexTokens } from './codex-auth.js';
import type { LlmAuthSource } from './llm-preflight.js';
import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_JUDGE_MODEL,
  RUNTIME_TRUST_MODEL,
  assertJudgeTrustCredential,
  assertJudgeTrustModel,
  assertJudgeTrustRoute,
  assertRuntimeTrustCredential,
  assertRuntimeTrustModel,
  assertRuntimeTrustRoute,
} from './llm-preflight.js';

export interface ModelRole {
  primary: string;
  fallbacks?: string[];
}
export interface ProviderDef {
  kind: ProviderKind;
  baseURL?: string;
}
export interface DokloConfig {
  models: Record<string, ModelRole>;
  providers?: Record<string, ProviderDef>;
  auth?: { order?: Record<string, string[]> };
}

export const BUILTIN_PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { kind: 'anthropic' },
  openai: { kind: 'openai' },
  openrouter: { kind: 'openrouter' },
  // Gemini via its OpenAI-compatible endpoint (no extra AI SDK pkg needed in v1).
  google: { kind: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
};

export const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GEMINI_API_KEY',
};

export function configPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(base, 'doklo', 'config.json');
}

export async function loadConfig(file: string = configPath()): Promise<DokloConfig> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DokloConfig>;
    return { models: parsed.models ?? {}, providers: parsed.providers, auth: parsed.auth };
  } catch {
    return { models: {} };
  }
}

export async function saveConfig(config: DokloConfig, file: string = configPath()): Promise<void> {
  await fs.mkdir(join(file, '..'), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function setRoleModel(config: DokloConfig, role: string, ref: string): DokloConfig {
  return { ...config, models: { ...config.models, [role]: { primary: ref } } };
}

export function providerDefFor(config: DokloConfig, provider: string): ProviderDef | undefined {
  return config.providers?.[provider] ?? BUILTIN_PROVIDERS[provider];
}

export interface ResolvedLlm {
  providerKind: ProviderKind;
  model: string;
  authSource: LlmAuthSource;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

export interface ResolveLlmInput {
  config: DokloConfig;
  store: CredentialStore;
  role: string;
  modelOverride?: string;
  profileOverride?: string;
  backendOverride?: 'claude-code' | 'anthropic-api';
  /**
   * Judge role only: the regeneration model whose provider the judge follows
   * when no judge model is set (`doklo sync --judge --model <ref>`).
   */
  followModel?: string;
}

/** The role the sync judge resolves under (`doklo model --task judge`). */
export const JUDGE_ROLE = 'judge';

/**
 * The judge's model when none is given (benchmark report §11.8: the strong
 * judge follows the user's provider). An explicit judge model wins — the
 * override, then the `judge` role binding; otherwise the provider of the
 * regeneration model decides: OpenAI → GPT-6 Luna, anything else → Sonnet 5.
 */
export function defaultJudgeModel(args: Pick<ResolveLlmInput, 'config' | 'modelOverride' | 'followModel'>): string {
  if (args.modelOverride !== undefined) return args.modelOverride;
  const bound = args.config.models[JUDGE_ROLE]?.primary;
  if (bound !== undefined) return bound;
  const regeneration = args.followModel
    ?? args.config.models['generate']?.primary
    ?? args.config.models['default']?.primary;
  return regeneration !== undefined && parseModelRef(regeneration).provider === 'openai'
    ? OPENAI_JUDGE_MODEL
    : RUNTIME_TRUST_MODEL;
}

/**
 * The sync judge's model and route: Sonnet 5 on the direct Anthropic route
 * (default), or GPT-6 Luna on an OpenAI API key (keychain or OPENAI_API_KEY,
 * default endpoint) or the exact OpenAI Codex OAuth route. Any other model
 * fails naming the two; any other route fails as runtime trust does.
 */
export function resolveJudgeLlm(args: ResolveLlmInput): ResolvedLlm {
  const model = defaultJudgeModel(args);
  assertJudgeTrustModel(model);
  const resolved = resolveLlm({
    config: args.config,
    store: args.store,
    role: JUDGE_ROLE,
    modelOverride: model,
    ...(args.profileOverride !== undefined ? { profileOverride: args.profileOverride } : {}),
    ...(args.backendOverride !== undefined ? { backendOverride: args.backendOverride } : {}),
  });
  assertJudgeTrustModel(resolved.model);
  assertJudgeTrustRoute(resolved);
  assertJudgeTrustCredential(resolved);
  return resolved;
}

export function resolveRuntimeTrustLlm(args: ResolveLlmInput): ResolvedLlm {
  if (args.role === JUDGE_ROLE) return resolveJudgeLlm(args);
  const hasConfiguredModel = args.modelOverride !== undefined
    || args.config.models[args.role]?.primary !== undefined
    || args.config.models['default']?.primary !== undefined;
  const resolved = resolveLlm({
    ...args,
    ...(!hasConfiguredModel ? { modelOverride: RUNTIME_TRUST_MODEL } : {}),
  });
  assertRuntimeTrustModel(resolved.model);
  assertRuntimeTrustRoute(resolved);
  assertRuntimeTrustCredential(resolved);
  return resolved;
}

export function resolveLlm(args: ResolveLlmInput): ResolvedLlm {
  const { config, store, role } = args;
  const model =
    args.modelOverride ??
    config.models[role]?.primary ??
    config.models['default']?.primary;

  // If the caller explicitly requested claude-code passthrough, or no model is
  // configured at all, fall back to the local claude-code CLI. This keeps
  // first-run working without any BYOK configuration (spec principle 6).
  if (args.backendOverride === 'claude-code' || model === undefined) {
    return {
      providerKind: 'claude-code',
      model: model ?? 'claude-sonnet-4-20250514',
      authSource: 'claude-code',
    };
  }

  // Explicit anthropic-api override: force the anthropic providerKind.
  if (args.backendOverride === 'anthropic-api') {
    const profileId = args.profileOverride ?? 'anthropic:default';
    const envVar = PROVIDER_ENV['anthropic'];
    const storedKey = store.get(profileId) ?? undefined;
    const envKey = envVar !== undefined ? process.env[envVar] : undefined;
    const apiKey = storedKey ?? envKey ?? undefined;
    const authSource: LlmAuthSource = storedKey !== undefined
      ? 'keychain'
      : 'environment';
    const resolved: ResolvedLlm = { providerKind: 'anthropic', model, authSource };
    if (apiKey !== undefined) resolved.apiKey = apiKey;
    return resolved;
  }

  // Default path: derive provider from the model ref.
  const { provider } = parseModelRef(model);
  const def = providerDefFor(config, provider);
  const providerKind: ProviderKind = def?.kind ?? 'openai-compatible';
  const profileId = args.profileOverride ?? `${provider}:default`;
  const raw = store.get(profileId) ?? undefined;

  // Detect OAuth record: a stored value that is a JSON object with method==='oauth'
  // indicates a CodexTokens saved by `doklo auth` OAuth flow.
  // A plain API key string is not valid JSON (or lacks the `method` field), so
  // we guard with try/catch and fall through to the api-key path on any error.
  if (provider === 'openai' && raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)['method'] === 'oauth'
      ) {
        const tokens = parsed as CodexTokens;
        void tokens; // referenced via closures below
        const codexFetch = makeCodexFetch(
          () => {
            const stored = store.get(profileId);
            return stored !== null ? (JSON.parse(stored) as CodexTokens) : null;
          },
          (t: CodexTokens) => { store.set(profileId, JSON.stringify(t)); },
        );
        return {
          providerKind: 'openai',
          model,
          authSource: 'oauth',
          baseURL: OPENAI_CODEX_BASE_URL,
          fetch: codexFetch,
        };
      }
    } catch {
      // not a JSON object — fall through to api-key path
    }
  }

  const envVar = PROVIDER_ENV[provider];
  const envKey = envVar !== undefined ? process.env[envVar] : undefined;
  const apiKey = raw ?? envKey ?? undefined;
  const authSource: LlmAuthSource = raw !== undefined
    ? 'keychain'
    : 'environment';
  const resolved: ResolvedLlm = { providerKind, model, authSource };
  if (apiKey !== undefined) resolved.apiKey = apiKey;
  if (def?.baseURL !== undefined) resolved.baseURL = def.baseURL;
  return resolved;
}
