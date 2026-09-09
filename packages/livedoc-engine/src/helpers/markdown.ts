import type Handlebars from 'handlebars';
import { marked } from 'marked';

export function registerMarkdown(hb: typeof Handlebars): void {
  /**
   * {{markdown text}} — render inline Markdown to HTML.
   *
   * Used rarely inside templates (most templates write Markdown directly and
   * the HTML writer handles full-doc rendering). Provided for cases where a
   * Translatable contains short inline Markdown that needs HTML in an HTML
   * shell context.
   */
  hb.registerHelper('markdown', function (text: unknown) {
    const s = String(text ?? '');
    if (!s) return '';
    return new hb.SafeString(marked.parseInline(s) as string);
  });
}
