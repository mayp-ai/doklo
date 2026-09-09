// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dok, LexiconFile, LexiconTerm, RolesFile, Workspace } from '@doklo-beta/core';
import DokCatalogPage from '../app/(hub)/doks/page';
import { LexiconCatalog } from '../components/lexicon-catalog';
import { StudioProvider } from '../components/studio-store';
import type { DokCatalogData, LoadState } from '../lib/load-state';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const workspaceState: LoadState<Workspace> = {
  kind: 'ready',
  path: '/workspace/workspace.json',
  revision: 'workspace-revision',
  data: {
    workspace_id: 'atlas',
    name: 'Atlas',
    default_locale: 'en',
    supported_locales: ['en', 'ko'],
    services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' }],
  },
};
const emptyRolesState: LoadState<RolesFile> = {
  kind: 'empty', path: '/workspace/.doklo/hub/roles.json', revision: 'roles', data: { version: 1, roles: [] },
};

function dok(id: string, updatedAt: string): Dok {
  return {
    dok_id: id,
    name: `${id} name`,
    status: 'active',
    tags: [],
    surfaces: ['web'],
    description: `${id} description`,
    _meta: { version: 1, history: [], updated_at: updatedAt, source_anchors: [{ file: `apps/web/${id}.ts` }] },
  } as Dok;
}

const dokItems = [
  dok('AUTH-SIGNIN', '2026-07-01T00:00:00.000Z'),
  dok('CART', '2026-07-16T00:00:00.000Z'),
];
const doksState: LoadState<DokCatalogData> = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/doks',
  revision: 'doks',
  data: {
    doks: dokItems,
    revisions: { 'AUTH-SIGNIN': 'auth', 'CART': 'cart' },
    paths: {
      'AUTH-SIGNIN': '/workspace/.doklo/hub/doks/AUTH-SIGNIN.json',
      'CART': '/workspace/.doklo/hub/doks/CART.json',
    },
  },
};

const terms: LexiconTerm[] = [
  {
    term_id: 'TERM-CONCEPT-CHECKOUT',
    category: 'concept',
    binding: { type: 'owned' },
    locales: { en: 'Checkout', ko: '결제' },
    related_doks: ['CART'],
  },
  {
    term_id: 'TERM-ROLE-ADMIN',
    category: 'role',
    binding: { type: 'owned' },
    locales: { en: 'Administrator', ko: '관리자' },
    related_doks: ['AUTH-SIGNIN'],
  },
];
const lexiconState: LoadState<LexiconFile> = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/lexicon.json',
  revision: 'lexicon',
  data: { version: 1, terms },
};

function render(
  child: React.ReactNode,
  overrideDoksState: LoadState<DokCatalogData> = doksState,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <StudioProvider
        layerCounts={{
          doks:
            overrideDoksState.kind === 'ready' || overrideDoksState.kind === 'empty'
              ? overrideDoksState.data.doks.length
              : 0,
          lexicon: 2,
          ia: 0,
          roles: 0,
        }}
        workspaceState={workspaceState}
        doksState={overrideDoksState}
        lexiconState={lexiconState}
        rolesState={emptyRolesState}
      >
        {child}
      </StudioProvider>,
    );
  });
  return container;
}

