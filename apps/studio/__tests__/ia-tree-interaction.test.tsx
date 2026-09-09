// @vitest-environment jsdom

import {
  act,
  createRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IA_DEPTH_MAX,
  StudioProvider,
  useStudio,
} from '../components/studio-store';
import { IaTree } from '../components/ia-tree';
import { RoutePreview } from '../components/route-preview';
import type { StudioIaNode, StudioIaTree } from '../lib/ia-route';
import { hierarchicalTree } from './helpers/ia-fixture';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

interface TreeController {
  selectNode: (key: string | null) => void;
  setDepth: (depth: number) => void;
  setFilter: (
    filter: 'all' | 'mapped' | 'unmapped' | 'desktop' | 'mobile',
  ) => void;
  snapshot: () => {
    selectedKey: string | null;
    expandedKeys: string[];
  };
}

const TreeProbe = forwardRef<TreeController>(function TreeProbe(_, ref) {
  const studio = useStudio();
  useImperativeHandle(
    ref,
    () => ({
      selectNode: studio.setSelectedIaNodeKey,
      setDepth: studio.setIaDepth,
      setFilter: studio.setRouteFilter,
      snapshot: () => ({
        selectedKey: studio.selectedIaNodeKey,
        expandedKeys: [...studio.expandedIaNodeKeys],
      }),
    }),
    [studio],
  );
  return null;
});

function TreeHarness({
  tree,
  all = false,
  filter,
}: {
  tree: StudioIaTree;
  all?: boolean;
  filter?: 'all' | 'mapped' | 'unmapped' | 'desktop' | 'mobile';
}) {
  return (
    <StudioProvider
      layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
      initialIaTrees={[tree]}
    >
      {all ? <SelectAllDepth /> : null}
      {filter ? <SelectFilter filter={filter} /> : null}
      <IaTree />
    </StudioProvider>
  );
}

function SelectAllDepth() {
  const { setIaDepth } = useStudio();
  useEffect(() => setIaDepth(IA_DEPTH_MAX), [setIaDepth]);
  return null;
}

function SelectFilter({
  filter,
}: {
  filter: 'all' | 'mapped' | 'unmapped' | 'desktop' | 'mobile';
}) {
  const { setRouteFilter } = useStudio();
  useEffect(() => setRouteFilter(filter), [filter, setRouteFilter]);
  return null;
}

function deepTree(depth: number): StudioIaTree {
  let children: StudioIaNode[] = [];
  for (let level = depth; level >= 1; level -= 1) {
    children = [{
      key: `web::deep/level-${level}`,
      path: `/level-${level}`,
      seg: `level-${level}`,
      title: `Level ${level}`,
      platform: 'both',
      tags: [],
      unmapped: true,
      children,
    }];
  }
  return {
    key: 'web::deep',
    serviceId: 'web',
    treeId: 'deep',
    type: 'navigation',
    source: 'manual',
    platform: 'both',
    nodes: children,
  };
}

async function mount(
  tree: StudioIaTree,
  all = false,
  filter?: 'all' | 'mapped' | 'unmapped' | 'desktop' | 'mobile',
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<TreeHarness tree={tree} all={all} filter={filter} />);
  });
  return container;
}

async function mountControlled(
  tree: StudioIaTree,
  includePreview = false,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const controller = createRef<TreeController>();
  await act(async () => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
        initialIaTrees={[tree]}
      >
        <TreeProbe ref={controller} />
        <IaTree />
        {includePreview ? <RoutePreview /> : null}
      </StudioProvider>,
    );
  });
  return { container, controller };
}

