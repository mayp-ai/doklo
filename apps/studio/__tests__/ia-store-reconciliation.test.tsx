// @vitest-environment jsdom

import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StudioProvider,
  useStudio,
} from '../components/studio-store';
import type { StudioIaTree } from '../lib/ia-route';
import { hierarchicalTree, treeFixture } from './helpers/ia-fixture';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface StoreSnapshot {
  treeKey: string | null;
  nodeKey: string | null;
  expanded: string[];
}

interface StoreController {
  selectTree: (key: string | null) => void;
  selectNode: (key: string | null) => void;
  toggle: (key: string) => void;
  snapshot: () => StoreSnapshot;
}

const Probe = forwardRef<StoreController>(function Probe(_, ref) {
  const studio = useStudio();
  useImperativeHandle(
    ref,
    () => ({
      selectTree: studio.setSelectedIaTreeKey,
      selectNode: studio.setSelectedIaNodeKey,
      toggle: studio.toggleIaNodeExpanded,
      snapshot: () => ({
        treeKey: studio.selectedIaTreeKey,
        nodeKey: studio.selectedIaNodeKey,
        expanded: [...studio.expandedIaNodeKeys].sort(),
      }),
    }),
    [studio],
  );
  return null;
});

const roots: Root[] = [];

async function render(
  root: Root,
  trees: StudioIaTree[],
  controller: React.RefObject<StoreController | null>,
) {
  await act(async () => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}
        initialIaTrees={trees}
      >
        <Probe ref={controller} />
      </StudioProvider>,
    );
  });
}

function mountedRoot(): Root {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('IA catalog reconciliation', () => {
  it('preserves valid node and expansion state for the same tree key', async () => {
    const web = hierarchicalTree();
    const controller = createRef<StoreController>();
    const root = mountedRoot();
    await render(root, [web], controller);
    const selected = web.nodes[0]!.children[0]!;

    act(() => {
      controller.current!.selectNode(selected.key);
      controller.current!.toggle(web.nodes[0]!.key);
    });
    expect(controller.current!.snapshot().expanded).not.toContain(
      web.nodes[0]!.key,
    );

    act(() => controller.current!.selectTree(web.key));
    expect(controller.current!.snapshot()).toMatchObject({
      treeKey: web.key,
      nodeKey: selected.key,
    });
    expect(controller.current!.snapshot().expanded).not.toContain(
      web.nodes[0]!.key,
    );

    const replacement = {
      ...web,
      nodes: web.nodes.map((node) => ({
        ...node,
        children: node.children.map((child) => ({ ...child })),
      })),
    };
    await render(root, [replacement], controller);

    expect(controller.current!.snapshot()).toMatchObject({
      treeKey: web.key,
      nodeKey: selected.key,
    });
    expect(controller.current!.snapshot().expanded).not.toContain(
      web.nodes[0]!.key,
    );
  });

  it('falls back atomically when the selected tree is removed', async () => {
    const web = hierarchicalTree();
    const admin = treeFixture({
      key: 'admin::admin-map',
      serviceId: 'admin',
      path: '/admin',
    });
    const controller = createRef<StoreController>();
    const root = mountedRoot();
    await render(root, [web, admin], controller);

    act(() => {
      controller.current!.selectTree(admin.key);
      controller.current!.selectNode(admin.nodes[0]!.key);
      controller.current!.toggle(admin.nodes[0]!.key);
    });
    await render(root, [web], controller);

    expect(controller.current!.snapshot()).toEqual({
      treeKey: web.key,
      nodeKey: null,
      expanded: web.nodes.map((node) => node.key).sort(),
    });
  });

  it('clears stale node and expansion keys when the selected tree is replaced', async () => {
    const web = hierarchicalTree();
    const controller = createRef<StoreController>();
    const root = mountedRoot();
    await render(root, [web], controller);
    const selected = web.nodes[0]!.children[0]!;
    act(() => controller.current!.selectNode(selected.key));

    const replacement = treeFixture({
      key: web.key,
      serviceId: web.serviceId,
      path: '/replacement',
    });
    await render(root, [replacement], controller);

    expect(controller.current!.snapshot()).toEqual({
      treeKey: web.key,
      nodeKey: null,
      expanded: [],
    });
  });
});
