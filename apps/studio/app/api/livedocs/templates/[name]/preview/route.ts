import { z } from 'zod';
import { workspaceRoot } from '../../../../../../lib/data';
import {
  getPublicationTemplatePreview,
  PreviewCancelledError,
} from '../../../../../../lib/publication-template-preview';
import {
  loadPublicationWorkspaceModel,
} from '../../../../../../lib/publication-read-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PreviewRequestSchema = z.object({
  locale: z.string().min(1),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  try {
    if (request.signal.aborted) throw new PreviewCancelledError();
    const { name } = await context.params;
    const { locale } = PreviewRequestSchema.parse(await request.json());
    const root = workspaceRoot();
    const model = await loadPublicationWorkspaceModel({ root });
    const template = model.templates.find((candidate) => candidate.name === name);
    if (!template) {
      return json(
        {
          code: 'PUBLICATION_TEMPLATE_NOT_FOUND',
          error: `Template '${name}' was not found.`,
        },
        404,
      );
    }
    if (!template.supported_locales.includes(locale)) {
      return json(
        {
          code: 'PUBLICATION_TEMPLATE_PREVIEW_INPUT_INVALID',
          error: `Locale '${locale}' is not supported by Template '${name}'.`,
        },
        400,
      );
    }
    const preview = await getPublicationTemplatePreview({
      root,
      template,
      locale,
      signal: request.signal,
    });
    return json(preview);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json(
        {
          code: 'PUBLICATION_TEMPLATE_PREVIEW_INPUT_INVALID',
          error: error.message,
        },
        400,
      );
    }
    if (error instanceof PreviewCancelledError || request.signal.aborted) {
      return json(
        {
          code: 'PUBLICATION_TEMPLATE_PREVIEW_CANCELLED',
          error: 'Template preview was cancelled.',
        },
        499,
      );
    }
    return json(
      {
        code: 'PUBLICATION_TEMPLATE_PREVIEW_FAILED',
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
