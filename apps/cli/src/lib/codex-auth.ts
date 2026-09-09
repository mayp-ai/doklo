/**
 * codex-auth.ts — OAuth / device-code login for OpenAI Codex subscriptions.
 *
 * Uses ONLY Node built-ins (node:crypto, node:http, node:child_process).
 * Secrets / tokens are never logged.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { spawn } from 'node:child_process';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ISSUER = 'https://auth.openai.com';
export const PORT = 1455;
export const REDIRECT = 'http://localhost:1455/auth/callback';
export const SCOPES = 'openid profile email offline_access';
export const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodexTokens {
  method: 'oauth';
  flavor: 'codex';
  access: string;
  refresh: string;
  /** ms epoch */
  expires: number;
  accountId?: string;
}

export type BrowserLoginProgress =
  | { phase: 'browser-opening'; authorizeUrl: string }
  | { phase: 'browser-waiting' }
  | { phase: 'callback-received' }
  | { phase: 'token-exchanging' };

interface BrowserLoginRuntime {
  createServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): http.Server;
  openBrowser(url: string): void;
  exchangeCode(code: string, verifier: string): Promise<CodexTokens>;
}

export interface BrowserLoginOptions {
  onProgress?: (event: BrowserLoginProgress) => void;
  /** Test seam. Production callers use the Node/browser defaults. */
  runtime?: Partial<BrowserLoginRuntime>;
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

const PKCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function generatePKCE(): { verifier: string; challenge: string } {
  const bytes = randomBytes(43);
  let verifier = '';
  for (let i = 0; i < 43; i++) {
    verifier += PKCE_CHARS[bytes[i]! % PKCE_CHARS.length];
  }
  const hash = createHash('sha256').update(verifier).digest();
  const challenge = hash
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const segment = parts[1]!;
    // Restore padding
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractAccountId(idToken: string, accessToken: string): string | undefined {
  for (const token of [idToken, accessToken]) {
    const payload = decodeJwtPayload(token);
    if (!payload) continue;

    // Primary: nested auth object
    const auth = payload['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      const authObj = auth as Record<string, unknown>;
      if (typeof authObj['chatgpt_account_id'] === 'string') {
        return authObj['chatgpt_account_id'];
      }
    }

    // Fallback 1: organizations[0].id
    const orgs = payload['organizations'];
    if (Array.isArray(orgs) && orgs.length > 0) {
      const first = orgs[0] as Record<string, unknown> | undefined;
      if (first && typeof first['id'] === 'string') return first['id'];
    }

    // Fallback 2: top-level chatgpt_account_id
    if (typeof payload['chatgpt_account_id'] === 'string') {
      return payload['chatgpt_account_id'];
    }
  }
  return undefined;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function needsRefresh(tokens: CodexTokens, now: number = Date.now()): boolean {
  return tokens.expires - now <= 60_000;
}

/**
 * The Codex `/responses` backend enforces a stricter request contract than the
 * standard OpenAI Responses API: `store` MUST be `false`, and `max_output_tokens`
 * is rejected outright. Rewrite the JSON request body to satisfy it. (`stream:true`
 * is set by the AI SDK streaming path, not here.) Non-JSON bodies pass through.
 */
export function sanitizeCodexBody(body: string): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    obj['store'] = false;
    delete obj['max_output_tokens'];
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

export function rewriteCodexUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (
      path.includes('/v1/responses') ||
      path.includes('/chat/completions') ||
      path.includes('/v1/chat')
    ) {
      return CODEX_ENDPOINT;
    }
  } catch {
    // not a URL — leave unchanged
  }
  return url;
}

// ─── HTTP helpers (no deps) ───────────────────────────────────────────────────

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postForm(url: string, params: Record<string, string>): Promise<JsonResponse> {
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function postJson(url: string, data: unknown): Promise<JsonResponse> {
  const body = JSON.stringify(data);
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function fetchJson(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string },
): Promise<JsonResponse> {
  const resp = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  const text = await resp.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { _raw: text };
  }
  return { status: resp.status, body: parsed };
}

function tokensFromResponse(
  body: Record<string, unknown>,
): CodexTokens {
  const access = body['access_token'];
  const refresh = body['refresh_token'];
  const expiresIn = body['expires_in'];
  if (typeof access !== 'string' || typeof refresh !== 'string') {
    throw new Error('Invalid token response: missing access_token or refresh_token');
  }
  const idToken = typeof body['id_token'] === 'string' ? body['id_token'] : '';
  const expiresMs =
    typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : Date.now() + 3600_000;
  return {
    method: 'oauth',
    flavor: 'codex',
    access,
    refresh,
    expires: expiresMs,
    accountId: extractAccountId(idToken, access),
  };
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export async function exchangeCode(code: string, verifier: string): Promise<CodexTokens> {
  const { status, body } = await postForm(`${ISSUER}/oauth/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  if (status !== 200) {
    throw new Error(`Token exchange failed (${status}): ${JSON.stringify(body)}`);
  }
  return tokensFromResponse(body);
}

// ─── Token refresh ────────────────────────────────────────────────────────────

const RE_AUTH_ERRORS = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'invalid_grant',
]);

export async function refreshTokens(tokens: CodexTokens): Promise<CodexTokens> {
  const { status, body } = await postJson(`${ISSUER}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: tokens.refresh,
  });
  if (status !== 200) {
    const errCode =
      typeof body['error'] === 'string' ? body['error'] : '';
    if (RE_AUTH_ERRORS.has(errCode)) {
      const err = new Error(
        `Re-authentication required (${errCode}). Run \`doklo auth\` to log in again.`,
      );
      (err as NodeJS.ErrnoException).code = 'REAUTH_REQUIRED';
      throw err;
    }
    throw new Error(`Token refresh failed (${status}): ${JSON.stringify(body)}`);
  }
  return tokensFromResponse(body);
}

// ─── Browser login ────────────────────────────────────────────────────────────

function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'doklo',
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  // Opening the OS browser is best-effort. The terminal always exposes the
  // authorization URL, so a launcher failure must not crash the callback flow.
  child.on('error', () => {});
  child.unref();
}

