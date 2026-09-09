export const GENERATION_ACTION_HEADER = 'x-doklo-generation-action';
export const GENERATION_CONSENT_HEADER = 'x-doklo-generation-consent';
export const REQUEST_GENERATION_CONSENT = 'request-consent';
export const START_GENERATION = 'start-generation';

interface ConsentPayload {
  consentToken?: unknown;
}

export class GenerationConsentError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Generation consent request failed with status ${status}.`);
    this.name = 'GenerationConsentError';
    this.status = status;
  }
}

export async function acquireGenerationConsent(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { [GENERATION_ACTION_HEADER]: REQUEST_GENERATION_CONSENT },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new GenerationConsentError(response.status);

  let payload: ConsentPayload;
  try {
    payload = await response.json() as ConsentPayload;
  } catch {
    throw new Error('Generation consent response was unreadable.');
  }
  if (typeof payload.consentToken !== 'string' || payload.consentToken.length === 0) {
    throw new Error('Generation consent response was unreadable.');
  }
  return payload.consentToken;
}

export function startGenerationRequest(
  url: string,
  consentToken: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      [GENERATION_ACTION_HEADER]: START_GENERATION,
      [GENERATION_CONSENT_HEADER]: consentToken,
    },
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
}
