import type Handlebars from 'handlebars';
import type { HelperRoot } from './translate.js';

function helperRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

function normalizeInline(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ {2,}/gu, ' ');
}

export function escapeMarkdownText(value: unknown): string {
  return normalizeInline(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/([\\`*_[\]~])/gu, '\\$1')
    .replace(/^(\s*)(#{1,6}|[+-])(?=\s)/u, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s)/u, '$1$2\\$3')
    .replace(/^(\s*)((?:={3,}|-{3,}))(?=\s*$)/u, '$1\\$2');
}

export function escapeMarkdownCell(value: unknown): string {
  return escapeMarkdownText(value).replace(/\|/gu, '\\|');
}

export function markdownCodeSpan(value: unknown): string {
  const text = normalizeInline(value);
  const longestRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding = longestRun > 0 || /^\s|\s$/u.test(text);
  return needsPadding
    ? `${fence} ${text} ${fence}`
    : `${fence}${text}${fence}`;
}

export function registerMarkdownEscape(hb: typeof Handlebars): void {
  const markdownOnly = (
    transform: (value: unknown) => string,
  ) => function (
    this: unknown,
    value: unknown,
    options: Handlebars.HelperOptions,
  ): string {
    if (helperRoot(this, options).__outputSource !== 'markdown') {
      return String(value ?? '');
    }
    return transform(value);
  };

  hb.registerHelper('md_text', markdownOnly(escapeMarkdownText));
  hb.registerHelper('md_cell', markdownOnly(escapeMarkdownCell));
  hb.registerHelper('md_code', markdownOnly(markdownCodeSpan));
}
