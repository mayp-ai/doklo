// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dok, LexiconFile, RolesFile, Workspace } from '@doklo-beta/core';
import DokCatalogPage from '../app/(hub)/doks/page';
import { StudioProvider } from '../components/studio-store';
import type { DokCatalogData, LoadState } from '../lib/load-state';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const emptyLexiconState: LoadState<LexiconFile> = {
  kind: 'empty',
  path: '/workspace/.doklo/hub/lexicon.json',
  revision: 'lexicon-revision',
  data: { version: 1, terms: [] },
};
const emptyRolesState: LoadState<RolesFile> = {
  kind: 'empty',
  path: '/workspace/.doklo/hub/roles.json',
  revision: 'roles-revision',
  data: { version: 1, roles: [] },
};

function dok(id: string, anchors: string[] = []): Dok {
  return {
    dok_id: id,
    name: `${id} name`,
    status: 'active',
    tags: [],
    surfaces: ['web'],
    description: `${id} description`,
    _meta: {
      version: 1,
      history: [],
      source_anchors: anchors.map((file) => ({ file })),
    },
  } as Dok;
}

function workspaceState(services = ['web', 'api']): LoadState<Workspace> {
  return {
    kind: 'ready',
    path: '/workspace/workspace.json',
    revision: 'workspace-revision',
    data: {
      workspace_id: 'atlas',
      name: 'Atlas workspace',
      default_locale: 'en',
      supported_locales: ['en', 'ko'],
      services: services.map((serviceId) => ({
        service_id: serviceId,
        type: serviceId === 'api' ? 'backend' : 'frontend',
        framework: serviceId === 'api' ? 'express' : 'nextjs',
        code_root: `apps/${serviceId}`,
      })),
    } as Workspace,
  };
}

function doksState(doks: Dok[]): LoadState<DokCatalogData> {
  return {
    kind: doks.length === 0 ? 'empty' : 'ready',
    path: '/workspace/.doklo/hub/doks',
    revision: 'doks-revision',
    data: {
      doks,
      revisions: Object.fromEntries(doks.map((item) => [item.dok_id, `rev-${item.dok_id}`])),
      paths: Object.fromEntries(doks.map((item) => [item.dok_id, `/workspace/.doklo/hub/doks/${item.dok_id}.json`])),
    },
  };
}

function renderPage(input: {
  workspace: LoadState<Workspace>;
  doks: LoadState<DokCatalogData>;
}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
        workspaceState={input.workspace}
        doksState={input.doks}
        lexiconState={emptyLexiconState}
        rolesState={emptyRolesState}
      >
        <DokCatalogPage />
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
describe('real workspace summary', () => {
  it('shows the persisted workspace name, service IDs, Dok count, anchor coverage, and generated state', () => {
    const container = renderPage({
      workspace: workspaceState(),
      doks: doksState([
        dok('AUTH-SIGNIN', ['apps/web/auth.ts']),
        dok('PAY', ['apps/api/pay.ts']),
      ]),
    });

    const summary = container.querySelector<HTMLElement>('[aria-label="Workspace summary"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('Atlas workspace');
    expect(summary?.textContent).toContain('web');
    expect(summary?.textContent).toContain('api');
    expect(summary?.textContent).toContain('2 Doks');
    expect(summary?.textContent).toContain('2 with source anchors');
    expect(summary?.textContent).toContain('generated');
  });

  it('labels persisted mixed anchor coverage as partial', () => {
    const container = renderPage({
      workspace: workspaceState(),
      doks: doksState([
        dok('AUTH-SIGNIN', ['apps/web/auth.ts']),
        dok('PAY'),
      ]),
    });

    const summary = container.querySelector<HTMLElement>('[aria-label="Workspace summary"]');
    expect(summary?.textContent).toContain('1 with source anchors');
    expect(summary?.textContent).toContain('partial');
  });

  it.each([
    {
      label: 'empty workspace',
      workspace: workspaceState([]),
      expected: 'No services configured',
    },
    {
      label: 'missing workspace',
      workspace: { kind: 'missing' as const, path: '/workspace/workspace.json' },
      expected: 'Workspace setup is missing',
    },
  ])('renders an honest setup/empty summary for $label', ({ workspace, expected }) => {
    const container = renderPage({ workspace, doks: doksState([]) });
    const summary = container.querySelector<HTMLElement>('[aria-label="Workspace summary"]');

    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain(expected);
    expect(summary?.textContent).toContain('0 Doks');
    expect(summary?.textContent).toContain('not generated');
  });

  it('never turns persisted generation evidence into a freshness claim', () => {
    const container = renderPage({
      workspace: workspaceState(),
      doks: doksState([dok('AUTH-SIGNIN', ['apps/web/auth.ts'])]),
    });
    const summaryText = container.querySelector<HTMLElement>('[aria-label="Workspace summary"]')?.textContent ?? '';

    expect(summaryText).toContain('generated');
    expect(summaryText).not.toMatch(/fresh|up[ -]?to[ -]?date|current|synced/i);
  });
});
