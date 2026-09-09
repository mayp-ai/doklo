import { describe, expect, it } from 'vitest';
import { makeCollector, type LexiconFile, type RolesFile, type Workspace } from '@doklo-beta/core';
import { createEngine } from '../../src/handlebars-setup.js';
import type { ServiceAwareHelperRoot } from '../../src/helpers/index.js';

const lexicon: LexiconFile = {
  version: 1,
  terms: [
    {
      term_id: 'TERM-ADMIN',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'Admin', ko: '관리자' },
      related_doks: [],
    },
  ],
};
const roles: RolesFile = {
  version: 1,
  roles: [
    { role_id: 'ROLE-ADMIN', name: { term_ref: 'TERM-ADMIN' }, extends: [], scope: 'global' },
    { role_id: 'ROLE-OWNER', name: 'Owner', extends: [], scope: 'global' },
  ],
};
const workspace: Workspace = {
  workspace_id: 't',
  name: 'T',
  services: [
    { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
  ],
  default_locale: 'en',
  supported_locales: ['en', 'ko'],
};

function root(overrides: Partial<ServiceAwareHelperRoot> = {}): ServiceAwareHelperRoot {
  return {
    __locale: 'ko',
    __primaryLocale: 'en',
    __lexicon: lexicon,
    __roles: roles,
    __workspace: workspace,
    __collector: makeCollector(),
    ...overrides,
  };
}

function render(tpl: string, r: ServiceAwareHelperRoot, ctx: unknown = {}): string {
  const hb = createEngine();
  return hb.compile(tpl)(ctx, { data: { root: r } });
}

describe('actor_label helper', () => {
  it('returns localized system label', () => {
    expect(render('{{actor_label a}}', root(), { a: { kind: 'system' } })).toBe('시스템');
  });

  it('returns external label as-is', () => {
    expect(
      render('{{actor_label a}}', root(), { a: { kind: 'external', label: 'Stripe' } }),
    ).toBe('Stripe');
  });

  it('resolves role with TermRef name', () => {
    expect(
      render('{{actor_label a}}', root(), { a: { kind: 'role', role_ref: 'ROLE-ADMIN' } }),
    ).toBe('관리자');
  });

  it('resolves role with plain string name', () => {
    expect(
      render('{{actor_label a}}', root(), { a: { kind: 'role', role_ref: 'ROLE-OWNER' } }),
    ).toBe('Owner');
  });

  it('returns empty string for missing actor', () => {
    expect(render('{{actor_label a}}', root(), {})).toBe('');
  });
});

describe('role_label helper', () => {
  it('looks up role by id and translates', () => {
    expect(render('{{role_label "ROLE-ADMIN"}}', root())).toBe('관리자');
  });

  it('returns id + records to collector when role missing', () => {
    const r = root();
    expect(render('{{role_label "ROLE-NONE"}}', r)).toBe('ROLE-NONE');
    expect(r.__collector?.unresolved.has('ROLE-NONE')).toBe(true);
  });
});

describe('service_label helper', () => {
  it('returns id with type when service known', () => {
    expect(render('{{service_label "web"}}', root())).toBe('web (frontend)');
  });

  it('returns id when service unknown', () => {
    expect(render('{{service_label "admin"}}', root())).toBe('admin');
  });
});

describe('surface_label helper', () => {
  it('returns ref unchanged (v1 stub)', () => {
    expect(render('{{surface_label "onboarding/payment"}}', root())).toBe('onboarding/payment');
  });
});

describe('markdown helper', () => {
  it('renders inline markdown to HTML', () => {
    const out = render('{{{markdown s}}}', root(), { s: '**bold**' });
    expect(out).toContain('<strong>bold</strong>');
  });

  it('returns empty for empty input', () => {
    expect(render('{{markdown s}}', root(), { s: '' })).toBe('');
  });
});
