import { resolveContainedPath } from '@doklo-beta/core';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

export async function inlinePreviewAssets(
  html: string,
  outDir: string,
): Promise<string> {
  const refs = [...html.matchAll(/src="(_assets\/[^"]+)"/gu)]
    .map((match) => match[1]!);
  let output = html;
  for (const relativePath of new Set(refs)) {
    try {
      const path = await resolveContainedPath(outDir, decodeURI(relativePath), {
        rejectSymlinkLeaf: true,
      });
      const mime = IMAGE_MIME[extname(path).toLowerCase()];
      if (!mime) continue;
      const bytes = await readFile(path);
      output = output.replaceAll(
        `src="${relativePath}"`,
        `src="data:${mime};base64,${bytes.toString('base64')}"`,
      );
    } catch {
      // Keep a missing or unsafe asset reference visible in the preview.
    }
  }
  return output;
}

export function textPreviewDocument(
  text: string,
  filename: string,
  locale: string,
): string {
  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(filename)}</title>
<style>
body{margin:0;background:#f8f8fb;color:#23212b;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
header{position:sticky;top:0;padding:12px 20px;border-bottom:1px solid #e5e3eb;background:#fdfcff;font:600 12px/1.4 system-ui,sans-serif}
pre{box-sizing:border-box;margin:0 auto;max-width:980px;min-height:100vh;padding:32px 28px;white-space:pre-wrap;overflow-wrap:anywhere;background:#fdfcff}
</style>
</head>
<body><header>${escapeHtml(filename)}</header><pre>${escapeHtml(text)}</pre></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
