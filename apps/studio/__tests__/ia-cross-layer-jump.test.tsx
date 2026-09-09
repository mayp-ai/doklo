// @vitest-environment jsdom

import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StudioProvider,
  useStudio,
  type PendingSaveRegistration,
  type RecentJump,
} from '../components/studio-store';
import { useCrossLayerJump } from '../lib/hooks/use-cross-layer-jump';
import type { IaJumpTarget, StudioIaTree } from '../lib/ia-route';
import { hierarchicalTree } from './helpers/ia-fixture';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface JumpSnapshot {
  treeKey: string | null;
  nodeKey: string | null;
  recent: RecentJump[];
}

interface JumpController {
  jumpToIaNode: (target: IaJumpTarget, label?: string) => void;
  jumpToRoute: (path: string, label?: string) => void;
  registerPendingSave: (pending: PendingSaveRegistration | null) => void;
  snapshot: () => JumpSnapshot;
}

const Probe = forwardRef<JumpController>(function Probe(_, ref) {
  const jump = useCrossLayerJump();
  const studio = useStudio();
  useImperativeHandle(
    ref,
    () => ({
      jumpToIaNode: jump.jumpToIaNode,
      jumpToRoute: jump.jumpToRoute,
      registerPendingSave: studio.registerPendingSave,
      snapshot: () => ({
        treeKey: studio.selectedIaTreeKey,
        nodeKey: studio.selectedIaNodeKey,
        recent: studio.recentJumps,
      }),
    }),
    [jump, studio],
  );
  return null;
});

const roots: Root[] = [];

async function mount(tree: StudioIaTree) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const controller = createRef<JumpController>();
  const render = async (trees: StudioIaTree[]) => {
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
  };
  await render([tree]);
  return { controller, render };
}

