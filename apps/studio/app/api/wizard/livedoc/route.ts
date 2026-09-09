// Route handler backing the wizard's Live Doc recommendations. Lives here
// (not in a 'use server' action) on purpose: server actions imported by a
// client component get pulled into Next's "action-browser" bundle, which
// rewrites the engine's `import.meta.url` and breaks its builtin-template /
// default-CSS file lookups. A route handler stays a pure Node server module
// (serverExternalPackages keeps the engine external), so file paths resolve.

import { readFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { workspaceRoot, loadWorkspace, loadLexicon, listDoks } from '../../../../lib/data';
import { GALLERY_LIVEDOCS, type RenderedDoc } from '../../../../lib/livedoc-templates';
import { inlinePreviewAssets } from '../../../../lib/livedoc-preview-document';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `serverExternalPackages` does not reliably keep the engine out of the
// webpack bundle here, and once bundled webpack rewrites the HTML writer's
// `import.meta.url`-based default-CSS read into a missing `.next` asset.
// `webpackIgnore` forces a native runtime import so the engine loads as a
// real Node ESM module (resolved via the workspace symlink) with its file
// paths intact.
async function loadEngine(): Promise<typeof import('@doklo-beta/livedoc-engine')> {
  return import(/* webpackIgnore: true */ '@doklo-beta/livedoc-engine');
}

const BINARY_MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  hwpx: 'application/hwp+zip',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Captured Dok ids, most recent capture first. */
async function capturedByRecency(root: string): Promise<string[]> {
  try {
    const dir = join(root, '.doklo', 'screenshots');
    const ids = await readdir(dir);
    const stamped = await Promise.all(
      ids.map(async (id) => ({ id, mtime: (await stat(join(dir, id))).mtimeMs })),
    );
    return stamped.sort((a, b) => b.mtime - a.mtime).map((s) => s.id);
  } catch {
    return [];
  }
}

async function renderWizardLivedoc(
  ref: string | undefined,
  reqLocale: string | undefined,
  reqDok?: string,
): Promise<RenderedDoc> {
  const meta = GALLERY_LIVEDOCS.find((t) => t.ref === ref);
  if (!meta || !ref) {
    throw new Error(`Unknown Live Doc template: ${ref}`);
  }

  const root = workspaceRoot();
  const workspace = await loadWorkspace();
  // Allow the dual-market locales (en / ko) regardless of what the
  // workspace declares — the engine renders the requested locale and
  // falls back per-field to the primary locale where a translation is
  // missing (so en yields English template chrome + ko Dok content for a
  // ko-only Hub).
  const locale =
    reqLocale === 'en' || reqLocale === 'ko'
      ? reqLocale
      : (workspace?.default_locale ?? 'ko');
  const outDir = await mkdtemp(join(tmpdir(), `doklo-wizard-livedoc-${ref}-${locale}-`));

  try {
    // per_dok templates → render one Dok so the result is a single
    // downloadable file. An explicit ?dok= wins; otherwise prefer the most
    // recently captured Dok (.doklo/screenshots/<DOK-ID>/ mtime) — the
    // operator's latest capture is the current demo focus, and the tutorial
    // reads completely differently with real captures than placeholders.
    let dokIds: string[] | undefined;
    if (meta.scope === 'per_dok') {
      const lexicon = await loadLexicon();
      const summaries = await listDoks({ lexicon, locale });
      if (reqDok && summaries.some((s) => s.dok_id === reqDok)) {
        dokIds = [reqDok];
      } else {
        const pick =
          (await capturedByRecency(root)).find((id) => summaries.some((s) => s.dok_id === id)) ??
          summaries[0]?.dok_id;
        if (pick) dokIds = [pick];
      }
    }

    const { renderLivedoc } = await loadEngine();
    const target = meta.preview ?? 'html';
    const result = await renderLivedoc({
      workspaceRoot: root,
      templateRef: ref,
      locale,
      outDir,
      format: target,
      ...(dokIds ? { dokIds } : {}),
    });
    if (target === 'html') {
      const htmlOut = result.outputs.find((o) => o.format === 'html');
      if (!htmlOut) {
        throw new Error(`No HTML output produced for '${ref}'`);
      }
      const html = await readFile(htmlOut.path, 'utf-8');
      const base = basename(htmlOut.path);
      return { kind: 'html', html: await inlinePreviewAssets(html, outDir), filename: `${locale}-${base}` };
    }
    // Binary deliverables (xlsx / hwpx) — download-only, no inline preview.
    const binOut = result.outputs.find((o) => o.format === target);
    if (!binOut) {
      throw new Error(`No ${target} output produced for '${ref}'`);
    }
    const data = await readFile(binOut.path);
    return {
      kind: 'binary',
      dataBase64: data.toString('base64'),
      mime: BINARY_MIME[target] ?? 'application/octet-stream',
      filename: `${locale}-${basename(binOut.path)}`,
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function POST(req: Request): Promise<Response> {
  const { ref, locale, dok } = (await req.json()) as {
    ref?: string;
    locale?: string;
    dok?: string;
  };
  try {
    return Response.json(await renderWizardLivedoc(ref, locale, dok));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

// GET serves the rendered document directly, so pages can link to it with
// a plain <a> (no blob URL / popup-blocker concerns during the demo).
// HTML renders as a page; binary deliverables download with their filename.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ref = url.searchParams.get('ref') ?? undefined;
  const locale = url.searchParams.get('locale') ?? undefined;
  const dok = url.searchParams.get('dok') ?? undefined;
  try {
    const doc = await renderWizardLivedoc(ref, locale, dok);
    if (doc.kind === 'html') {
      return new Response(doc.html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(new Uint8Array(Buffer.from(doc.dataBase64, 'base64')), {
      headers: {
        'content-type': doc.mime,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
