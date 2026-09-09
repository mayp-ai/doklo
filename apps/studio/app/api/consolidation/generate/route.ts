import { spawn } from 'node:child_process';
import { workspaceRoot } from '../../../../lib/data';
import { resolveStudioCliBin } from '../../../../lib/cli-bin';
import { generationStreamResponse } from '../../../../lib/generation-response';
import { authorizeGenerationRequest } from '../../../../lib/generation-consent-server';
import {
  acquireGenerationRun,
  isGenerationActive,
} from '../../../../lib/generation-run';
import { streamCliGenerate, type CliChild } from '../../../../lib/generate-subprocess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();
const ndjson = (event: Record<string, unknown>) => encoder.encode(`${JSON.stringify(event)}\n`);

function ndjsonError(message: string, status: number): Response {
  return new Response(ndjson({ stage: 'error', message }), {
    status,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const service = new URL(req.url).searchParams.get('service')?.trim() ?? '';
  if (!service) return ndjsonError('missing service', 400);

  const consent = authorizeGenerationRequest(req, 'consolidation', service);
  if (!consent.authorized) return consent.response;

  const root = workspaceRoot();
  if (isGenerationActive(root, service)) {
    return ndjsonError('Generation already running', 409);
  }

  return generationStreamResponse({
    requestSignal: req.signal,
    encode: ndjson,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    run: async (signal, emit) => {
      const lease = acquireGenerationRun(root, service);
      try {
        const cliBin = await resolveStudioCliBin();
        await streamCliGenerate(
          { cliBin, root, service, signal },
          emit,
          {
            spawn: (cmd, args, opts) =>
              spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as CliChild,
          },
        );
      } finally {
        lease.release();
      }
    },
  });
}
