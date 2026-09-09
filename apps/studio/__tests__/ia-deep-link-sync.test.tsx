// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioProvider, useStudio } from '../components/studio-store';
import { useRouteDeepLink } from '../lib/hooks/use-deep-link-sync';
import type { StudioIaTree } from '../lib/ia-route';
import { hierarchicalTree, treeFixture } from './helpers/ia-fixture';

const navigation = vi.hoisted(() => ({ query: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function Probe() {
  useRouteDeepLink();
  const {
    expandedIaNodeKeys,
    iaDepth,
    iaTrees,
    iaView,
    selectedIaTreeKey,
    selectedIaNodeKey,
    toggleIaNodeExpanded,
  } = useStudio();
  return (
    <>
      <output
        data-depth={iaDepth}
        data-expanded={[...expandedIaNodeKeys].sort().join(',')}
        data-tree={selectedIaTreeKey ?? ''}
        data-node={selectedIaNodeKey ?? ''}
        data-view={iaView}
      />
      <button
        type="button"
        onClick={() => {
          const rootKey = iaTrees.find(
            (tree) => tree.key === selectedIaTreeKey,
          )?.nodes[0]?.key;
          if (rootKey) toggleIaNodeExpanded(rootKey);
        }}
      >
        Toggle first root
      </button>
    </>
  );
}

function app(trees: StudioIaTree[]) {
  return (
    <StudioProvider
      layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
      initialIaTrees={trees}
    >
      <Probe />
    </StudioProvider>
  );
}

async function render(
  root: Root,
  trees: StudioIaTree[],
): Promise<HTMLOutputElement> {
  await act(async () => {
    root.render(app(trees));
  });
  return document.querySelector('output') as HTMLOutputElement;
}

beforeEach(() => {
  navigation.query = '';
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('IA deep-link synchronization', () => {
  it('processes sequential IA query changes from browser navigation', async () => {
    const tree = hierarchicalTree();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const first = tree.nodes[0]!;
    const second = tree.nodes[1]!;

    navigation.query = new URLSearchParams({
      service: tree.serviceId,
      tree: tree.treeId,
      node: first.key,
      path: first.path!,
    }).toString();
    let probe = await render(root, [tree]);
    expect(probe.dataset.node).toBe(first.key);

    navigation.query = new URLSearchParams({
      service: tree.serviceId,
      tree: tree.treeId,
      node: second.key,
      path: second.path!,
    }).toString();
    probe = await render(root, [tree]);

    expect(probe.dataset.tree).toBe(tree.key);
    expect(probe.dataset.node).toBe(second.key);
  });

  it('re-resolves the current typed query when the IA catalog changes', async () => {
    const web = hierarchicalTree();
    const admin = treeFixture({
      key: 'admin::map',
      serviceId: 'admin',
      path: '/admin',
    });
    const target = admin.nodes[0]!;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    navigation.query = new URLSearchParams({
      service: admin.serviceId,
      tree: admin.treeId,
      node: target.key,
      path: target.path!,
    }).toString();
    let probe = await render(root, [web]);
    expect(probe.dataset.tree).not.toBe(admin.key);

    probe = await render(root, [web, admin]);

    expect(probe.dataset.tree).toBe(admin.key);
    expect(probe.dataset.node).toBe(target.key);
  });

  it('preserves expansion when a typed query selects another node in the same tree', async () => {
    const tree = hierarchicalTree();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const first = tree.nodes[0]!;
    const second = tree.nodes[1]!;

    navigation.query = new URLSearchParams({
      service: tree.serviceId,
      tree: tree.treeId,
      node: first.key,
      path: first.path!,
    }).toString();
    let probe = await render(root, [tree]);
    act(() => {
      container.querySelector<HTMLButtonElement>('button')!.click();
    });
    probe = container.querySelector('output') as HTMLOutputElement;
    expect(probe.dataset.expanded).not.toContain(first.key);

    navigation.query = new URLSearchParams({
      service: tree.serviceId,
      tree: tree.treeId,
      node: second.key,
      path: second.path!,
    }).toString();
    probe = await render(root, [tree]);

    expect(probe.dataset.node).toBe(second.key);
    expect(probe.dataset.expanded).not.toContain(first.key);
  });

  it('changes only view and depth when browser history has no IA identity', async () => {
    const tree = hierarchicalTree();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const target = tree.nodes[0]!;

    navigation.query = new URLSearchParams({
      service: tree.serviceId,
      tree: tree.treeId,
      node: target.key,
      path: target.path!,
      view: 'tree',
      depth: '2',
    }).toString();
    let probe = await render(root, [tree]);
    act(() => {
      container.querySelector<HTMLButtonElement>('button')!.click();
    });

    navigation.query = 'view=overview&depth=all';
    probe = await render(root, [tree]);

    expect(probe.dataset.tree).toBe(tree.key);
    expect(probe.dataset.node).toBe(target.key);
    expect(probe.dataset.expanded).not.toContain(target.key);
    expect(probe.dataset.view).toBe('overview');
    expect(probe.dataset.depth).toBe('6');
  });

  it('reads the pre-rename view=sitemap link as the overview view', async () => {
    const tree = hierarchicalTree();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    navigation.query = 'view=tree';
    let probe = await render(root, [tree]);
    expect(probe.dataset.view).toBe('tree');

    navigation.query = 'view=sitemap';
    probe = await render(root, [tree]);

    expect(probe.dataset.view).toBe('overview');
  });

  it('ignores an unknown view value instead of guessing', async () => {
    const tree = hierarchicalTree();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    navigation.query = 'view=tree';
    let probe = await render(root, [tree]);
    expect(probe.dataset.view).toBe('tree');

    navigation.query = 'view=route_hierarchy';
    probe = await render(root, [tree]);

    expect(probe.dataset.view).toBe('tree');
  });
});
