import { z } from 'zod';
import { resolveStudioCliBin } from '../../../../../lib/cli-bin';
import { workspaceRoot } from '../../../../../lib/data';
import {
  loadPublicationWorkspaceModel,
} from '../../../../../lib/publication-read-model';
import {
  PublicationAlreadyRunningError,
  PublicationCommandFailedError,
  PublicationFingerprintStaleError,
  runPublicationAction,
  StudioPublicationActionSchema,
  StudioPublicationInputError,
} from '../../../../../lib/publication-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const root = workspaceRoot();
  try {
    const { name } = await context.params;
    const value = StudioPublicationActionSchema.parse(
      await request.json(),
    );
    const cliBin = await resolveStudioCliBin();
    const outcome = await runPublicationAction({
      root,
      cliBin,
      name,
      value,
      loadModel: () => loadPublicationWorkspaceModel({ root }),
      signal: request.signal,
    });
    const model = await loadPublicationWorkspaceModel({ root });
    return json(
      { ...outcome, model },
      outcome.status === 'partial' ? 207 : 200,
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof StudioPublicationInputError) {
      return json(
        { code: 'PUBLICATION_INPUT_INVALID', error: error.message },
        400,
      );
    }
    if (
      error instanceof PublicationAlreadyRunningError
      || error instanceof PublicationFingerprintStaleError
    ) {
      return json(
        {
          code: error.code,
          error: error.message,
          ...(error instanceof PublicationFingerprintStaleError
            ? { current_fingerprint: error.current }
            : {}),
        },
        409,
      );
    }
    if (error instanceof PublicationCommandFailedError) {
      return json(
        {
          code: error.code,
          error: error.message,
          diagnostics: error.result.diagnostics,
        },
        409,
      );
    }
    return json(
      {
        code: 'PUBLICATION_ACTION_FAILED',
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
