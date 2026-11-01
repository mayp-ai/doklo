import type Handlebars from 'handlebars';
import type { HelperRoot } from './translate.js';

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

/** A calendar day with no time of its own — a history entry's `date`. */
const DATE_LABEL = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * The zone instants are printed in: the publication's `timezone` when it has
 * one (`__timezone`, set by render orchestration), else UTC. Never the host's
 * zone — a renderer west of Greenwich must not print the day before.
 */
function zoneOf(root: HelperRoot): string {
  return root.__timezone ?? 'UTC';
}

/** Format in the given zone; a zone Intl does not know falls back to UTC. */
/**
 * The text `format_date` would print for `value` under `locale` and
 * `timezone` (undefined = UTC) — for renderers that build their view outside
 * Handlebars (pptx). Empty for an empty or unparseable value.
 */
export function formatDateLabel(locale: string, timezone: string | undefined, value: string | undefined): string {
  const raw = String(value ?? '');
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return formatIn(locale, DATE_LABEL.test(raw) ? 'UTC' : (timezone ?? 'UTC'), d);
  } catch {
    return raw;
  }
}

function formatIn(locale: string, timeZone: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
  }
}

export function registerFormatDate(hb: typeof Handlebars): void {
  /**
   * {{format_date value}} — locale-aware long-form date.
   *
   * ko: "2026년 5월 29일", en: "May 29, 2026"
   * Falls back to the raw input if it fails to parse.
   *
   * Two kinds of value arrive here and they are not treated alike:
   *   · a date-only label (`YYYY-MM-DD`, a Dok history entry's day) names a
   *     calendar day and prints as that day in every zone — formatted in UTC
   *     so no zone can move it;
   *   · an instant (an ISO timestamp — the Hub's newest recorded moment, a
   *     workspace timestamp) is a point in time and prints in the
   *     publication's zone, UTC when it has none.
   */
  hb.registerHelper('format_date', function (this: unknown, iso: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    const raw = String(iso ?? '');
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    try {
      return formatIn(root.__locale, DATE_LABEL.test(raw) ? 'UTC' : zoneOf(root), d);
    } catch {
      return raw;
    }
  });

  /**
   * {{render_date}} — the generation date, locale-formatted, in the
   * publication's zone (UTC when it has none).
   *
   * For point-in-time evidence sheets ("기준일") the render moment is the
   * factual as-of date of the snapshot.
   */
  hb.registerHelper('render_date', function (this: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    try {
      return formatIn(root.__locale, zoneOf(root), new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  });
}
