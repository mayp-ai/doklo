// @vitest-environment jsdom

import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StudioProvider,
  useStudio,
  type SaveStatus,
} from '../components/studio-store';
import { useDurableSave } from '../lib/hooks/use-durable-save';
import { usePersistentAction } from '../lib/hooks/use-persistent-action';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import type { SaveResult } from '../lib/persistence';

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type Patch = { value: string };

interface DurableController {
  queue: (patch: Patch) => void;
}

const DurableHarness = forwardRef<
  DurableController,
  { persist: (patch: Patch, revision: string) => Promise<SaveResult> }
>(function DurableHarness({ persist }, ref) {
  const durable = useDurableSave<Patch>({
    key: 'durable:A',
    path: '/workspace/A.json',
    initialRevision: 'rev-A0',
    merge: (_current, next) => next,
    persist,
  });
  useImperativeHandle(ref, () => ({ queue: durable.queue }), [durable.queue]);
  return null;
});

interface ActionController {
  execute: (request: string) => Promise<boolean>;
}

const ActionHarness = forwardRef<
  ActionController,
  {
    actionKey: string;
    path: string;
    persist: (request: string) => Promise<SaveResult>;
  }
>(function ActionHarness({ actionKey, path, persist }, ref) {
  const action = usePersistentAction({ key: actionKey, path, persist });
  useImperativeHandle(ref, () => action, [action]);
  return null;
});

interface CoordinatorController {
  pendingPath: () => string | null;
  status: () => SaveStatus;
  push: (href: string) => Promise<boolean>;
}

const CoordinatorHarness = forwardRef<CoordinatorController>(
  function CoordinatorHarness(_, ref) {
    const { pendingSave, saveStatus } = useStudio();
    const navigation = useSafeNavigation();
    useImperativeHandle(
      ref,
      () => ({
        pendingPath: () => pendingSave?.path ?? null,
        status: () => saveStatus,
        push: navigation.push,
      }),
      [navigation.push, pendingSave, saveStatus],
    );
    return null;
  },
);

const roots: Root[] = [];

function provider(children: ReactNode) {
  return (
    <StudioProvider layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}>
      {children}
    </StudioProvider>
  );
}

