// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IA_DEPTH_MAX,
  StudioProvider,
  useStudio,
  type IaFilter,
} from '../components/studio-store';
import { IaOverview } from '../components/ia-overview';
import type { StudioIaNode, StudioIaTree } from '../lib/ia-route';
import { deepUnmappedTree, routeHierarchyTree } from './helpers/ia-fixture';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function node(index: number): StudioIaNode {
  return {
    key: `web::wide/child-${index}`,
    path: `/child-${index}`,
    seg: `child-${index}`,
    title: `Child ${index}`,
    platform: 'both',
    tags: [],
    unmapped: true,
    children: [],
  };
}

function wideTree(): StudioIaTree {
  return {
    key: 'web::wide',
    serviceId: 'web',
    treeId: 'wide',
    type: 'sitemap',
    source: 'manual',
    platform: 'both',
    nodes: [{
      key: 'web::wide/root',
      path: '/',
      seg: '',
      title: 'Root',
      platform: 'both',
      tags: [],
      unmapped: true,
      children: Array.from({ length: 9 }, (_, index) => node(index + 1)),
    }],
  };
}

function SelectAllDepth() {
  const { setIaDepth } = useStudio();
  useEffect(() => setIaDepth(IA_DEPTH_MAX), [setIaDepth]);
  return null;
}

function ApplyIaControls({
  depth,
  filter,
}: {
  depth: number;
  filter: IaFilter;
}) {
  const { setIaDepth, setRouteFilter } = useStudio();
  useEffect(() => {
    setIaDepth(depth);
    setRouteFilter(filter);
  }, [depth, filter, setIaDepth, setRouteFilter]);
  return null;
}

async function mountOverview(
  tree: StudioIaTree,
  controls: { depth: number; filter: IaFilter },
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  await act(async () => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
        initialIaTrees={[tree]}
      >
        <ApplyIaControls depth={controls.depth} filter={controls.filter} />
        <IaOverview />
      </StudioProvider>,
    );
  });
  return container;
}

function depthHints(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="overview-depth-hint"]')]
    .map((element) => element.textContent ?? '');
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('IA Overview all-depth rendering', () => {
  it('renders the ninth listing instead of applying the finite preview cap', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <StudioProvider
          layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
          initialIaTrees={[wideTree()]}
        >
          <SelectAllDepth />
          <IaOverview />
        </StudioProvider>,
      );
    });

    expect(container.textContent).toContain('Child 9');
    expect(container.textContent).not.toContain('+1 more, increase depth');
    expect(
      container.querySelector('[data-testid="ia-overview-directory"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="overview-branch"]'),
    ).toHaveLength(1);
    expect(container.querySelector('[data-testid="react-flow"]')).toBeNull();
    expect(
      [...container.querySelectorAll('[data-overview-depth]')]
        .map((element) => element.getAttribute('data-overview-depth')),
    ).toContain('2');
  });

  it('renders a v2 route hierarchy with its bindings in the same directory', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <StudioProvider
          layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
          initialIaTrees={[routeHierarchyTree()]}
        >
          <SelectAllDepth />
          <IaOverview />
        </StudioProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="ia-overview-directory"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('AUTH-SIGNIN');
    expect(container.textContent).toContain('Unmapped');
    expect(container.textContent).toContain('Section');
  });

  it('renders explicit empty paths in card headers and listings', async () => {
    const tree = wideTree();
    const emptyPathTree: StudioIaTree = {
      ...tree,
      nodes: [{
        ...tree.nodes[0]!,
        path: '',
        title: 'Empty path root',
        children: [{
          ...tree.nodes[0]!.children[0]!,
          path: '',
          title: 'Empty path child',
        }],
      }],
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <StudioProvider
          layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
          initialIaTrees={[emptyPathTree]}
        >
          <IaOverview />
        </StudioProvider>,
      );
    });

    const emptyPathLabels = container.querySelectorAll(
      '[aria-label="Empty path"]',
    );
    expect(emptyPathLabels).toHaveLength(2);
    expect(
      [...emptyPathLabels].map((element) => element.textContent),
    ).toEqual(['""', '""']);
  });
});

describe('IA Overview matches hidden by the depth cutoff', () => {
  const noVisibleDescendants =
    'This section has no visible descendants at the current depth.';

  it('tells the reader how many filter matches the depth cuts off', async () => {
    const container = await mountOverview(deepUnmappedTree(), {
      depth: 3,
      filter: 'unmapped',
    });

    expect(depthHints(container)).toEqual(['3 matches below current depth']);
    expect(container.textContent).not.toContain(noVisibleDescendants);
  });

  it('makes the empty branch sentence filter-aware, not depth-only', async () => {
    const container = await mountOverview(deepUnmappedTree(), {
      depth: 1,
      filter: 'unmapped',
    });

    expect(depthHints(container)).toEqual([
      '3 matches are below the current depth. Raise depth to see them.',
    ]);
    expect(container.textContent).not.toContain(noVisibleDescendants);
  });

  it('drops the hint once the depth reaches the matching nodes', async () => {
    const container = await mountOverview(deepUnmappedTree(), {
      depth: 5,
      filter: 'unmapped',
    });

    expect(depthHints(container)).toEqual([]);
    expect(container.textContent).toContain('analysis');
    expect(container.textContent).toContain('milestone');
  });

  it('leaves the unfiltered branch copy exactly as it was', async () => {
    const container = await mountOverview(deepUnmappedTree(), {
      depth: 3,
      filter: 'all',
    });

    expect(depthHints(container)).toEqual([]);
    expect(container.textContent).toContain(noVisibleDescendants);
    expect(container.textContent).not.toContain('below current depth');
  });
});
