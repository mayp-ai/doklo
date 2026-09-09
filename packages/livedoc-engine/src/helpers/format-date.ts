import type Handlebars from 'handlebars';
import type { HelperRoot } from './translate.js';

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

export function registerFormatDate(hb: typeof Handlebars): void {
  /**
   * {{format_date isoString}} — locale-aware long-form date.
   *
   * ko: "2026년 5월 29일", en: "May 29, 2026"
   * Falls back to the raw input if it fails to parse.
   */
  hb.registerHelper('format_date', function (this: unknown, iso: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    const raw = String(iso ?? '');
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    try {
      return new Intl.DateTimeFormat(root.__locale, { dateStyle: 'long' }).format(d);
    } catch {
      return raw;
    }
  });

  /**
   * {{render_date}} — the generation date, locale-formatted.
   *
   * For point-in-time evidence sheets ("기준일") the render moment is the
   * factual as-of date of the snapshot.
   */
  hb.registerHelper('render_date', function (this: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    try {
      return new Intl.DateTimeFormat(root.__locale, { dateStyle: 'long' }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  });
}
