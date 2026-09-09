import type Handlebars from 'handlebars';
import type { HelperRoot } from './translate.js';

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

export function registerT(hb: typeof Handlebars): void {
  /**
   * {{t "key"}} — look up a static string from the template manifest's
   * `strings: { <locale>: { <key>: <text> } }` map.
   *
   * Fallback chain: active locale → default_locale → raw key (warning).
   */
  hb.registerHelper('t', function (this: unknown, key: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    const k = String(key ?? '');
    if (!k) return '';
    const strings = root.__strings ?? {};
    const active = strings[root.__locale];
    if (active && active[k] !== undefined) return active[k];
    const fallback = root.__defaultLocale ? strings[root.__defaultLocale] : undefined;
    if (fallback && fallback[k] !== undefined) return fallback[k];
    if (root.__stringsMissing) root.__stringsMissing.add(k);
    return k;
  });
}
