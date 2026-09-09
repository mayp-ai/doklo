import type Handlebars from 'handlebars';

/**
 * Math + comparison + collection helpers.
 *
 * Handlebars ships only `if`, `unless`, `each`, `with`, `lookup`, `log` —
 * no math, no comparisons, no length. Templates need at least these to
 * write any non-trivial loop logic.
 */
export function registerMathHelpers(hb: typeof Handlebars): void {
  hb.registerHelper('add', (a: unknown, b: unknown) => Number(a) + Number(b));
  hb.registerHelper('sub', (a: unknown, b: unknown) => Number(a) - Number(b));
  hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hb.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
  hb.registerHelper('gt', (a: unknown, b: unknown) => Number(a) > Number(b));
  hb.registerHelper('lt', (a: unknown, b: unknown) => Number(a) < Number(b));
  hb.registerHelper('gte', (a: unknown, b: unknown) => Number(a) >= Number(b));
  hb.registerHelper('lte', (a: unknown, b: unknown) => Number(a) <= Number(b));

  hb.registerHelper('len', (v: unknown) => {
    if (Array.isArray(v)) return v.length;
    if (typeof v === 'string') return v.length;
    if (v && typeof v === 'object') return Object.keys(v as object).length;
    return 0;
  });

  hb.registerHelper('join', (arr: unknown, sep: unknown) => {
    if (!Array.isArray(arr)) return '';
    // Handlebars passes its HelperOptions object as the trailing arg when
    // the helper is invoked without an explicit second positional value.
    // Treat anything non-string as "no separator given" and fall back to ', '.
    const s = typeof sep === 'string' ? sep : ', ';
    return arr.join(s);
  });

  hb.registerHelper('concat', (...values: unknown[]) => {
    const positional = values.slice(0, -1);
    return positional.map((value) => String(value ?? '')).join('');
  });

  hb.registerHelper('default', (value: unknown, fallback: unknown) => {
    return value === undefined || value === null || value === '' ? fallback : value;
  });
}
