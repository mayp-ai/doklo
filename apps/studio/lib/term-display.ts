import type { Dok, LexiconTerm, LexiconCategory } from '@doklo-beta/core';

/**
 * Pure Lexicon display helpers + category decoration for the Studio
 * presentation layer. i18n-bound terms have no display text here: their
 * text lives in the workspace's i18n files (the SoT), and Studio has no
 * i18n-file reader yet, so `termDisplay` returns null for them.
 */

/** Lexicon categories, in catalog display order. */
export const CATEGORY_META: Record<
  LexiconCategory,
  { icon: string; label: string }
> = {
  concept: { icon: '💡', label: 'Concept · 개념/기능' },
  role:    { icon: '👤', label: 'Role name' },
};

/**
 * Resolve the display text for a term in a given locale, honoring the
 * binding type's source-of-truth rules:
 *
 *   - owned    → `locales[locale]`
 *   - constant → `snapshot[locale]`  (cache, not SoT)
 *   - i18n     → null  (text lives in workspace i18n files; no reader yet)
 *
 * Returns null when the locale entry is genuinely missing — callers use
 * that to render the missing-flag treatment.
 */
export function termDisplay(term: LexiconTerm, locale: string): string | null {
  if (term.binding.type === 'owned') {
    return term.locales?.[locale] ?? null;
  }
  if (term.binding.type === 'constant') {
    return term.snapshot?.[locale] ?? null;
  }
  return null;
}

/**
 * Set of locales the term is *expected* to cover. For i18n bindings
 * this is `binding.supported_locales`; for owned/constant we infer it
 * from whichever map the binding owns (locales / snapshot).
 *
 * The catalog flags a locale as "missing" when it's in this list but
 * `termDisplay()` returns null for it.
 */
export function termSupportedLocales(term: LexiconTerm): string[] {
  if (term.binding.type === 'i18n') return term.binding.supported_locales;
  if (term.binding.type === 'owned') return Object.keys(term.locales ?? {});
  return Object.keys(term.snapshot ?? {});
}

/**
 * Resolve a related Dok's display name from the workspace catalog.
 * Dok.name is Translatable (string | TermRef): a string is used as-is,
 * a TermRef resolves through the Lexicon (first non-null project locale).
 * Falls back to the raw dok_id when the Dok is absent (a related_doks /
 * actor ref is soft — it can point at a Dok not in this workspace) or the
 * TermRef can't be resolved.
 */
export function resolveDokName(
  dokId: string,
  doks: Dok[],
  lexicon: LexiconTerm[],
  locales: readonly string[],
): string {
  const dok = doks.find((d) => d.dok_id === dokId);
  if (!dok) return dokId;
  const name = dok.name;
  if (typeof name === 'string') return name;
  const term = lexicon.find((t) => t.term_id === name.term_ref);
  if (term) {
    const text = locales.map((l) => termDisplay(term, l)).find((t) => t != null);
    if (text) return text;
  }
  return dokId;
}
