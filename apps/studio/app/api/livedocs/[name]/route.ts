import { workspaceRoot } from '../../../../lib/data';
import {
  readOfficialPublicationPreview,
} from '../../../../lib/publication-preview';
import {
  loadPublicationWorkspaceModel,
} from '../../../../lib/publication-read-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    const { name } = await context.params;
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
    const officialPreview = await readOfficialPublicationPreview({
      root,
      entry,
    });
    return json({
      model,
      entry,
      ...(officialPreview ? { official_preview: officialPreview } : {}),
    });
  } catch (error) {
    return json(
      {
        code: 'PUBLICATION_READ_FAILED',
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
