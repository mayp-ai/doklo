import { describe, expect, it } from 'vitest';
import type { LexiconFile, RolesFile } from '../../src/schemas/index.js';
import {
  actorLabel,
  makeCollector,
  resolveTranslatable,
  translate,
  withField,
} from '../../src/hub/translatable.js';

const lexicon: LexiconFile = {
  version: 1,
  terms: [
    {
      term_id: 'TERM-USER',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'User', ko: '사용자' },
      related_doks: [],
    },
    {
      term_id: 'TERM-EN-ONLY',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'English only' },
      related_doks: [],
    },
  ],
};

const ctx = { locale: 'ko', primaryLocale: 'en', lexicon };

describe('translate / resolveTranslatable', () => {
  it('passes plain string through', () => {
    expect(resolveTranslatable('Hello', ctx)).toBe('Hello');
  });

  it('resolves TermRef in active locale', () => {
    expect(resolveTranslatable({ term_ref: 'TERM-USER' }, ctx)).toBe('사용자');
  });

  it('falls back to primary locale when active missing', () => {
    expect(resolveTranslatable({ term_ref: 'TERM-EN-ONLY' }, ctx)).toBe('English only');
  });

  it('returns [TERM:???] placeholder when TermRef unresolved', () => {
    const c = makeCollector();
    const result = translate({ term_ref: 'TERM-MISSING' }, ctx, c);
    expect(result.unresolved).toBe(true);
    expect(result.text).toBe('[TERM:TERM-MISSING]');
    expect(c.unresolved.has('TERM-MISSING')).toBe(true);
  });

  it('collector counts resolved + fallback paths', () => {
    const c = makeCollector();
    resolveTranslatable('inline', ctx, c);
    resolveTranslatable({ term_ref: 'TERM-USER' }, ctx, c);
    resolveTranslatable({ term_ref: 'TERM-EN-ONLY' }, ctx, c);
    expect(c.resolvedCount).toBe(2);
    expect(c.fallbackToPrimaryCount).toBe(1);
  });

  it('withField tags fallback records', () => {
    const c = makeCollector();
    withField(c, 'dok.description', () => {
      resolveTranslatable({ term_ref: 'TERM-EN-ONLY' }, ctx, c);
    });
    expect(c.fallbacks).toEqual([{ field: 'dok.description', fallback_locale: 'en' }]);
  });
});

const roles: RolesFile = {
  version: 1,
  roles: [
    {
      role_id: 'ROLE-ADMIN',
      name: { term_ref: 'TERM-USER' },
      extends: [],
      scope: 'global',
    },
    {
      role_id: 'ROLE-PLAIN',
      name: 'Plain Owner',
      extends: [],
      scope: 'global',
    },
  ],
};

describe('actorLabel', () => {
  it('returns localized system label', () => {
    expect(actorLabel({ kind: 'system' }, ctx).text).toBe('시스템');
  });

  it('returns external label as-is', () => {
    expect(actorLabel({ kind: 'external', label: 'Stripe' }, ctx).text).toBe('Stripe');
  });

  it('resolves role with TermRef name', () => {
    expect(actorLabel({ kind: 'role', role_ref: 'ROLE-ADMIN' }, { ...ctx, roles }).text).toBe(
      '사용자',
    );
  });

  it('resolves role with plain string name', () => {
    expect(actorLabel({ kind: 'role', role_ref: 'ROLE-PLAIN' }, { ...ctx, roles }).text).toBe(
      'Plain Owner',
    );
  });

  it('marks unresolved when role missing', () => {
    const c = makeCollector();
    const result = actorLabel(
      { kind: 'role', role_ref: 'ROLE-NONE' },
      { ...ctx, roles },
      c,
    );
    expect(result.unresolved).toBe(true);
    expect(c.unresolved.has('ROLE-NONE')).toBe(true);
  });
});