function keyDown(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

function pointerDown(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    }));
  });
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('IA tree keyboard interaction', () => {
  it('uses one container tab stop and a mounted active descendant for keyboard selection', async () => {
    const container = await mount(hierarchicalTree());
    let items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const first = items[0]!;
    const second = items[1]!;
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
    const tabbable = [tree, ...Array.from(
      tree.querySelectorAll<HTMLElement>('button, [tabindex]'),
    )].filter((element) => element.tabIndex >= 0);

    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(tabbable).toEqual([tree]);
    expect(document.getElementById(tree.getAttribute('aria-activedescendant')!))
      .toBe(first);

    pointerDown(first);
    expect(document.activeElement).toBe(tree);
    keyDown(tree, 'ArrowDown');

    items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    expect(document.activeElement).toBe(tree);
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(document.getElementById(tree.getAttribute('aria-activedescendant')!))
      .toBe(items[1]);
    expect(items[1]?.getAttribute('aria-selected')).toBe('true');

    keyDown(tree, 'Enter');
    expect(items[1]?.getAttribute('aria-selected')).toBe('true');
    expect(items[0]?.getAttribute('aria-selected')).toBe('false');
  });

  it('renders every level when the depth control says all', async () => {
    const container = await mount(deepTree(9), true);

    for (let index = 0; index < 8; index += 1) {
      const expand = container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Expand "]',
      );
      if (!expand) break;
      act(() => expand.click());
    }

    const items = container.querySelectorAll('[role="treeitem"]');
    expect(items).toHaveLength(9);
    expect(items[8]?.textContent).toContain('Level 9');
    expect(container.textContent).not.toContain('increase depth to reveal');
  });

  it('moves a hidden descendant selection and active descendant to its collapsed ancestor', async () => {
    const container = await mount(hierarchicalTree());
    const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
    const child = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('비밀번호 재설정'))!;
    act(() => {
      tree.focus();
      child.click();
    });
    expect(child.getAttribute('aria-selected')).toBe('true');

    act(() => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse Auth"]',
      )!.click();
    });

    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const auth = items.find((item) => item.textContent?.includes('Auth'))!;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(auth.getAttribute('aria-selected')).toBe('true');
    expect(tree.getAttribute('aria-activedescendant')).toBe(auth.id);
    expect(document.activeElement).toBe(tree);
  });

  it('treats a filtered parent with no visible children as a keyboard leaf', async () => {
    const filteredTree: StudioIaTree = {
      key: 'web::filtered',
      serviceId: 'web',
      treeId: 'filtered',
      type: 'navigation',
      source: 'manual',
      platform: 'both',
      nodes: [{
        key: 'web::filtered/parent',
        path: '/parent',
        seg: 'parent',
        title: 'Visible parent',
        platform: 'both',
        tags: [],
        unmapped: true,
        children: [{
          key: 'web::filtered/parent/mapped',
          path: '/parent/mapped',
          seg: 'mapped',
          title: 'Filtered mapped child',
          dok_ref: 'AUTH-SIGNIN',
          platform: 'both',
          tags: [],
          unmapped: false,
          children: [],
        }],
      }],
    };
    const container = await mount(filteredTree, false, 'unmapped');
    const item = container.querySelector<HTMLElement>('[role="treeitem"]')!;

    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(item.getAttribute('aria-expanded')).toBeNull();
    expect(
      container.querySelector('button[aria-label*="Visible parent"]'),
    ).toBeNull();

    const tree = container.querySelector<HTMLElement>('[role="tree"]')!;
    act(() => tree.focus());
    keyDown(tree, 'ArrowRight');
    expect(document.activeElement).toBe(tree);
    expect(tree.getAttribute('aria-activedescendant')).toBe(item.id);
    expect(item.tabIndex).toBe(-1);
  });

  it('reveals an explicitly selected descendant without stealing external focus', async () => {
    const tree = hierarchicalTree();
    const { container, controller } = await mountControlled(tree);
    const auth = tree.nodes[0]!;
    const child = auth.children[0]!;
    act(() => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse Auth"]',
      )!.click();
    });
    expect(container.textContent).not.toContain(child.title);

    const external = document.createElement('button');
    document.body.append(external);
    act(() => external.focus());
    act(() => controller.current!.selectNode(child.key));

    const selected = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes(child.title))!;
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(controller.current!.snapshot()).toMatchObject({
      selectedKey: child.key,
    });
    expect(controller.current!.snapshot().expandedKeys).toContain(auth.key);
    expect(document.activeElement).toBe(external);
  });

  it('preserves hidden selection and external focus across filter and depth changes', async () => {
    const tree = hierarchicalTree();
    const { container, controller } = await mountControlled(tree);
    const child = tree.nodes[0]!.children[0]!;
    act(() => controller.current!.selectNode(child.key));
    const external = document.createElement('button');
    document.body.append(external);
    act(() => external.focus());

    act(() => controller.current!.setFilter('unmapped'));
    expect(container.textContent).not.toContain(child.title);
    expect(controller.current!.snapshot().selectedKey).toBe(child.key);
    expect(document.activeElement).toBe(external);

    act(() => controller.current!.setFilter('all'));
    act(() => controller.current!.setDepth(1));
    expect(container.textContent).not.toContain(child.title);
    expect(controller.current!.snapshot().selectedKey).toBe(child.key);
    expect(document.activeElement).toBe(external);
  });

  it('keeps inactive tree keys from operating on an unrelated filtered branch', async () => {
    const tree: StudioIaTree = {
      key: 'web::focus-filter',
      serviceId: 'web',
      treeId: 'focus-filter',
      type: 'navigation',
      source: 'manual',
      platform: 'both',
      nodes: [{
        key: 'web::focus-filter/mapped',
        path: '/mapped',
        seg: 'mapped',
        title: 'Selected mapped branch',
        dok_ref: 'AUTH-SIGNIN',
        platform: 'both',
        tags: [],
        unmapped: false,
        children: [],
      }, {
        key: 'web::focus-filter/unmapped',
        path: '/unmapped',
        seg: 'unmapped',
        title: 'Unrelated unmapped branch',
        platform: 'both',
        tags: [],
        unmapped: true,
        children: [{
          key: 'web::focus-filter/unmapped/child',
          path: '/unmapped/child',
          seg: 'child',
          title: 'Unrelated unmapped child',
          platform: 'both',
          tags: [],
          unmapped: true,
          children: [],
        }],
      }],
    };
    const { container, controller } = await mountControlled(tree);
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;
    const selected = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('Selected mapped branch'))!;
    const currentTabStop = [treeElement, ...treeElement.querySelectorAll<HTMLElement>(
      '[tabindex]',
    )].find((element) => element.tabIndex === 0)!;

    act(() => {
      currentTabStop.focus();
      selected.click();
      controller.current!.setFilter('unmapped');
    });

    const visible = container.querySelector<HTMLElement>('[role="treeitem"]')!;
    expect(visible.textContent).toContain('Unrelated unmapped branch');
    expect(controller.current!.snapshot().selectedKey).toBe(
      tree.nodes[0]!.key,
    );
    expect(treeElement.getAttribute('aria-activedescendant')).toBeNull();
    expect(document.activeElement).toBe(treeElement);

    const before = controller.current!.snapshot();
    keyDown(treeElement, 'ArrowRight');
    expect(controller.current!.snapshot()).toEqual(before);
    expect(treeElement.getAttribute('aria-activedescendant')).toBeNull();

    keyDown(treeElement, 'ArrowLeft');
    expect(controller.current!.snapshot()).toEqual(before);
    expect(treeElement.getAttribute('aria-activedescendant')).toBeNull();
    expect([...treeElement.classList]).toEqual(expect.arrayContaining([
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-accent',
    ]));
  });

  it('moves the active descendant to the nearest visible ancestor after a depth shortcut', async () => {
    const base = hierarchicalTree();
    const programs = {
      ...base.nodes[1]!,
      children: [{
        key: `${base.key}/programs/detail`,
        path: '/programs/detail',
        seg: 'detail',
        title: 'Program detail',
        platform: 'both' as const,
        tags: [],
        unmapped: true,
        children: [],
      }],
    };
    const tree = { ...base, nodes: [base.nodes[0]!, programs] };
    const { container, controller } = await mountControlled(tree);
    const child = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('Program detail'))!;
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;

    act(() => {
      treeElement.focus();
      child.click();
      controller.current!.setDepth(1);
    });

    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const visiblePrograms = items.find(
      (item) => item.textContent?.includes('Programs'),
    )!;
    expect(items).toHaveLength(2);
    expect(controller.current!.snapshot().selectedKey).toBe(
      programs.children[0]!.key,
    );
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(treeElement.getAttribute('aria-activedescendant')).toBe(
      visiblePrograms.id,
    );
    expect(document.activeElement).toBe(treeElement);
  });

  it('does not reclaim focus when null-target blur and projection update share a task', async () => {
    const base = hierarchicalTree();
    const programs = {
      ...base.nodes[1]!,
      children: [{
        key: `${base.key}/programs/detail`,
        path: '/programs/detail',
        seg: 'detail',
        title: 'Program detail',
        platform: 'both' as const,
        tags: [],
        unmapped: true,
        children: [],
      }],
    };
    const tree = { ...base, nodes: [base.nodes[0]!, programs] };
    const { container, controller } = await mountControlled(tree);
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;
    const child = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('Program detail'))!;
    const currentTabStop = [treeElement, ...treeElement.querySelectorAll<HTMLElement>(
      '[tabindex]',
    )].find((element) => element.tabIndex === 0)!;

    act(() => {
      currentTabStop.focus();
      child.click();
    });
    await act(async () => {
      currentTabStop.blur();
      controller.current!.setDepth(1);
      await Promise.resolve();
    });

    expect(container.contains(document.activeElement)).toBe(false);
  });

  it('does not recover tree focus after an ordinary null-target blur', async () => {
    const base = hierarchicalTree();
    const programs = {
      ...base.nodes[1]!,
      children: [{
        key: `${base.key}/programs/detail`,
        path: '/programs/detail',
        seg: 'detail',
        title: 'Program detail',
        platform: 'both' as const,
        tags: [],
        unmapped: true,
        children: [],
      }],
    };
    const tree = { ...base, nodes: [base.nodes[0]!, programs] };
    const { container, controller } = await mountControlled(tree);
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;
    const child = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('Program detail'))!;

    act(() => {
      treeElement.focus();
      child.click();
    });
    await act(async () => {
      treeElement.blur();
      await Promise.resolve();
    });
    expect(container.contains(document.activeElement)).toBe(false);

    act(() => controller.current!.setDepth(1));

    expect(container.contains(document.activeElement)).toBe(false);
  });

  it('focuses the tree container after disclosure pointer activation', async () => {
    const tree = hierarchicalTree();
    const { container, controller } = await mountControlled(tree);
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const programs = items.find(
      (item) => item.textContent?.includes('Programs'),
    )!;
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Auth"]',
    )!;

    act(() => programs.click());
    pointerDown(disclosure);
    act(() => disclosure.click());

    expect(disclosure.tabIndex).toBe(-1);
    expect(controller.current!.snapshot().selectedKey).toBe(
      tree.nodes[1]!.key,
    );
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;
    expect(treeElement.getAttribute('aria-activedescendant')).toBe(programs.id);
    expect(document.activeElement).toBe(treeElement);
  });

  it('keeps the active treeitem while disclosure focus moves to the container', async () => {
    const tree = hierarchicalTree();
    const { container, controller } = await mountControlled(tree);
    const auth = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('Auth'))!;
    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Auth"]',
    )!;

    act(() => auth.click());
    pointerDown(disclosure);
    act(() => disclosure.click());

    expect(controller.current!.snapshot().selectedKey).toBe(
      tree.nodes[0]!.key,
    );
    expect(disclosure.tabIndex).toBe(-1);
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;
    expect(treeElement.getAttribute('aria-activedescendant')).toBe(auth.id);
    expect(document.activeElement).toBe(treeElement);
  });

  it('does not steal external focus when filtered rows remount', async () => {
    const tree = hierarchicalTree();
    const { container, controller } = await mountControlled(tree);
    const treeElement =
      container.querySelector<HTMLElement>('[role="tree"]')!;
    const child = Array.from(
      container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ).find((item) => item.textContent?.includes('비밀번호 재설정'))!;

    act(() => {
      treeElement.focus();
      child.click();
      controller.current!.setFilter('desktop');
    });
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0);

    const external = document.createElement('button');
    document.body.append(external);
    act(() => external.focus());
    act(() => controller.current!.setFilter('all'));

    expect(container.textContent).toContain('비밀번호 재설정');
    expect(document.activeElement).toBe(external);
  });

  it('renders an empty path as a path in the tree and route preview', async () => {
    const base = hierarchicalTree();
    const emptyPathNode = {
      ...base.nodes[1]!,
      key: `${base.key}/empty-path`,
      path: '',
      seg: '',
      title: 'Empty path route',
    };
    const tree = { ...base, nodes: [emptyPathNode] };
    const { container } = await mountControlled(tree, true);
    const row = container.querySelector<HTMLElement>('[role="treeitem"]')!;

    act(() => row.click());

    expect(container.textContent).toContain('Selected IA node');
    expect(container.textContent).not.toContain('Grouping node');
    const emptyPathLabels = container.querySelectorAll(
      '[aria-label="Empty path"]',
    );
    expect(emptyPathLabels).toHaveLength(2);
    expect(
      [...emptyPathLabels].map((element) => element.textContent),
    ).toEqual(['""', '""']);
  });

  it('does not steal external focus when a user collapse hides the selection', async () => {
    const tree = hierarchicalTree();
    const { container, controller } = await mountControlled(tree);
    const auth = tree.nodes[0]!;
    const child = auth.children[0]!;
    act(() => controller.current!.selectNode(child.key));
    const external = document.createElement('button');
    document.body.append(external);
    act(() => external.focus());

    act(() => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse Auth"]',
      )!.click();
    });

    expect(controller.current!.snapshot().selectedKey).toBe(auth.key);
    expect(document.activeElement).toBe(external);
  });
});
