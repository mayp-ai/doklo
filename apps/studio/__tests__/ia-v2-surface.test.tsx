// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioProvider, useStudio } from '../components/studio-store';
import { IaTree } from '../components/ia-tree';
import { IaTreePicker } from '../components/ia-tree-picker';
import { RoutePreview } from '../components/route-preview';
import IaPage from '../app/(hub)/ia/page';
import type { StudioIaTree } from '../lib/ia-route';
import {
  hierarchicalTree,
  manualNavigationTree,
  routeHierarchyTree,
  treeFixture,
} from './helpers/ia-fixture';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function SelectNode({ nodeKey }: { nodeKey: string }) {
  const { setSelectedIaNodeKey } = useStudio();
  useEffect(
    () => setSelectedIaNodeKey(nodeKey),
    [nodeKey, setSelectedIaNodeKey],
  );
  return null;
}

function TreeKeyProbe() {
  const { selectedIaTreeKey } = useStudio();
  return <p data-testid="selected-tree">{selectedIaTreeKey ?? ''}</p>;
}

async function mount(
  trees: StudioIaTree[],
  children: React.ReactNode,
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
        initialIaTrees={trees}
      >
        {children}
      </StudioProvider>,
    );
  });
  return container;
}

async function preview(
  tree: StudioIaTree,
  nodeKey: string,
): Promise<HTMLElement> {
  return mount([tree], (
    <>
      <SelectNode nodeKey={nodeKey} />
      <RoutePreview />
    </>
  ));
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('IA Overview view', () => {
  it('labels the default view Overview and renders the overview directory', async () => {
    const container = await mount([routeHierarchyTree()], <IaPage />);
    const tabs = [...container.querySelectorAll('[role="tab"]')].map(
      (tab) => tab.textContent,
    );

    expect(tabs).toEqual(['Overview', 'Tree']);
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
    ).toBe('Overview');
    expect(
      container.querySelector('[data-testid="ia-overview-directory"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="overview-branch"]').length,
    ).toBeGreaterThan(0);
    expect(container.textContent).toContain('Overview · Route hierarchy');
    expect(container.textContent).not.toContain('Sitemap');
  });

  it('describes a route hierarchy as URL structure without claiming navigation', async () => {
    const container = await mount([routeHierarchyTree()], <IaPage />);
    const description = container.querySelector('header p')?.textContent ?? '';

    expect(description).toContain('URL');
    expect(description.toLowerCase()).not.toContain('menu');
  });

  it('keeps a legacy v1 sitemap tree renderable under the Overview view', async () => {
    const container = await mount([hierarchicalTree()], <IaPage />);

    expect(container.textContent).toContain('Sitemap · Route hierarchy');
    expect(
      container.querySelector('[data-testid="ia-overview-directory"]'),
    ).not.toBeNull();
  });
});

describe('IA structure picker evidence class', () => {
  it('names the evidence class of every v2 structure', async () => {
    const container = await mount(
      [
        routeHierarchyTree(),
        manualNavigationTree(),
        treeFixture({
          key: 'web::areas',
          type: 'organization',
          source: 'manual',
        }),
      ],
      <IaTreePicker />,
    );
    const options = [...container.querySelectorAll('option')].map(
      (option) => option.textContent,
    );

    expect(options).toEqual([
      'web · web-routes · Route hierarchy · Code-derived',
      'web · web-nav · Navigation · Curated',
      'web · areas · Product organization · Curated',
    ]);
  });

  it('keeps the raw type and source wording for legacy v1 structures', async () => {
    const container = await mount(
      [
        hierarchicalTree(),
        treeFixture({
          key: 'web::features',
          type: 'feature_group',
          source: 'manual',
        }),
        treeFixture({
          key: 'web::legacy-nav',
          type: 'navigation',
          source: 'auto+manual',
        }),
      ],
      <IaTreePicker />,
    );
    // Selectable options only — this catalog has no organization tree, so the
    // picker also lists that absent type as an unavailable entry (covered by
    // the absent-curated-types suite below).
    const options = [
      ...container.querySelectorAll('option:not([disabled])'),
    ].map((option) => option.textContent);

    expect(options).toEqual([
      'web · web-sitemap · sitemap · auto',
      'web · features · feature_group · manual',
      'web · legacy-nav · navigation · auto+manual',
    ]);
  });
});