export async function loginWithBrowser(
  options: BrowserLoginOptions = {},
): Promise<CodexTokens> {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString('hex');
  const authorizeUrl = buildAuthorizeUrl(challenge, state);
  const runtime: BrowserLoginRuntime = {
    createServer: options.runtime?.createServer ?? http.createServer,
    openBrowser: options.runtime?.openBrowser ?? openBrowser,
    exchangeCode: options.runtime?.exchangeCode ?? exchangeCode,
  };

  return new Promise<CodexTokens>((resolve, reject) => {
    const server = runtime.createServer((req, res) => {
      if (!req.url?.startsWith('/auth/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      const returnedState = reqUrl.searchParams.get('state');
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Login failed. You can close this tab.</h2></body></html>');
        server.close();
        reject(new Error(`OAuth error: ${error} — ${reqUrl.searchParams.get('error_description') ?? ''}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>State mismatch — possible CSRF. Close this tab.</h2></body></html>');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>No code received. Close this tab.</h2></body></html>');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      options.onProgress?.({ phase: 'callback-received' });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h2>Login response received.</h2><p>Please return to the terminal while Doklo is finishing setup.</p></body></html>',
      );
      server.close();

      options.onProgress?.({ phase: 'token-exchanging' });
      runtime.exchangeCode(code, verifier).then(resolve, reject);
    });

    server.listen(PORT, '127.0.0.1', () => {
      options.onProgress?.({ phase: 'browser-opening', authorizeUrl });
      try {
        runtime.openBrowser(authorizeUrl);
      } catch {
        // The callback server remains usable through the displayed fallback URL.
      }
      options.onProgress?.({ phase: 'browser-waiting' });
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start local callback server on port ${PORT}: ${err.message}`));
    });
  });
}

// ─── Device-code login ────────────────────────────────────────────────────────

export async function loginWithDeviceCode(): Promise<CodexTokens> {
  const { status: initStatus, body: initBody } = await postJson(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  );
  if (initStatus !== 200) {
    throw new Error(`Device auth init failed (${initStatus}): ${JSON.stringify(initBody)}`);
  }

  const userCode =
    typeof initBody['user_code'] === 'string' ? initBody['user_code'] : '';
  const verificationUri =
    typeof initBody['verification_uri'] === 'string'
      ? initBody['verification_uri']
      : `${ISSUER}/device`;
  const deviceAuthId =
    typeof initBody['device_auth_id'] === 'string' ? initBody['device_auth_id'] : '';
  const interval =
    typeof initBody['interval'] === 'number' ? initBody['interval'] : 5;

  process.stdout.write(`\nDevice code login:\n`);
  process.stdout.write(`  Code:    ${userCode}\n`);
  process.stdout.write(`  Visit:   ${verificationUri}\n\n`);

  const pollInterval = (interval + 3) * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise<void>((r) => setTimeout(r, pollInterval));
    const { status, body } = await postJson(
      `${ISSUER}/api/accounts/deviceauth/token`,
      { device_auth_id: deviceAuthId, user_code: userCode },
    );
    if (status === 200) {
      return tokensFromResponse(body);
    }
    if (status === 403 || status === 404) {
      // Still pending — keep polling
      continue;
    }
    throw new Error(`Device auth poll failed (${status}): ${JSON.stringify(body)}`);
  }
}

// ─── makeCodexFetch ───────────────────────────────────────────────────────────

/**
 * Returns a `fetch`-compatible function that:
 *  1. Loads tokens via `load()` (throws if null)
 *  2. Auto-refreshes if `needsRefresh` is true
 *  3. Rewrites the URL via `rewriteCodexUrl`
 *  4. Injects Authorization + ChatGPT-Account-Id headers
 *  5. Deletes x-api-key
 *  6. Delegates to `fetchImpl` (defaults to globalThis.fetch)
 *
 * `load` / `save` are injected so this module stays decoupled from the keychain.
 */
export function makeCodexFetch(
  load: () => CodexTokens | null,
  save: (t: CodexTokens) => void,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof fetch {
  return async function codexFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let tokens = load();
    if (!tokens) {
      throw new Error(
        'No Codex credentials found. Run `doklo auth` for OpenAI to log in.',
      );
    }

    if (needsRefresh(tokens)) {
      tokens = await refreshTokens(tokens);
      save(tokens);
    }

    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const rewrittenUrl = rewriteCodexUrl(rawUrl);

    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${tokens.access}`);
    if (tokens.accountId) {
      headers.set('ChatGPT-Account-Id', tokens.accountId);
    }
    headers.delete('x-api-key');

    const newInit: RequestInit = { ...init, headers };
    // Adapt the request body to the Codex backend contract (store:false, no
    // max_output_tokens). The AI SDK sends the body as a JSON string.
    if (typeof init?.body === 'string') {
      newInit.body = sanitizeCodexBody(init.body);
    }

    if (typeof input === 'string' || input instanceof URL) {
      return fetchImpl(rewrittenUrl, newInit);
    } else {
      // input is a Request — build a new one
      return fetchImpl(new Request(rewrittenUrl, { ...input, ...newInit }));
    }
  };
}
