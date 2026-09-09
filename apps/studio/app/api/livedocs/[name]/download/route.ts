import { workspaceRoot } from '../../../../../lib/data';
import {
  PublicationExportNotFoundError,
  readPublicationExport,
} from '../../../../../lib/publication-download';
import {
  loadPublicationWorkspaceModel,
} from '../../../../../lib/publication-read-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const root = workspaceRoot();
  const { name } = await context.params;
  try {
    const model = await loadPublicationWorkspaceModel({ root });
    const archive = await readPublicationExport({ root, name, model });
    return new Response(Uint8Array.from(archive.bytes).buffer, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition':
          `attachment; filename="${asciiFilename(archive.filename)}"`,
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof PublicationExportNotFoundError) {
      return Response.json(
        { code: error.code, error: error.message },
        {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
    }
    return Response.json(
      {
        code: 'PUBLICATION_EXPORT_READ_FAILED',
        error: error instanceof Error ? error.message : String(error),
      },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}

function asciiFilename(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe.length > 0 ? safe : 'publication.zip';
}
