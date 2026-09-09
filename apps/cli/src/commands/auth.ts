// `doklo auth` — interactive credential entry. Stores API keys in the OS
// keychain under "<provider>:<profile>". Never writes secrets to disk config.
//
// ESC behaviour:
//   - ESC at provider picker → exit (first step, nowhere to go back)
//   - ESC at method step (authenticateProvider returns null) → back to provider
//   - ESC at key step (openai only, internal to authenticateProvider) → back to method
// For OpenAI, the user can choose OAuth (ChatGPT Codex subscription) or enter
// an API key through the interactive prompt. Secrets are never accepted in argv.
import type { Command } from 'commander';
import type { CliContext } from '../lib/context.js';
import { keychainStore, type CredentialStore } from '../lib/credentials.js';
import { BUILTIN_PROVIDERS } from '../lib/config.js';
import { authenticateProvider } from '../lib/authenticate.js';
import { CommandContractError } from '../lib/command-result.js';

export interface AuthInput {
  provider: string;
  apiKey: string;
  profile?: string;
}
export interface AuthDeps {
  store: CredentialStore;
}
export interface AuthResult {
  profileId: string;
}

export async function runAuth(input: AuthInput, deps: AuthDeps): Promise<AuthResult> {
  const profileId = `${input.provider}:${input.profile ?? 'default'}`;
  deps.store.set(profileId, input.apiKey);
  return { profileId };
}

export function registerAuthCommand(program: Command, ctx: CliContext): void {
  program
    .command('auth')
    .description('Store an API key for a provider (BYOK), or sign in with ChatGPT for OpenAI')
    .option('--provider <id>', 'Provider id (anthropic|openai|openrouter|google)')
    .option('--profile <label>', 'Profile label', 'default')
    .action(async (opts) => {
      const { intro, outro, isCancel, select } = await import('@clack/prompts');

      let provider = opts.provider as string | undefined;
      const profileLabel = opts.profile as string;

      intro(ctx.t('auth.pick_provider'));

      // Interactive loop: pick provider → authenticateProvider.
      // If authenticateProvider returns null the user pressed ESC at the
      // method step — go back to the provider picker (continue the loop).
      // ESC at the provider picker (first step) = exit.
      //
      // When --provider is supplied we skip the provider picker on the first
      // iteration but still loop in case the user backs out of the method step
      // (in that case we re-show the provider picker on subsequent iterations).
      let currentProvider = provider; // may be undefined on first iteration
      while (true) {
        if (!currentProvider) {
          const picked = await select({
            message: ctx.t('auth.pick_provider'),
            options: Object.keys(BUILTIN_PROVIDERS).map((id) => ({ value: id, label: id })),
          });
          if (isCancel(picked)) {
            throw cancelledCommand('auth', 'Authentication was cancelled.');
          }
          currentProvider = picked as string;
        }

        // Delegate to shared authenticate routine (handles oauth/apikey steps +
        // internal ESC-at-key → back-to-method). Returns null when the user
        // backs out of the method step — we re-show the provider picker.
        const result = await authenticateProvider(currentProvider, {
          profile: profileLabel,
          ctx,
          store: keychainStore(),
        });

        if (result === null) {
          // ESC at method → go back to provider picker
          currentProvider = undefined;
          continue;
        }

        outro(ctx.t('auth.saved', { profile: result.profileId }));
        break;
      }
    });
}

function cancelledCommand(command: string, message: string): CommandContractError {
  return new CommandContractError({
    schema_version: 1,
    command,
    status: 'cancelled',
    data: null,
    diagnostics: [{ code: 'COMMAND_CANCELLED', message }],
  });
}