function render(children: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(provider(children)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  routerPush.mockReset();
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('persistent action ownership', () => {
  it('flushes a dirty durable owner before an inline action and never drops A', async () => {
    const calls: string[] = [];
    const persistA = vi.fn(async () => {
      calls.push('A');
      return { ok: true as const, path: '/workspace/A.json', revision: 'rev-A1' };
    });
    const persistB = vi.fn(async () => {
      calls.push('B');
      return { ok: true as const, path: '/workspace/B.json', revision: 'rev-B1' };
    });
    const durable = createRef<DurableController>();
    const action = createRef<ActionController>();
    const coordinator = createRef<CoordinatorController>();
    render(<>
      <DurableHarness ref={durable} persist={persistA} />
      <ActionHarness ref={action} actionKey="inline:B" path="/workspace/B.json" persist={persistB} />
      <CoordinatorHarness ref={coordinator} />
    </>);

    act(() => durable.current!.queue({ value: 'keep A' }));
    await act(async () => {
      expect(await action.current!.execute('save B')).toBe(true);
    });

    expect(calls).toEqual(['A', 'B']);
    expect(persistA).toHaveBeenCalledWith({ value: 'keep A' }, 'rev-A0');
    expect(coordinator.current!.pendingPath()).toBeNull();
  });

  it('leaves failed durable owner A registered and blocks inline action B', async () => {
    const persistA = vi.fn(async () => ({
      ok: false as const,
      code: 'WRITE_FAILED' as const,
      path: '/actual/A.json',
      error: 'A failed',
      preserved: true as const,
    }));
    const persistB = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/B.json',
      revision: 'rev-B1',
    }));
    const durable = createRef<DurableController>();
    const action = createRef<ActionController>();
    const coordinator = createRef<CoordinatorController>();
    render(<>
      <DurableHarness ref={durable} persist={persistA} />
      <ActionHarness ref={action} actionKey="inline:B" path="/workspace/B.json" persist={persistB} />
      <CoordinatorHarness ref={coordinator} />
    </>);

    act(() => durable.current!.queue({ value: 'retain A' }));
    await act(async () => {
      expect(await action.current!.execute('must not save B')).toBe(false);
    });

    expect(persistB).not.toHaveBeenCalled();
    expect(coordinator.current!.pendingPath()).toBe('/actual/A.json');
    expect(coordinator.current!.status()).toMatchObject({
      kind: 'error',
      path: '/actual/A.json',
      message: 'A failed',
    });
  });

  it('serializes concurrent B and C claims without replacing B ownership', async () => {
    const pendingB = deferred<SaveResult>();
    const persistB = vi.fn(() => pendingB.promise);
    const persistC = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/C.json',
      revision: 'rev-C1',
    }));
    const actionB = createRef<ActionController>();
    const actionC = createRef<ActionController>();
    const coordinator = createRef<CoordinatorController>();
    render(<>
      <ActionHarness ref={actionB} actionKey="inline:B" path="/workspace/B.json" persist={persistB} />
      <ActionHarness ref={actionC} actionKey="inline:C" path="/workspace/C.json" persist={persistC} />
      <CoordinatorHarness ref={coordinator} />
    </>);

    let resultB!: Promise<boolean>;
    let resultC!: Promise<boolean>;
    await act(async () => {
      resultB = actionB.current!.execute('save B');
      resultC = actionC.current!.execute('save C');
      await Promise.resolve();
    });

    expect(persistB).toHaveBeenCalledOnce();
    expect(persistC).not.toHaveBeenCalled();
    expect(coordinator.current!.pendingPath()).toBe('/workspace/B.json');

    pendingB.resolve({
      ok: true,
      path: '/workspace/B.json',
      revision: 'rev-B1',
    });
    await act(async () => {
      await expect(resultB).resolves.toBe(true);
      await expect(resultC).resolves.toBe(true);
    });

    expect(persistC).toHaveBeenCalledOnce();
    expect(coordinator.current!.pendingPath()).toBeNull();
  });

  it('queues navigation behind an in-progress claim and flushes newly claimed B before pushing', async () => {
    const pendingA = deferred<SaveResult>();
    const pendingB = deferred<SaveResult>();
    const persistA = vi.fn(() => pendingA.promise);
    const persistB = vi.fn(() => pendingB.promise);
    const durable = createRef<DurableController>();
    const action = createRef<ActionController>();
    const coordinator = createRef<CoordinatorController>();
    render(<>
      <DurableHarness ref={durable} persist={persistA} />
      <ActionHarness ref={action} actionKey="inline:B" path="/workspace/B.json" persist={persistB} />
      <CoordinatorHarness ref={coordinator} />
    </>);

    act(() => durable.current!.queue({ value: 'save A first' }));
    let actionResult!: Promise<boolean>;
    let navigationResult!: Promise<boolean>;
    await act(async () => {
      actionResult = action.current!.execute('save B');
      await Promise.resolve();
      navigationResult = coordinator.current!.push('/next');
      await Promise.resolve();
    });

    expect(persistA).toHaveBeenCalledOnce();
    expect(persistB).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();

    pendingA.resolve({
      ok: true,
      path: '/workspace/A.json',
      revision: 'rev-A1',
    });
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(persistB).toHaveBeenCalledOnce();

    pendingB.resolve({
      ok: false,
      code: 'WRITE_FAILED',
      path: '/actual/B.json',
      error: 'B failed',
      preserved: true,
    });
    await act(async () => {
      await expect(actionResult).resolves.toBe(false);
      await expect(navigationResult).resolves.toBe(false);
    });

    expect(routerPush).not.toHaveBeenCalled();
    expect(coordinator.current!.pendingPath()).toBe('/actual/B.json');
    expect(coordinator.current!.status()).toMatchObject({
      kind: 'error',
      path: '/actual/B.json',
      message: 'B failed',
    });
  });
});
