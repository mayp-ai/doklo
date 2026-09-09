import { workspaceRoot } from '../../../../lib/data';
import {
  isGenerationActive,
  startOnboardingGeneration,
} from '../../../../lib/onboarding-generation';
import { generationStreamResponse } from '../../../../lib/generation-response';
import { authorizeGenerationRequest } from '../../../../lib/generation-consent-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function ndjson(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function streamedJsonResponse(
  requestSignal: AbortSignal,
  run: (
    signal: AbortSignal,
    emit: (event: Record<string, unknown>) => Promise<void>,
  ) => Promise<void>,
): Response {
  return generationStreamResponse({
    requestSignal,
    run,
    encode: ndjson,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const service = new URL(req.url).searchParams.get('service')?.trim() ?? '';
  if (!service) {
    return Response.json({ error: 'missing service' }, { status: 400 });
  }

  const consent = authorizeGenerationRequest(req, 'wizard', service);
  if (!consent.authorized) return consent.response;

  const root = workspaceRoot();
  if (isGenerationActive(root, service)) {
    return Response.json({ error: 'Generation already running' }, { status: 409 });
  }

  return streamedJsonResponse(req.signal, (signal, emit) =>
    startOnboardingGeneration({ root, service, signal }, emit),
  );
}
