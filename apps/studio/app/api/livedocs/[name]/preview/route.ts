import { z } from 'zod';
import { workspaceRoot } from '../../../../../lib/data';
import {
  renderPublicationCandidateSingleFlight,
} from '../../../../../lib/publication-preview';
import {
  loadPublicationWorkspaceModel,
} from '../../../../../lib/publication-read-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PreviewRequestSchema = z.object({
  fingerprint: z.string().min(1),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await context.params;
    const { fingerprint } = PreviewRequestSchema.parse(
      await request.json(),
    );
    const root = workspaceRoot();
    const model = await loadPublicationWorkspaceModel({ root });
    const entry = model.publications.find(
      (candidate) => candidate.publication.name === name,
    );
    if (!entry) {
      return json(
        {
          code: 'PUBLICATION_NOT_FOUND',
          error: `Publication '${name}' was not found.`,
        },
        404,
      );
    }
    if (entry.status.input_fingerprint !== fingerprint) {
      return json(
        {
          code: 'PUBLICATION_FINGERPRINT_STALE',
          error: 'The Dok Hub changed. Refresh the candidate before reviewing it.',
          current_fingerprint: entry.status.input_fingerprint,
        },
        409,
      );
    }
    const candidate = await renderPublicationCandidateSingleFlight({
      root,
      entry,
      model,
      signal: request.signal,
    });
    return json(candidate);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json(
        {
          code: 'PUBLICATION_PREVIEW_INPUT_INVALID',
          error: error.message,
        },
        400,
      );
    }
    if (request.signal.aborted) {
      return json(
        {
          code: 'PUBLICATION_PREVIEW_CANCELLED',
          error: 'Candidate preview was cancelled.',
        },
        499,
      );
    }
    return json(
      {
        code: 'PUBLICATION_PREVIEW_FAILED',
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