async function settleJump(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  routerPush.mockReset();
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('typed IA cross-layer jumps', () => {
  it('rejects a stale recent target before navigation or history writes', async () => {
    const tree = hierarchicalTree();
    const { controller } = await mount(tree);

    await settleJump(() => controller.current!.jumpToIaNode({
      serviceId: tree.serviceId,
      treeId: tree.treeId,
      nodeKey: 'stale-node',
      path: '/stale',
    }, 'Stale recent result'));

    expect(routerPush).not.toHaveBeenCalled();
    expect(controller.current!.snapshot()).toEqual({
      treeKey: tree.key,
      nodeKey: null,
      recent: [],
    });
  });

  it('rejects a target whose path contradicts its typed node', async () => {
    const tree = hierarchicalTree();
    const { controller } = await mount(tree);
    const node = tree.nodes[0]!;

    await settleJump(() => controller.current!.jumpToIaNode({
      serviceId: tree.serviceId,
      treeId: tree.treeId,
      nodeKey: node.key,
      path: '/contradictory',
    }));

    expect(routerPush).not.toHaveBeenCalled();
    expect(controller.current!.snapshot().nodeKey).toBeNull();
    expect(controller.current!.snapshot().recent).toEqual([]);
  });

  it('keeps legacy path-only jumps compatible and records the resolved identity', async () => {
    const tree = hierarchicalTree();
    const { controller } = await mount(tree);
    const node = tree.nodes[1]!;

    await settleJump(() => controller.current!.jumpToRoute(
      node.path!,
      'Programs',
    ));

    expect(routerPush).toHaveBeenCalledWith('/ia?path=%2Fprograms');
    expect(controller.current!.snapshot()).toMatchObject({
      treeKey: tree.key,
      nodeKey: node.key,
      recent: [{
        kind: 'route',
        id: node.key,
        label: 'Programs',
        iaTarget: {
          serviceId: tree.serviceId,
          treeId: tree.treeId,
          nodeKey: node.key,
          path: node.path,
        },
      }],
    });
  });

  it('revalidates the catalog after a pending save before pushing or writing state', async () => {
    const tree = hierarchicalTree();
    const target = tree.nodes[0]!.children[0]!;
    const { controller, render } = await mount(tree);
    let finishSave!: (saved: boolean) => void;
    const pendingSave = new Promise<boolean>((resolve) => {
      finishSave = resolve;
    });
    const flush = vi.fn(() => pendingSave);

    act(() => {
      controller.current!.registerPendingSave({
        path: '/workspace/pending.json',
        flush,
      });
      controller.current!.jumpToIaNode({
        serviceId: tree.serviceId,
        treeId: tree.treeId,
        nodeKey: target.key,
        path: target.path,
      }, target.title);
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();

    await render([{
      ...tree,
      nodes: tree.nodes.filter((node) => node.key !== tree.nodes[0]!.key),
    }]);
    await act(async () => {
      finishSave(true);
      await pendingSave;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(routerPush).not.toHaveBeenCalled();
    expect(controller.current!.snapshot()).toEqual({
      treeKey: tree.key,
      nodeKey: null,
      recent: [],
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it('flushes once and builds a typed jump from the latest catalog target', async () => {
    const tree = hierarchicalTree();
    const target = tree.nodes[1]!;
    const replacementTarget = {
      ...target,
      path: '/programs/latest',
    };
    const { controller, render } = await mount(tree);
    let finishSave!: (saved: boolean) => void;
    const pendingSave = new Promise<boolean>((resolve) => {
      finishSave = resolve;
    });
    const flush = vi.fn(() => pendingSave);

    act(() => {
      controller.current!.registerPendingSave({
        path: '/workspace/pending.json',
        flush,
      });
      controller.current!.jumpToIaNode({
        serviceId: tree.serviceId,
        treeId: tree.treeId,
        nodeKey: target.key,
        path: target.path,
      }, target.title);
    });
    expect(flush).toHaveBeenCalledOnce();

    await render([{ ...tree, nodes: [replacementTarget] }]);
    await act(async () => {
      finishSave(true);
      await pendingSave;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).toHaveBeenCalledWith(
      '/ia?service=web&tree=web-sitemap&node=web%3A%3Aweb-sitemap%2Fprograms&path=%2Fprograms%2Flatest',
    );
    expect(controller.current!.snapshot()).toMatchObject({
      treeKey: tree.key,
      nodeKey: target.key,
      recent: [{
        kind: 'route',
        id: target.key,
        iaTarget: {
          serviceId: tree.serviceId,
          treeId: tree.treeId,
          nodeKey: target.key,
          path: replacementTarget.path,
        },
      }],
    });
  });

  it('resolves a legacy path replacement after the guarded save', async () => {
    const tree = hierarchicalTree();
    const original = tree.nodes[1]!;
    const replacement = {
      ...original,
      key: `${tree.key}/replacement-programs`,
      title: 'Replacement Programs',
    };
    const { controller, render } = await mount(tree);
    let finishSave!: (saved: boolean) => void;
    const pendingSave = new Promise<boolean>((resolve) => {
      finishSave = resolve;
    });
    const flush = vi.fn(() => pendingSave);

    act(() => {
      controller.current!.registerPendingSave({
        path: '/workspace/pending.json',
        flush,
      });
      controller.current!.jumpToRoute(original.path!, original.title);
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();

    await render([{ ...tree, nodes: [replacement] }]);
    await act(async () => {
      finishSave(true);
      await pendingSave;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).toHaveBeenCalledWith('/ia?path=%2Fprograms');
    expect(controller.current!.snapshot()).toMatchObject({
      treeKey: tree.key,
      nodeKey: replacement.key,
      recent: [{
        kind: 'route',
        id: replacement.key,
        label: original.title,
        iaTarget: {
          serviceId: tree.serviceId,
          treeId: tree.treeId,
          nodeKey: replacement.key,
          path: replacement.path,
        },
      }],
    });
  });

  it('keeps a legacy path URL compatible when its target is removed during save', async () => {
    const tree = hierarchicalTree();
    const original = tree.nodes[1]!;
    const { controller, render } = await mount(tree);
    let finishSave!: (saved: boolean) => void;
    const pendingSave = new Promise<boolean>((resolve) => {
      finishSave = resolve;
    });
    const flush = vi.fn(() => pendingSave);

    act(() => {
      controller.current!.registerPendingSave({
        path: '/workspace/pending.json',
        flush,
      });
      controller.current!.jumpToRoute(original.path!, original.title);
    });
    expect(flush).toHaveBeenCalledOnce();

    await render([{ ...tree, nodes: [] }]);
    await act(async () => {
      finishSave(true);
      await pendingSave;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).toHaveBeenCalledWith('/ia?path=%2Fprograms');
    expect(controller.current!.snapshot()).toEqual({
      treeKey: tree.key,
      nodeKey: null,
      recent: [],
    });
  });
});
