// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Dok,
  LexiconFile,
  Role,
  RolesFile,
  Workspace,
} from '@doklo-beta/core';
import { StudioProvider } from '../components/studio-store';
import { LoadRecovery } from '../components/load-recovery';
import type { DokCatalogData, LoadState } from '../lib/load-state';
import type { StudioIaDocument } from '../lib/ia-adapter';
import DokEditorPage from '../app/(editor)/doks/[id]/page';
import LexiconEditorPage from '../app/(editor)/lexicon/[id]/page';
import RoleEditorPage from '../app/(editor)/roles/[id]/page';
import RootLayout, { RootLoadBoundary } from '../app/layout';

const navigation = vi.hoisted(() => ({ id: 'MISSING' }));
const rootLoaders = vi.hoisted(() => ({
  loadAllIa: vi.fn(),
  loadDoksState: vi.fn(),
  loadLexiconState: vi.fn(),
  loadRolesState: vi.fn(),
  loadWorkspaceState: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: navigation.id }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../lib/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/data')>()),
  ...rootLoaders,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const workspaceState: LoadState<Workspace> = {
  kind: 'ready',
  path: '/workspace/workspace.json',
  revision: 'workspace-revision',
  data: {
    workspace_id: 'test-workspace',
    name: 'Workspace',
    default_locale: 'en',
    supported_locales: ['en', 'ko'],
    services: [],
  } as Workspace,
};

const emptyDoksState: LoadState<DokCatalogData> = {
  kind: 'empty',
  path: '/workspace/.doklo/hub/doks',
  revision: 'doks-revision',
  data: { doks: [], revisions: {}, paths: {} },
};

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

const roots: Root[] = [];

function renderWithStates(
  child: ReactNode,
  states: {
    workspaceState?: LoadState<Workspace>;
    doksState?: LoadState<DokCatalogData>;
    lexiconState?: LoadState<LexiconFile>;
    rolesState?: LoadState<RolesFile>;
  },
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
        workspaceState={states.workspaceState ?? workspaceState}
        doksState={states.doksState ?? emptyDoksState}
        lexiconState={states.lexiconState ?? emptyLexiconState}
        rolesState={states.rolesState ?? emptyRolesState}
      >
        {child}
      </StudioProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  document.body.replaceChildren();
  rootLoaders.loadAllIa.mockReset();
  rootLoaders.loadDoksState.mockReset();
  rootLoaders.loadLexiconState.mockReset();
  rootLoaders.loadRolesState.mockReset();
  rootLoaders.loadWorkspaceState.mockReset();
  rootLoaders.loadAllIa.mockResolvedValue({});
  rootLoaders.loadDoksState.mockResolvedValue(emptyDoksState);
  rootLoaders.loadLexiconState.mockResolvedValue(emptyLexiconState);
  rootLoaders.loadRolesState.mockResolvedValue(emptyRolesState);
  rootLoaders.loadWorkspaceState.mockResolvedValue(workspaceState);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('lossless load recovery', () => {
  it('renders an IA read failure with the exact service path and recovery guidance', () => {
    const path = '/workspace/.doklo/hub/services/web/ia.json';
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <LoadRecovery
          layer="ia"
          state={{
            kind: 'unreadable',
            path,
            message: 'EACCES: permission denied',
          }}
        />,
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('ia could not be loaded');
    expect(alert?.textContent).toContain('EACCES: permission denied');
    expect(alert?.textContent).toContain(path);
    expect(alert?.textContent).toContain('No files were changed.');
  });

  it('blocks RootLayout page content when a service IA file is invalid', () => {
    const path = '/workspace/.doklo/hub/services/web/ia.json';
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <RootLoadBoundary
          workspaceState={workspaceState}
          iaState={{
            kind: 'invalid',
            path,
            message: 'trees.0.nodes: Invalid input',
          }}
        >
          <main data-testid="page-content">IA page</main>
        </RootLoadBoundary>,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      path,
    );
    expect(container.querySelector('[data-testid="page-content"]')).toBeNull();
  });

  it('allows RootLayout page content when a service IA file is missing', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <RootLoadBoundary
          workspaceState={workspaceState}
          iaState={{
            kind: 'missing',
            path: '/workspace/.doklo/hub/services/web/ia.json',
          }}
        >
          <main data-testid="page-content">IA page</main>
        </RootLoadBoundary>,
      );
    });

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="page-content"]'),
    ).not.toBeNull();
  });

  it('renders the exact invalid Dok path as a live alert instead of not-found or an editor', () => {
    navigation.id = 'AUTH-SIGNIN';
    const path = '/workspace/.doklo/hub/doks/AUTH-SIGNIN.json';
    const container = renderWithStates(<DokEditorPage />, {
      doksState: {
        kind: 'invalid',
        path,
        message: 'dok_id: Invalid input',
      },
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.textContent).toContain('doks could not be loaded');
    expect(alert?.textContent).toContain('dok_id: Invalid input');
    expect(alert?.textContent).toContain(path);
    expect(alert?.textContent).toContain('No files were changed.');
    expect(alert?.textContent).toContain('Fix the file, then reload Studio.');
    expect(alert?.textContent).not.toContain('Not found');
    expect(alert?.querySelector('input, textarea, select')).toBeNull();
  });

  it.each([
    {
      label: 'lexicon',
      page: <LexiconEditorPage />,
      states: {
        lexiconState: {
          kind: 'unreadable' as const,
          path: '/workspace/.doklo/hub/lexicon.json',
          message: 'EACCES: permission denied',
        },
      },
    },
    {
      label: 'roles',
      page: <RoleEditorPage />,
      states: {
        rolesState: {
          kind: 'invalid' as const,
          path: '/workspace/.doklo/hub/roles.json',
          message: 'roles.0.kind: Invalid option',
        },
      },
    },
  ])('never presents an invalid/unreadable $label layer as not found', ({ label, page, states }) => {
    navigation.id = label === 'roles' ? 'ROLE-ADMIN' : 'TERM-NAV-HOME';
    const container = renderWithStates(page, states);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent ?? '').toContain(
      `${label} could not be loaded`,
    );
    expect(container.textContent).not.toContain('Not found');
    expect(container.querySelector('input, textarea, select')).toBeNull();
  });

  it('routes an invalid service IA loader state through RootLayout recovery', async () => {
    const path = '/workspace/.doklo/hub/services/web/ia.json';
    const serviceWorkspaceState: LoadState<Workspace> = {
      ...workspaceState,
      data: {
        ...workspaceState.data,
        services: [{
          service_id: 'web',
          type: 'frontend',
          framework: 'nextjs',
          code_root: 'apps/web',
        }],
      },
    };
    const iaState: LoadState<StudioIaDocument> = {
      kind: 'invalid',
      path,
      message: 'Expected service_id web, received api.',
    };
    const PageContent = vi.fn(() => (
      <main data-testid="page-content">IA page</main>
    ));
    rootLoaders.loadWorkspaceState.mockResolvedValue(serviceWorkspaceState);
    rootLoaders.loadAllIa.mockResolvedValue({ web: iaState });

    const markup = renderToStaticMarkup(
      await RootLayout({ children: <PageContent /> }),
    );

    expect(rootLoaders.loadAllIa).toHaveBeenCalledWith(['web']);
    expect(markup).toContain('ia could not be loaded');
    expect(markup).toContain(path);
    expect(markup).not.toContain('IA page');
    expect(PageContent).not.toHaveBeenCalled();
  });
});