describe('IA structure picker absent curated types', () => {
  it('offers every absent curated structure type as an unavailable option', async () => {
    const container = await mount([routeHierarchyTree()], <IaTreePicker />);
    const options = [...container.querySelectorAll('option')];

    expect(options.map((option) => option.textContent)).toEqual([
      'web · web-routes · Route hierarchy · Code-derived',
      'Product organization · Curated — none yet',
      'Navigation · Curated — none yet',
    ]);
    expect(options.map((option) => option.disabled)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('drops the entry for a curated type the catalog already has', async () => {
    const container = await mount(
      [routeHierarchyTree(), manualNavigationTree()],
      <IaTreePicker />,
    );
    const options = [...container.querySelectorAll('option')];

    expect(options.map((option) => option.textContent)).toEqual([
      'web · web-routes · Route hierarchy · Code-derived',
      'web · web-nav · Navigation · Curated',
      'Product organization · Curated — none yet',
    ]);
    expect(options.map((option) => option.disabled)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('still selects a real structure with the unavailable entries present', async () => {
    const container = await mount(
      [routeHierarchyTree(), manualNavigationTree()],
      <>
        <IaTreePicker />
        <TreeKeyProbe />
      </>,
    );
    const select = container.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Expected the structure selector.');
    const probe = () =>
      container.querySelector('[data-testid="selected-tree"]')?.textContent;

    expect(probe()).toBe('web::web-routes');
    await act(async () => {
      select.value = 'web::web-nav';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(probe()).toBe('web::web-nav');
    // The unavailable entries never carry a key the store could resolve.
    const treeKeys = ['web::web-routes', 'web::web-nav'];
    const disabledValues = [...container.querySelectorAll('option')]
      .filter((option) => option.disabled)
      .map((option) => option.value);
    expect(disabledValues).toHaveLength(1);
    expect(
      disabledValues.some((value) => treeKeys.includes(value)),
    ).toBe(false);
  });
});

describe('IA tree view with v2 data', () => {
  it('shows the bound Dok of a v2 destination instead of a child count', async () => {
    const container = await mount([routeHierarchyTree()], <IaTree />);
    const rows = [...container.querySelectorAll('[role="treeitem"]')];
    const programs = rows.find((row) =>
      row.textContent?.includes('Programs'),
    );

    expect(programs?.textContent).toContain('PROG');
    expect(programs?.textContent).not.toContain('0 nodes');
  });
});

describe('IA route preview — v2 facts', () => {
  it('shows each binding with its provenance badge and the route evidence file', async () => {
    const tree = routeHierarchyTree();
    const signin = tree.nodes[0]!.children[0]!;
    const container = await preview(tree, signin.key);
    const badges = [...container.querySelectorAll('[data-binding-source]')];

    expect(container.textContent).toContain('AUTH-SIGNIN');
    expect(badges.map((badge) => badge.getAttribute('data-binding-source')))
      .toEqual(['auto']);
    expect(badges.map((badge) => badge.textContent)).toEqual(['Auto']);
    expect(container.textContent).toContain('app/auth/signin/page.tsx');
    expect(container.textContent).toContain('All fields auto');
    expect(container.textContent).toContain('Route hierarchy');
  });

  it('separates a code-derived structure from its manual bindings', async () => {
    const tree = routeHierarchyTree();
    const reset = tree.nodes[0]!.children[1]!;
    const container = await preview(tree, reset.key);
    const badges = [...container.querySelectorAll('[data-binding-source]')];

    expect(badges.map((badge) => badge.textContent)).toEqual(['Manual']);
    expect(container.textContent).toContain('AUTH-RESET');
    expect(container.textContent).toContain('Curated: label');
    expect(container.textContent).toContain(
      'Code-derived structure · 1 manual binding',
    );
  });

  it('reports a curated placement as unbound without inventing evidence', async () => {
    const tree = manualNavigationTree();
    const placement = tree.nodes[0]!.children[0]!;
    const container = await preview(tree, placement.key);

    expect(container.querySelectorAll('[data-binding-source]')).toHaveLength(0);
    expect(container.textContent).toContain('No bound Dok');
    expect(container.textContent).not.toContain('Code evidence');
    expect(container.textContent).toContain('Navigation');
    expect(container.textContent).toContain('Manual');
  });

  it('leaves a v1 node rendering exactly as before', async () => {
    const tree = hierarchicalTree();
    const programs = tree.nodes[1]!;
    const container = await preview(tree, programs.key);

    expect(container.textContent).toContain('Linked Dok');
    expect(container.textContent).toContain('PROG');
    expect(container.textContent).toContain('Automatic');
    expect(container.querySelectorAll('[data-binding-source]')).toHaveLength(0);
    expect(container.textContent).not.toContain('Curated');
    expect(container.textContent).not.toContain('All fields auto');
  });
});
