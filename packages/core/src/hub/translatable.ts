// Translatable resolver — promoted from preserved-branch packages/spoke-user-guide/src/translate.ts.
// Resolves Translatable (string | TermRef) → locale string via lexicon lookup,
// with a fallback chain (active locale → primary locale → first available → placeholder).

import type {
  Actor,
  LexiconFile,
  RolesFile,
  Translatable,
} from '../schemas/index.js';

/**
 * Context for resolving a Translatable. The lexicon is the source of truth for
 * TermRef lookups; primaryLocale is the workspace's default for fallback.
 */
export interface TranslateContext {
  locale: string;
  primaryLocale: string;
  lexicon: LexiconFile;
  /** Required only for `actorLabel`. Optional for plain `translate`. */
  roles?: RolesFile;
}

/**
 * Rich resolution result. The Livedoc engine usually consumes the bare `text`
 * via `resolveTranslatable`, but TranslateCollector benefits from the metadata.
 */
export interface Translation {
  text: string;
  /** Set when the active locale missed and a fallback locale was used. */
  fallbackUsed?: string;
  /** True when TermRef could not be resolved at all — text is the bare term key. */
  unresolved?: boolean;
}

/**
 * Per-render accumulator for translation telemetry.
 * Consumed by LivedocManifest.translation.
 */
export interface TranslateCollector {
  unresolved: Set<string>;
  fallbacks: { field: string; fallback_locale: string }[];
  resolvedCount: number;
  fallbackToPrimaryCount: number;
  fallbackToOtherCount: number;
  /** Field label set transiently by `withField` for context in fallback records. */
  field?: string;
}

export function makeCollector(): TranslateCollector {
  return {
    unresolved: new Set(),
    fallbacks: [],
    resolvedCount: 0,
    fallbackToPrimaryCount: 0,
    fallbackToOtherCount: 0,
  };
}

/**
 * Tag any translate() calls inside `fn` with the given field label.
 * Useful for downstream diagnostics (e.g., "dok.description" missed ko).
 */
export function withField<T>(
  c: TranslateCollector,
  field: string,
  fn: () => T,
): T {
  const prev = c.field;
  c.field = field;
  try {
    return fn();
  } finally {
    c.field = prev;
  }
}

/**
 * Resolve a Translatable to a Translation (text + metadata).
 */
export function translate(
  value: Translatable,
  ctx: TranslateContext,
  collector?: TranslateCollector,
): Translation {
  if (typeof value === 'string') {
    if (collector) collector.resolvedCount += 1;
    return { text: value };
  }
  const termId = value.term_ref;
  const term = ctx.lexicon.terms.find((t) => t.term_id === termId);
  if (!term) {
    if (collector) collector.unresolved.add(termId);
    return { text: `[TERM:${termId}]`, unresolved: true };
  }
  // Owned terms carry `locales`; i18n/constant terms carry only `snapshot`.
  const map = term.locales ?? term.snapshot ?? {};
  if (map[ctx.locale]) {
    if (collector) collector.resolvedCount += 1;
    return { text: map[ctx.locale]! };
  }
  if (ctx.locale !== ctx.primaryLocale && map[ctx.primaryLocale]) {
    if (collector) {
      collector.fallbackToPrimaryCount += 1;
      if (collector.field) {
        collector.fallbacks.push({
          field: collector.field,
          fallback_locale: ctx.primaryLocale,
        });
      }
    }
    return { text: map[ctx.primaryLocale]!, fallbackUsed: ctx.primaryLocale };
  }
  // Last resort: any available locale, else the term key.
  const anyLocale = Object.keys(map)[0];
  if (anyLocale) {
    if (collector) {
      collector.fallbackToOtherCount += 1;
      if (collector.field) {
        collector.fallbacks.push({
          field: collector.field,
          fallback_locale: anyLocale,
        });
      }
    }
    return { text: map[anyLocale]!, fallbackUsed: anyLocale };
  }
  if (collector) collector.unresolved.add(termId);
  return { text: `[TERM:${termId}]`, unresolved: true };
}

/**
 * Shorthand for engine helpers: returns the resolved text only.
 */
export function resolveTranslatable(
  value: Translatable,
  ctx: TranslateContext,
  collector?: TranslateCollector,
): string {
  return translate(value, ctx, collector).text;
}

const SYSTEM_LABEL: Record<string, string> = {
  ko: '시스템',
  en: 'System',
  ja: 'システム',
};

/**
 * Resolve an Actor union to a label string.
 *
 * - `kind: 'system'` → localized "System" / "시스템".
 * - `kind: 'external'` → the external label as-is (already a literal).
 * - `kind: 'role'` → look up role in `ctx.roles` then translate its `name`.
 */
export function actorLabel(
  actor: Actor,
  ctx: TranslateContext,
  collector?: TranslateCollector,
): Translation {
  if (actor.kind === 'system') {
    return { text: SYSTEM_LABEL[ctx.locale] ?? SYSTEM_LABEL.en! };
  }
  if (actor.kind === 'external') {
    return { text: actor.label };
  }
  // kind === 'role'
  if (!ctx.roles) {
    if (collector) collector.unresolved.add(actor.role_ref);
    return { text: actor.role_ref, unresolved: true };
  }
  const role = ctx.roles.roles.find((r) => r.role_id === actor.role_ref);
  if (!role) {
    if (collector) collector.unresolved.add(actor.role_ref);
    return { text: actor.role_ref, unresolved: true };
  }
  return translate(role.name, ctx, collector);
}
