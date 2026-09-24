import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import type { Writer } from './types.js';
import { resolveTemplatePath } from '../path-security.js';
import { writePlannedArtifact } from '../atomic-output.js';

let defaultCssCache: string | null = null;

async function loadDefaultCss(): Promise<string> {
  if (defaultCssCache !== null) return defaultCssCache;
  const here = fileURLToPath(import.meta.url);
  const writersDir = dirname(here);
  const candidates = [
    join(writersDir, '..', 'css', 'default.css'),
    join(writersDir, '..', '..', 'src', 'css', 'default.css'),
  ];
  for (const c of candidates) {
    try {
      defaultCssCache = await readFile(c, 'utf-8');
      return defaultCssCache;
    } catch {
      // try next
    }
  }
  defaultCssCache = '';
  return defaultCssCache;
}

async function readContainedIfExists(
  root: string,
  relativePath: string,
  label: string,
): Promise<string | null> {
  const path = await resolveTemplatePath(root, relativePath, label, {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Build the cascaded stylesheet for one HTML emit.
 *
 *  1. Engine default (unless the template opts out via extends_default_css: false)
 *  2. Template-level `assets/style.css`
 *  3. Workspace-level `.doklo/branding/livedoc.css`
 *
 * Each layer is wrapped in a comment marker so authors can see in DevTools
 * which file contributed what. Later layers override earlier ones via normal
 * CSS cascade (same specificity, later wins).
 */
async function buildStylesheet(
  templateDir: string | undefined,
  workspaceRoot: string | undefined,
  extendsDefault: boolean,
): Promise<string> {
  const parts: string[] = [];
  if (extendsDefault) {
    const def = await loadDefaultCss();
    if (def) parts.push(`/* layer: doklo-default */\n${def}`);
  }
  if (templateDir) {
    const tmplCss = await readContainedIfExists(
      templateDir,
      'assets/style.css',
      'template stylesheet',
    );
    if (tmplCss) parts.push(`/* layer: template */\n${tmplCss}`);
  }
  if (workspaceRoot) {
    const brandCss = await readContainedIfExists(
      workspaceRoot,
      '.doklo/branding/livedoc.css',
      'workspace branding stylesheet',
    );
    if (brandCss) parts.push(`/* layer: workspace-branding */\n${brandCss}`);
  }
  return parts.join('\n\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Configure a marked instance that:
 *  - turns ```mermaid blocks into <div class="mermaid">…</div> so the
 *    Mermaid CDN script picks them up at runtime,
 *  - leaves other code blocks alone (default marked renderer).
 * Returns { parse, hasMermaid } where hasMermaid is whether the source
 * contained at least one mermaid block (drives CDN script injection).
 */
function renderMarkdown(src: string): { html: string; hasMermaid: boolean } {
  let hasMermaid = false;
  const renderer = new marked.Renderer();
  const originalCode = renderer.code.bind(renderer);
  renderer.code = function (this: unknown, token: any) {
    const lang = (token?.lang ?? '').trim().toLowerCase();
    if (lang === 'mermaid') {
      hasMermaid = true;
      return `<div class="mermaid">\n${token.text}\n</div>\n`;
    }
    return originalCode(token);
  } as typeof renderer.code;
  const html = marked.parse(src, { renderer }) as string;
  return { html, hasMermaid };
}

function wrapInShell(args: {
  title: string;
  lang: string;
  body: string;
  css: string;
  hasMermaid: boolean;
}): string {
  const mermaidScript = args.hasMermaid
    ? `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="${escapeHtml(args.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="@doklo-beta/livedoc-engine">
<title>${escapeHtml(args.title)}</title>
<style>${args.css}</style>
</head>
<body>
<main class="livedoc">
${args.body}
</main>
${mermaidScript}
</body>
</html>
`;
}

/**
 * Derive the document <title> from the first heading in the rendered body
 * (per-Dok pages get "이메일 로그인 — 도움말" instead of a bare "도움말"),
 * falling back to the template display name when no heading exists.
 */
function deriveTitle(body: string, displayName: string): string {
  const m = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(body);
  if (!m?.[2]) return displayName;
  const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return displayName;
  return text === displayName ? text : `${text} — ${displayName}`;
}

function sanitizeFragment(rawHtml: string): string {
  const body = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'link'],
    RETURN_DOM: true,
  });
  // Prose is untrusted even in a reviewed Dok. Inline CSS could cover the
  // host app, so preserve only the four bounded screenshot coordinates.
  // The engine-owned preview banner is appended after this sanitization.
  for (const element of body.querySelectorAll('[style]')) {
    const geometry = /^left:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)%;top:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)%;width:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)%;height:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)%$/i
      .exec(element.getAttribute('style') ?? '');
    const coordinates = geometry?.slice(1).map(Number);
    if (
      !element.matches('span.help-shot-wrap > span.help-shot-box')
      || !coordinates?.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
      || coordinates[0]! + coordinates[2]! > 100
      || coordinates[1]! + coordinates[3]! > 100
    ) {
      element.removeAttribute('style');
    }
  }
  return body.innerHTML;
}

export const htmlWriter: Writer = async (ctx) => {
  const { html: rawHtml, hasMermaid } = ctx.source === 'html'
    ? { html: ctx.content, hasMermaid: false }
    : renderMarkdown(ctx.content);
  // dompurify strips <script>, so we sanitize the body (Mermaid CDN script
  // is added by the shell *after* sanitization, never from user content).
  const safeBody = ctx.html?.fragment ? sanitizeFragment(rawHtml) : DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['div'],
    // style: templates position screenshot annotation boxes via inline
    // percentage coords (left/top/width/height) — no other way to carry
    // per-image geometry through a static stylesheet.
    ADD_ATTR: ['class', 'style'],
  });
  const displayName =
    ctx.template.display_name?.[ctx.locale] ??
    ctx.template.display_name?.[ctx.template.default_locale] ??
    ctx.template.name;
  const title = deriveTitle(safeBody, displayName);
  const previewBanner = ctx.preview
    ? `<aside data-doklo-preview="draft" role="note" style="display:block!important;visibility:visible!important;opacity:1!important;padding:1rem!important;border:3px solid #8a4b00!important;background:#fff4cf!important;color:#332000!important;font:700 16px/1.5 sans-serif!important">Draft preview — Not reviewed or approved for publication.${ctx.locale.startsWith('ko') ? ' 미검토 초안 — 게시 승인되지 않았습니다.' : ''}</aside>\n`
    : '';
  // Fragments retain sanitization and the engine-owned preview banner, but
  // never read or embed template/branding CSS or shell-added CDN scripts.
  const html = ctx.html?.fragment ? `${previewBanner}${safeBody}\n` : wrapInShell({
    title: ctx.preview ? `Draft preview — ${title}` : title,
    lang: ctx.locale,
    body: previewBanner + safeBody,
    css: await buildStylesheet(ctx.templateDir, ctx.workspaceRoot, ctx.template.extends_default_css !== false),
    hasMermaid,
  });
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, html);
  return { path, bytes: Buffer.byteLength(html), format: 'html' };
};