beforeEach(() => document.body.replaceChildren());
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('honest controls and routes', () => {
  it('contains no singular /dok/ production link and removes dead catalog controls', async () => {
    const sourceFiles = [
      'components/lexicon-suggestions.tsx',
      'app/(hub)/doks/page.tsx',
      'components/lexicon-catalog.tsx',
    ];
    const sources = await Promise.all(
      sourceFiles.map((path) => readFile(resolve(process.cwd(), path), 'utf-8')),
    );
    const source = sources.join('\n');

    expect(source).not.toContain('/dok/');
    expect(source).not.toContain('+ filters');
    expect(source).not.toContain('compare locales');
  });

  // The toggle cycles Priority -> ID -> Recent. Priority is the default now,
  // and these fixtures carry no priority, so they tie and fall through to the
  // dok_id tiebreak — which is why the first two states show the same order.
  it('cycles the visible Dok sort through priority, ID and recent order', () => {
    const container = render(<DokCatalogPage />);
    const ids = () => [...container.querySelectorAll<HTMLElement>('[data-row-id]')].map((row) => row.dataset.rowId);
    expect(ids()).toEqual(['AUTH-SIGNIN', 'CART']);

    const sort = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Sort · Priority'),
    );
    expect(sort).not.toBeUndefined();

    act(() => sort?.click());
    expect(sort?.textContent).toContain('Sort · ID');
    expect(ids()).toEqual(['AUTH-SIGNIN', 'CART']);

    act(() => sort?.click());
    expect(sort?.textContent).toContain('Sort · Recent');
    expect(ids()).toEqual(['CART', 'AUTH-SIGNIN']);

    act(() => sort?.click());
    expect(sort?.textContent).toContain('Sort · Priority');
  });

  it('keeps bulk-review selection separate from Dok preview navigation', () => {
    const reviewDoks = [
      { ...dok('AUTH-SIGNIN', '2026-07-01T00:00:00.000Z'), status: 'draft' as const },
      { ...dok('PAY', '2026-07-02T00:00:00.000Z'), status: 'draft' as const },
      dok('PROFILE', '2026-07-03T00:00:00.000Z'),
    ];
    const reviewState: LoadState<DokCatalogData> = {
      kind: 'ready',
      path: '/workspace/.doklo/hub/doks',
      revision: 'review-catalog',
      data: {
        doks: reviewDoks,
        revisions: {
          'AUTH-SIGNIN': 'a'.repeat(64),
          PAY: 'b'.repeat(64),
          PROFILE: 'c'.repeat(64),
        },
        paths: Object.fromEntries(
          reviewDoks.map((item) => [
            item.dok_id,
            `/workspace/.doklo/hub/doks/${item.dok_id}.json`,
          ]),
        ),
      },
    };
    const container = render(<DokCatalogPage />, reviewState);
    const visibleRowIds = () => [
      ...container.querySelectorAll<HTMLElement>('[data-row-id]'),
    ].map((row) => row.dataset.rowId);
    expect(visibleRowIds()).toEqual(['AUTH-SIGNIN', 'PAY', 'PROFILE']);
    const review = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Review Doks',
    );
    expect(review).not.toBeUndefined();
    act(() => review?.click());

    expect(visibleRowIds()).toEqual(['AUTH-SIGNIN', 'PAY']);
    const checks = [...container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][aria-label$="for review"]',
    )];
    expect(checks.map((input) => input.getAttribute('aria-label'))).toEqual([
      'Select AUTH-SIGNIN for review',
      'Select PAY for review',
    ]);
    const authRow = container.querySelector<HTMLElement>('[data-row-id="AUTH-SIGNIN"]');
    const payRow = container.querySelector<HTMLElement>('[data-row-id="PAY"]');
    expect(authRow?.getAttribute('aria-current')).toBe('true');

    act(() => checks[1]?.click());
    expect(checks[1]?.checked).toBe(true);
    expect(authRow?.getAttribute('aria-current')).toBe('true');
    expect(payRow?.getAttribute('aria-current')).toBeNull();

    act(() => payRow?.click());
    expect(payRow?.getAttribute('aria-current')).toBe('true');
    expect(authRow?.getAttribute('aria-current')).toBeNull();

    const draftFilter = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Draft'),
    );
    expect(draftFilter?.getAttribute('aria-pressed')).toBe('true');
    act(() => draftFilter?.click());
    expect(container.querySelectorAll(
      'input[type="checkbox"][aria-label$="for review"]',
    )).toHaveLength(0);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .some((button) => button.textContent?.trim() === 'Cancel review'),
    ).toBe(false);
    const reviewAgain = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Review Doks');
    act(() => reviewAgain?.click());
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Select PAY for review"]',
      )?.checked,
    ).toBe(false);
    expect(container.querySelector('button input, button button')).toBeNull();
  });

  it('restores the pre-review filter when review mode is canceled', () => {
    const reviewDoks = [
      { ...dok('ADMIN-BANNER', '2026-07-01T00:00:00.000Z'), status: 'draft' as const },
      dok('ADMIN-DATA', '2026-07-02T00:00:00.000Z'),
      dok('AUTH-SIGNIN', '2026-07-03T00:00:00.000Z'),
    ];
    const reviewState: LoadState<DokCatalogData> = {
      kind: 'ready',
      path: '/workspace/.doklo/hub/doks',
      revision: 'review-catalog',
      data: {
        doks: reviewDoks,
        revisions: {
          'ADMIN-BANNER': 'a'.repeat(64),
          'ADMIN-DATA': 'b'.repeat(64),
          'AUTH-SIGNIN': 'c'.repeat(64),
        },
        paths: Object.fromEntries(
          reviewDoks.map((item) => [
            item.dok_id,
            `/workspace/.doklo/hub/doks/${item.dok_id}.json`,
          ]),
        ),
      },
    };
    const container = render(<DokCatalogPage />, reviewState);
    const rowIds = () => [
      ...container.querySelectorAll<HTMLElement>('[data-row-id]'),
    ].map((row) => row.dataset.rowId);
    const activeFilter = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Active'));
    act(() => activeFilter?.click());
    expect(rowIds()).toEqual(['ADMIN-DATA', 'AUTH-SIGNIN']);

    const review = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Review Doks');
    act(() => review?.click());
    expect(rowIds()).toEqual(['ADMIN-BANNER']);
    expect(container.querySelector('main')?.textContent).not.toContain('AUTH-SIGNIN');
    const adminSection = container
      .querySelector('[data-row-id="ADMIN-BANNER"]')
      ?.closest('section');
    expect(adminSection?.textContent).not.toContain('1 doks');

    const cancel = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Cancel review');
    act(() => cancel?.click());
    expect(rowIds()).toEqual(['ADMIN-DATA', 'AUTH-SIGNIN']);
    expect(activeFilter?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not expose review mode when the workspace has no Draft Doks', () => {
    const container = render(<DokCatalogPage />);
    const review = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Review Doks',
    );
    expect(review).toBeUndefined();
  });

  it('filters rendered Lexicon terms by ID and persisted locale text', () => {
    const container = render(<LexiconCatalog />);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    const visibleRows = () =>
      [...container.querySelectorAll<HTMLElement>('tbody [data-row-id]')]
        .map((row) => row.dataset.rowId);
    expect(search).not.toBeNull();

    const enterSearch = (value: string) => act(() => {
      if (!search) return;
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(search),
        'value',
      )?.set;
      setter?.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
    });
    enterSearch('admin');
    expect(visibleRows()).toEqual(['TERM-ROLE-ADMIN']);

    enterSearch('결제');
    expect(visibleRows()).toEqual(['TERM-CONCEPT-CHECKOUT']);
  });
});
