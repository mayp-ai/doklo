import { randomBytes } from 'node:crypto';
import {
  GENERATION_ACTION_HEADER,
  GENERATION_CONSENT_HEADER,
  REQUEST_GENERATION_CONSENT,
  START_GENERATION,
} from './generation-consent';

export type GenerationConsentScope = 'wizard' | 'consolidation';

export type GenerationConsentResult =
  | { authorized: true }
  | { authorized: false; response: Response };

interface ConsentRecord {
  expiresAt: number;
  origin: string;
  scope: GenerationConsentScope;
  service: string;
  sessionId: string;
}

const SESSION_COOKIE = 'doklo_generation_session';
const CONSENT_TTL_MS = 2 * 60 * 1000;
const OPAQUE_VALUE = /^[A-Za-z0-9_-]{32,128}$/;
const consentRecords = new Map<string, ConsentRecord>();

function opaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function errorResponse(error: string): Response {
  return Response.json(
    { error },
    {
      status: 403,
      headers: {
        'Cache-Control': 'no-store',
        Vary: 'Origin, Cookie',
      },
    },
  );
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    const loopbackHost = originUrl.hostname === 'localhost'
      || originUrl.hostname === '127.0.0.1'
      || originUrl.hostname === '[::1]'
      || originUrl.hostname === '::1';
    const host = request.headers.get('host');
    const browserOrigin = host === null
      ? requestUrl.origin
      : new URL(`${requestUrl.protocol}//${host}`).origin;
    return loopbackHost && originUrl.origin === browserOrigin
      ? originUrl.origin
      : null;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get('cookie');
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return OPAQUE_VALUE.test(value) ? value : null;
  }
  return null;
}

function deleteExpiredConsent(now: number): void {
  for (const [token, record] of consentRecords) {
    if (record.expiresAt <= now) consentRecords.delete(token);
  }
}

function issueConsent(
  request: Request,
  origin: string,
  scope: GenerationConsentScope,
  service: string,
): Response {
  const now = Date.now();
  deleteExpiredConsent(now);
  const sessionId = cookieValue(request, SESSION_COOKIE) ?? opaqueValue();

  for (const [token, record] of consentRecords) {
    if (
      record.sessionId === sessionId &&
      record.origin === origin &&
      record.scope === scope &&
      record.service === service
    ) {
      consentRecords.delete(token);
    }
  }

  const consentToken = opaqueValue();
  consentRecords.set(consentToken, {
    expiresAt: now + CONSENT_TTL_MS,
    origin,
    scope,
    service,
    sessionId,
  });

  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return Response.json(
    { consentToken },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/api${secure}`,
        Vary: 'Origin, Cookie',
      },
    },
  );
}

export function authorizeGenerationRequest(
  request: Request,
  scope: GenerationConsentScope,
  service: string,
): GenerationConsentResult {
  const origin = requestOrigin(request);
  const fetchSite = request.headers.get('sec-fetch-site');
  if (!origin || (fetchSite !== null && fetchSite !== 'same-origin')) {
    return {
      authorized: false,
      response: errorResponse('Generation requests must come from this Studio origin.'),
    };
  }

  const action = request.headers.get(GENERATION_ACTION_HEADER);
  if (action === REQUEST_GENERATION_CONSENT) {
    return {
      authorized: false,
      response: issueConsent(request, origin, scope, service),
    };
  }
  if (action !== START_GENERATION) {
    return {
      authorized: false,
      response: errorResponse('Generation requires an explicit Studio action.'),
    };
  }

  const consentToken = request.headers.get(GENERATION_CONSENT_HEADER);
  const sessionId = cookieValue(request, SESSION_COOKIE);
  if (!consentToken || !OPAQUE_VALUE.test(consentToken) || !sessionId) {
    return {
      authorized: false,
      response: errorResponse('Generation consent is missing or invalid.'),
    };
  }

  const now = Date.now();
  deleteExpiredConsent(now);
  const record = consentRecords.get(consentToken);
  if (
    !record ||
    record.expiresAt <= now ||
    record.sessionId !== sessionId ||
    record.origin !== origin ||
    record.scope !== scope ||
    record.service !== service
  ) {
    return {
      authorized: false,
      response: errorResponse('Generation consent is missing or invalid.'),
    };
  }

  consentRecords.delete(consentToken);
  return { authorized: true };
}
