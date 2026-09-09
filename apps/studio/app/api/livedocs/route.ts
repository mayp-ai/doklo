import { z } from 'zod';
import { resolveStudioCliBin } from '../../../lib/cli-bin';
import { workspaceRoot } from '../../../lib/data';
import {
  loadPublicationWorkspaceModel,
} from '../../../lib/publication-read-model';
import {
  PublicationAlreadyRunningError,
  PublicationCommandFailedError,
  runPublicationCreate,
  StudioPublicationCreateSchema,
  StudioPublicationInputError,
} from '../../../lib/publication-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const model = await loadPublicationWorkspaceModel({
      root: workspaceRoot(),
    });
    return noStoreJson(model);
  } catch (error) {
    return noStoreJson(
      { error: errorMessage(error), code: 'PUBLICATION_READ_FAILED' },
      500,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const root = workspaceRoot();
  try {
    const value = StudioPublicationCreateSchema.parse(
      await request.json(),
    );
    const model = await loadPublicationWorkspaceModel({ root });
    const cliBin = await resolveStudioCliBin();
    const outcome = await runPublicationCreate({
      root,
      cliBin,
      value,
      model,
      signal: request.signal,
    });
    const fresh = await loadPublicationWorkspaceModel({ root });
    return outcome.status === 'partial'
      ? noStoreJson({ ...outcome, model: fresh }, 207)
      : noStoreJson(fresh, 201);
  } catch (error) {
    if (
      error instanceof z.ZodError
      || error instanceof StudioPublicationInputError
    ) {
      return noStoreJson(
        {
          error: errorMessage(error),
          code: 'PUBLICATION_INPUT_INVALID',
        },
        400,
      );
    }
    if (error instanceof PublicationAlreadyRunningError) {
      return noStoreJson(
        { error: error.message, code: error.code },
        409,
      );
    }
    if (error instanceof PublicationCommandFailedError) {
      return noStoreJson(
        {
          error: error.message,
          code: error.code,
          diagnostics: error.result.diagnostics,
        },
        409,
      );
    }
    return noStoreJson(
      { error: errorMessage(error), code: 'PUBLICATION_CREATE_FAILED' },
      500,
    );
  }
}

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
