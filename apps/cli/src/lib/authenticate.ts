// Shared interactive authentication routine used by both `auth` and `init`
// commands. Extracts credentials for a given provider via @clack/prompts and
// stores them in the credential store (keychain by default).
//
// Returns { profileId } on success, or null when the user backed out at the
// METHOD step (ESC on the method selector, or ESC on the only password prompt
// for non-openai providers). The CALLER decides what "back" means in context:
//   - auth.ts: go back to the provider selector
//   - init.ts: go back to the model picker
//
// Internal ESC-at-key behaviour (openai only): ESC at the API-key password
// prompt goes BACK to the method selector (handled inside this function;
// not surfaced to the caller).
import type { CliContext } from './context.js';
import type { BrowserLoginProgress } from './codex-auth.js';
import { keychainStore, type CredentialStore } from './credentials.js';
import { PROVIDER_ENV } from '../lib/config.js';

export interface AuthenticateProviderOpts {
  profile?: string;
  ctx: CliContext;
  store?: CredentialStore;
}

/**
 * Interactive (clack) credential-collection routine for a single provider.
 *
 * Handles the ESC=back state machine internally:
 *   - openai: method-select (oauth | apikey) → oauth or password
 *     ESC at the key prompt → back to method (internal)
 *   - all others: password only
 *
 * Returns null when the user backs out at the outermost step (the method
 * selector for openai, or the password prompt for other providers). The
 * caller decides where "back" should navigate.
 *
 * When OAuth is chosen it calls loginWithBrowser() and stores the JSON tokens.
 * When API key is chosen it prompts for the key and stores the raw string.
 */
export async function authenticateProvider(
  provider: string,
  opts: AuthenticateProviderOpts,
): Promise<{ profileId: string } | null> {
  const { isCancel, log, select, password, spinner } = await import('@clack/prompts');
  const { ctx } = opts;
  const store = opts.store ?? keychainStore();
  const profile = opts.profile ?? 'default';
  const profileId = `${provider}:${profile}`;

  if (provider === 'openai') {
    // State machine: 'method' → done (or cancel → null)
    let step: 'method' | 'key' = 'method';
    while (true) {
      if (step === 'method') {
        const picked = await select({
          message: ctx.t('auth.pick_method'),
          options: [
            { value: 'oauth', label: 'Sign in with ChatGPT (Codex subscription)' },
            { value: 'apikey', label: 'Enter API key' },
          ],
        });
        if (isCancel(picked)) {
          // Cancelled at method — propagate cancel upward
          return null;
        }
        if ((picked as string) === 'oauth') {
          const { loginWithBrowser } = await import('./codex-auth.js');
          const s = spinner();
          s.start(ctx.t('auth.browser_opening'));
          try {
            const tokens = await loginWithBrowser({
              onProgress(event) {
                renderBrowserProgress(event, {
                  message: (value) => s.message(value),
                  info: (value) => log.info(value),
                }, ctx);
              },
            });
            s.message(ctx.t('auth.credential_saving'));
            store.set(profileId, JSON.stringify(tokens));
            s.stop(ctx.t('auth.oauth_complete'));
          } catch (err) {
            s.error(ctx.t('auth.failed'));
            throw err;
          }
          return { profileId };
        }
        // 'apikey' chosen
        step = 'key';
      }

      // step === 'key'
      const envVar = PROVIDER_ENV[provider] ?? '';
      const entered = await password({
        message: ctx.t('auth.enter_key', { provider, env: envVar }),
        validate: (v) => (!v ? ctx.t('auth.missing_key') : undefined),
      });
      if (isCancel(entered)) {
        // ESC at key → back to method
        step = 'method';
        continue;
      }
      await storeApiKey(profileId, entered as string, store, spinner, ctx);
      return { profileId };
    }
  }

  // Non-openai provider: just prompt for API key
  const envVar = PROVIDER_ENV[provider] ?? '';
  const entered = await password({
    message: ctx.t('auth.enter_key', { provider, env: envVar }),
    validate: (v) => (!v ? ctx.t('auth.missing_key') : undefined),
  });
  if (isCancel(entered)) {
    return null;
  }
  await storeApiKey(profileId, entered as string, store, spinner, ctx);
  return { profileId };
}

interface BrowserProgressRenderer {
  message(value: string): void;
  info(value: string): void;
}

function renderBrowserProgress(
  event: BrowserLoginProgress,
  renderer: BrowserProgressRenderer,
  ctx: CliContext,
): void {
  switch (event.phase) {
    case 'browser-opening':
      renderer.info(ctx.t('auth.browser_fallback', { url: event.authorizeUrl }));
      break;
    case 'browser-waiting':
      renderer.message(ctx.t('auth.browser_waiting'));
      break;
    case 'callback-received':
      renderer.message(ctx.t('auth.callback_received'));
      break;
    case 'token-exchanging':
      renderer.message(ctx.t('auth.token_exchanging'));
      break;
  }
}

async function storeApiKey(
  profileId: string,
  apiKey: string,
  store: CredentialStore,
  createSpinner: typeof import('@clack/prompts').spinner,
  ctx: CliContext,
): Promise<void> {
  const s = createSpinner({ delay: 0 });
  s.start(ctx.t('auth.key_received'));
  // The keychain API is synchronous. Yield once so Clack can paint the active
  // state before a native credential-store call blocks the event loop.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    store.set(profileId, apiKey);
    s.stop(ctx.t('auth.key_complete'));
  } catch (err) {
    s.error(ctx.t('auth.failed'));
    throw err;
  }
}
