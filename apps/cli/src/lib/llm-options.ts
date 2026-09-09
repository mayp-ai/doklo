// Consistent --model / --profile across LLM commands, plus the
// resolver that turns CLI overrides + global config + keychain into a
// concrete (providerKind, model, apiKey, baseURL).
import type { Command } from 'commander';
import { loadConfig, resolveRuntimeTrustLlm, type ResolvedLlm } from './config.js';
import { keychainStore } from './credentials.js';

export type { ResolvedLlm };

export interface LlmCliOverrides {
  model?: string;
  profile?: string;
  backend?: string;
}

export function addLlmOptions(cmd: Command): Command {
  return cmd
    .option(
      '--model <ref>',
      'Runtime-trust model: anthropic/claude-sonnet-5 or openai/gpt-5.6-terra',
    )
    .option('--profile <id>', 'Credential profile id (e.g. anthropic:work)')
    .addHelpText('after', '\nToken limits: DOKLO_MAX_TOKENS_PER_RUN (default 1000000), DOKLO_MAX_TOKENS_TOTAL (default 5000000).\nCounts include input, cached input and output. Limits reserve conservatively before calls; provider usage can exceed an estimate.\nExample: DOKLO_MAX_TOKENS_PER_RUN=2000000 doklo generate');
}

export async function resolveLlmForRole(
  role: string,
  o: LlmCliOverrides,
): Promise<ResolvedLlm> {
  const config = await loadConfig();
  const store = keychainStore();
  return resolveRuntimeTrustLlm({
    config,
    store,
    role,
    ...(o.model !== undefined ? { modelOverride: o.model } : {}),
    ...(o.profile !== undefined ? { profileOverride: o.profile } : {}),
    ...(o.backend === 'claude-code' || o.backend === 'anthropic-api'
      ? { backendOverride: o.backend }
      : {}),
  });
}
