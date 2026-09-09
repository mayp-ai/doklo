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
import { SaveGuard } from '../components/save-guard';
import { DokPreview } from '../components/dok-preview';
import { KeyboardShortcuts } from '../components/keyboard-shortcuts';
import { ConsolidationBoard } from '../components/consolidation/consolidation-board';
import {
  StudioProvider,
  useStudio,
  type SaveStatus,
} from '../components/studio-store';
import { useDurableSave } from '../lib/hooks/use-durable-save';
import { useCrossLayerJump } from '../lib/hooks/use-cross-layer-jump';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import type { SaveResult } from '../lib/persistence';
import type { ConsolidatedFeatureConfig } from '../lib/consolidation';
import authDokJson from '../demo/.doklo/hub/doks/AUTH-SOCIAL.json';
import type { Dok } from '@doklo-beta/core';

const routerPush = vi.hoisted(() => vi.fn());
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

type Patch = { description?: string; name?: string };

interface DurableController {
  queue: (patch: Patch) => void;
  flush: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  push: (href: string) => Promise<boolean>;
  status: () => SaveStatus;
  pendingPath: () => string | null;
}

const DurableHarness = forwardRef<
  DurableController,
  {
    persist: (patch: Patch, expectedRevision: string) => Promise<SaveResult>;
    saveKey?: string;
    path?: string;
    initialRevision?: string;
    mode?: 'auto' | 'manual';
    confirmDiscard?: (path: string) => boolean;
  }
>(function DurableHarness(
  {
    persist,
    saveKey = 'dok:AUTH-SOCIAL',
    path = '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
    initialRevision = 'rev-1',
    mode = 'auto',
    confirmDiscard,
  },
  ref,
) {
  const save = useDurableSave<Patch>({
    key: saveKey,
    path,
    initialRevision,
    merge: (current, next) => ({ ...current, ...next }),
    persist,
    mode,
    confirmDiscard,
  });
  const navigation = useSafeNavigation();
  const { pendingSave, saveStatus } = useStudio();

  useImperativeHandle(
    ref,
    () => ({
      ...save,
      ...navigation,
      status: () => saveStatus,
      pendingPath: () => pendingSave?.path ?? null,
    }),
    [navigation, pendingSave, save, saveStatus],
  );
  return null;
});

interface PendingController {
  register: (path: string, flush: () => Promise<boolean>) => void;
  setStatus: (status: SaveStatus) => void;
  status: () => SaveStatus;
  pendingPath: () => string | null;
}

const PendingHarness = forwardRef<PendingController>(function PendingHarness(_, ref) {
  const {
    pendingSave,
    registerPendingSave,
    saveStatus,
    setSaveStatus,
  } = useStudio();
  useImperativeHandle(
    ref,
    () => ({
      register: (path, flush) => registerPendingSave({ path, flush }),
      setStatus: setSaveStatus,
      status: () => saveStatus,
      pendingPath: () => pendingSave?.path ?? null,
    }),
    [
      pendingSave,
      registerPendingSave,
      saveStatus,
      setSaveStatus,
    ],
  );
  return null;
});

interface JumpController {
  jumpToDok: (id: string) => void;
  selectedDok: () => string | null;
  recentCount: () => number;
}

const JumpHarness = forwardRef<JumpController>(function JumpHarness(_, ref) {
  const { jumpToDok } = useCrossLayerJump();
  const { recentJumps, selectedDokId } = useStudio();
  useImperativeHandle(
    ref,
    () => ({
      jumpToDok,
      selectedDok: () => selectedDokId,
      recentCount: () => recentJumps.length,
    }),
    [jumpToDok, recentJumps.length, selectedDokId],
  );
  return null;
});

const roots: Root[] = [];

function provider(children: ReactNode) {
  return (
    <StudioProvider layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}>
      {children}
    </StudioProvider>
  );
}

function render(ui: ReactNode): Root {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
  routerPush.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('useDurableSave', () => {
  it('waits 800ms by default and flushes one merged patch on demand', async () => {
    const persist = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
      revision: 'rev-2',
    }));
    const controller = createRef<DurableController>();
    render(provider(<DurableHarness ref={controller} persist={persist} />));

    act(() => {
      controller.current!.queue({ description: 'pending' });
      controller.current!.queue({ name: 'Authentication' });
      vi.advanceTimersByTime(799);
    });

    expect(persist).not.toHaveBeenCalled();
    await act(async () => {
      expect(await controller.current!.flush()).toBe(true);
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith(
      { description: 'pending', name: 'Authentication' },
      'rev-1',
    );
  });

  it('keeps a manual patch local after the autosave interval', () => {
    const persist = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
      revision: 'rev-2',
    }));
    const controller = createRef<DurableController>();
    render(provider(
      <DurableHarness
        ref={controller}
        persist={persist}
        mode="manual"
      />,
    ));

    act(() => {
      controller.current!.queue({ description: 'local only' });
      vi.advanceTimersByTime(10_000);
    });

    expect(persist).not.toHaveBeenCalled();
    expect(controller.current!.status()).toMatchObject({
      kind: 'dirty',
      path: '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
    });
    expect(controller.current!.pendingPath()).toBe(
      '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
    );
  });

  it('cancels navigation when manual discard is rejected', async () => {
    const persist = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
      revision: 'rev-2',
    }));
    const confirmDiscard = vi.fn(() => false);
    const controller = createRef<DurableController>();
    render(provider(
      <DurableHarness
        ref={controller}
        persist={persist}
        mode="manual"
        confirmDiscard={confirmDiscard}
      />,
    ));

    act(() => controller.current!.queue({ description: 'keep me' }));
    await act(async () => {
      expect(await controller.current!.push('/doks')).toBe(false);
    });

    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(confirmDiscard).toHaveBeenCalledWith(
      '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
    );
    expect(persist).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(controller.current!.status()).toMatchObject({ kind: 'dirty' });
    expect(controller.current!.pendingPath()).not.toBeNull();
  });

  it('discards without persistence when manual navigation is confirmed', async () => {
    const persist = vi.fn(async () => ({
      ok: true as const,
      path: '/workspace/.doklo/hub/doks/AUTH-SOCIAL.json',
      revision: 'rev-2',
    }));
    const confirmDiscard = vi.fn(() => true);
    const controller = createRef<DurableController>();
    render(provider(
      <DurableHarness
        ref={controller}
        persist={persist}
        mode="manual"
        confirmDiscard={confirmDiscard}
      />,
    ));

    act(() => controller.current!.queue({ description: 'discard me' }));
    await act(async () => {
      expect(await controller.current!.push('/doks')).toBe(true);
    });

    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/doks');
    expect(controller.current!.status()).toEqual({ kind: 'idle' });
    expect(controller.current!.pendingPath()).toBeNull();
  });

  it('retains failed input and exposes an affected-path retry using the same revision', async () => {
    const persist = vi
      .fn<(patch: Patch, expectedRevision: string) => Promise<SaveResult>>()
      .mockResolvedValueOnce({
        ok: false,
        code: 'WRITE_FAILED',
        path: '/actual/AUTH-SOCIAL.json',
        error: 'disk is read-only',
        preserved: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        path: '/actual/AUTH-SOCIAL.json',
        revision: 'rev-2',
      });
    const controller = createRef<DurableController>();
    render(provider(<DurableHarness ref={controller} persist={persist} />));

    act(() => controller.current!.queue({ description: 'retain me' }));
    await act(async () => {
      expect(await controller.current!.flush()).toBe(false);
    });
    const failed = controller.current!.status();
    expect(failed).toMatchObject({
      kind: 'error',
      path: '/actual/AUTH-SOCIAL.json',
      message: 'disk is read-only',
      retry: expect.any(Function),
    });
    expect(controller.current!.pendingPath()).toBe('/actual/AUTH-SOCIAL.json');

    await act(async () => {
      if (failed.kind !== 'error') throw new Error('Expected an error status.');
      expect(await failed.retry()).toBe(true);
    });
    expect(persist).toHaveBeenNthCalledWith(1, { description: 'retain me' }, 'rev-1');
    expect(persist).toHaveBeenNthCalledWith(2, { description: 'retain me' }, 'rev-1');
    expect(controller.current!.status()).toMatchObject({
      kind: 'saved',
      path: '/actual/AUTH-SOCIAL.json',
    });
  });

  it('adopts a successful revision for the next queued patch', async () => {
    const persist = vi
      .fn<(patch: Patch, expectedRevision: string) => Promise<SaveResult>>()
      .mockResolvedValueOnce({ ok: true, path: '/actual/AUTH-SOCIAL.json', revision: 'rev-2' })
      .mockResolvedValueOnce({ ok: true, path: '/actual/AUTH-SOCIAL.json', revision: 'rev-3' });
    const controller = createRef<DurableController>();
    render(provider(<DurableHarness ref={controller} persist={persist} />));

    act(() => controller.current!.queue({ description: 'first' }));
    await act(async () => {
      expect(await controller.current!.flush()).toBe(true);
    });
    act(() => controller.current!.queue({ description: 'second' }));
    await act(async () => {
      expect(await controller.current!.flush()).toBe(true);
    });

    expect(persist).toHaveBeenNthCalledWith(1, { description: 'first' }, 'rev-1');
    expect(persist).toHaveBeenNthCalledWith(2, { description: 'second' }, 'rev-2');
  });

  it('blocks navigation on conflict and never claims the patch was saved', async () => {
    const persist = vi.fn(async (): Promise<SaveResult> => ({
      ok: false,
      code: 'CONFLICT',
      path: '/actual/AUTH-SOCIAL.json',
      error: 'changed outside Studio',
      preserved: true,
    }));
    const controller = createRef<DurableController>();
    render(provider(<DurableHarness ref={controller} persist={persist} />));

    act(() => controller.current!.queue({ description: 'conflicting' }));
    await act(async () => {
      expect(await controller.current!.push('/doks')).toBe(false);
    });

    expect(routerPush).not.toHaveBeenCalled();
    expect(controller.current!.status()).toMatchObject({
      kind: 'conflict',
      path: '/actual/AUTH-SOCIAL.json',
      message: 'changed outside Studio',
    });
  });

  it('keeps a deferred key A operation from mutating key B state or revision', async () => {
    let resolveA!: (result: SaveResult) => void;
    const persistA = vi.fn(
      () => new Promise<SaveResult>((resolve) => {
        resolveA = resolve;
      }),
    );
    const persistB = vi.fn(async (): Promise<SaveResult> => ({
      ok: true,
      path: '/workspace/B.json',
      revision: 'rev-B-2',
    }));
    const controller = createRef<DurableController>();
    const root = render(
      provider(
        <DurableHarness
          ref={controller}
          persist={persistA}
          saveKey="A"
          path="/workspace/A.json"
          initialRevision="rev-A-1"
        />,
      ),
    );

    let flushA!: Promise<boolean>;
    act(() => {
      controller.current!.queue({ description: 'patch A' });
      flushA = controller.current!.flush();
    });
    expect(persistA).toHaveBeenCalledWith({ description: 'patch A' }, 'rev-A-1');

    act(() => {
      root.render(
        provider(
          <DurableHarness
            ref={controller}
            persist={persistB}
            saveKey="B"
            path="/workspace/B.json"
            initialRevision="rev-B-1"
          />,
        ),
      );
    });
    act(() => controller.current!.queue({ description: 'patch B' }));
    expect(controller.current!.status()).toEqual({
      kind: 'dirty',
      path: '/workspace/B.json',
    });
    expect(controller.current!.pendingPath()).toBe('/workspace/B.json');

    await act(async () => {
      resolveA({ ok: true, path: '/workspace/A.json', revision: 'rev-A-2' });
      expect(await flushA).toBe(true);
    });

    expect(persistB).not.toHaveBeenCalled();
    expect(controller.current!.status()).toEqual({
      kind: 'dirty',
      path: '/workspace/B.json',
    });
    expect(controller.current!.pendingPath()).toBe('/workspace/B.json');

    await act(async () => {
      expect(await controller.current!.flush()).toBe(true);
    });
    expect(persistB).toHaveBeenCalledOnce();
    expect(persistB).toHaveBeenCalledWith({ description: 'patch B' }, 'rev-B-1');
    expect(controller.current!.status()).toEqual({
      kind: 'saved',
      path: '/workspace/B.json',
    });
  });

  it('unregisters only the pending registration owned by the unmounting hook', () => {
    const persist = vi.fn(async (): Promise<SaveResult> => ({
      ok: true,
      path: '/workspace/A.json',
      revision: 'rev-A-2',
    }));
    const durable = createRef<DurableController>();
    const pending = createRef<PendingController>();
    const root = render(
      provider(
        <>
          <PendingHarness ref={pending} />
          <DurableHarness
            ref={durable}
            persist={persist}
            saveKey="A"
            path="/workspace/A.json"
            initialRevision="rev-A-1"
          />
        </>,
      ),
    );
    act(() => durable.current!.queue({ description: 'owned by A' }));
    expect(pending.current!.pendingPath()).toBe('/workspace/A.json');

    act(() => root.render(provider(<PendingHarness ref={pending} />)));
    expect(pending.current!.pendingPath()).toBeNull();

    act(() => {
      root.render(
        provider(
          <>
            <PendingHarness ref={pending} />
            <DurableHarness
              ref={durable}
              persist={persist}
              saveKey="A2"
              path="/workspace/A2.json"
              initialRevision="rev-A2-1"
            />
          </>,
        ),
      );
    });
    act(() => durable.current!.queue({ description: 'owned by A2' }));
    act(() => pending.current!.register('/workspace/B.json', async () => true));
    act(() => root.render(provider(<PendingHarness ref={pending} />)));

    expect(pending.current!.pendingPath()).toBe('/workspace/B.json');
  });
});

describe('SaveGuard', () => {
  it('guards browser exit while a save is pending', () => {
    const controller = createRef<PendingController>();
    render(
      provider(
        <>
          <PendingHarness ref={controller} />
          <SaveGuard />
        </>,
      ),
    );
    act(() => controller.current!.register('/workspace/pending.json', async () => true));

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('flushes one time for concurrent same-origin clicks and navigates only after success', async () => {
    let finish!: (saved: boolean) => void;
    const flush = vi.fn(
      () => new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = createRef<PendingController>();
    render(
      provider(
        <>
          <PendingHarness ref={controller} />
          <SaveGuard />
          <a href="/doks">Doks</a>
          <a href="/roles">Roles</a>
        </>,
      ),
    );
    act(() => controller.current!.register('/workspace/pending.json', flush));
    const [first, second] = [...document.querySelectorAll('a')];

    act(() => {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();

    await act(async () => finish(true));
    expect(routerPush).toHaveBeenCalledOnce();
    expect(routerPush).toHaveBeenCalledWith('/doks');
  });

  it('preserves a bare download link without flushing or routing', () => {
    const flush = vi.fn(async () => true);
    const controller = createRef<PendingController>();
    render(
      provider(
        <>
          <PendingHarness ref={controller} />
          <SaveGuard />
          <a href="/export.json" download>
            Download
          </a>
        </>,
      ),
    );
    act(() => controller.current!.register('/workspace/pending.json', flush));
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    act(() => document.querySelector('a')!.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(flush).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('does not navigate when a captured-link flush fails', async () => {
    const controller = createRef<PendingController>();
    render(
      provider(
        <>
          <PendingHarness ref={controller} />
          <SaveGuard />
          <a href="/doks">Doks</a>
        </>,
      ),
    );
    act(() => controller.current!.register('/workspace/pending.json', async () => false));

    await act(async () => {
      document.querySelector('a')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(routerPush).not.toHaveBeenCalled();
    expect(controller.current!.status().kind).not.toBe('saved');
  });
});

describe('programmatic navigation consumers', () => {
  it('blocks a keyboard layer switch when the pending flush fails', async () => {
    const flush = vi.fn(async () => false);
    const controller = createRef<PendingController>();
    render(
      provider(
        <>
          <PendingHarness ref={controller} />
          <KeyboardShortcuts />
        </>,
      ),
    );
    act(() => controller.current!.register('/workspace/pending.json', flush));

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('blocks a preview button navigation when the pending flush fails', async () => {
    const flush = vi.fn(async () => false);
    const controller = createRef<PendingController>();
    render(
      <StudioProvider
        layerCounts={{ doks: 1, lexicon: 0, ia: 0, roles: 0 }}
        initialDoks={[authDokJson as Dok]}
      >
        <PendingHarness ref={controller} />
        <DokPreview />
      </StudioProvider>,
    );
    act(() => controller.current!.register('/workspace/pending.json', flush));
    const openButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Open in doks-editor'),
    );
    if (!openButton) throw new Error('Expected the Dok preview navigation button.');

    await act(async () => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('blocks a cross-layer programmatic jump when the pending flush fails', async () => {
    const flush = vi.fn(async () => false);
    const pending = createRef<PendingController>();
    const jump = createRef<JumpController>();
    render(
      provider(
        <>
          <PendingHarness ref={pending} />
          <JumpHarness ref={jump} />
        </>,
      ),
    );
    act(() => pending.current!.register('/workspace/pending.json', flush));

    await act(async () => {
      jump.current!.jumpToDok('AUTH-SOCIAL');
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
    expect(jump.current!.selectedDok()).toBeNull();
    expect(jump.current!.recentCount()).toBe(0);
  });

  it('serializes concurrent navigation attempts from separate consumers', async () => {
    let finish!: (saved: boolean) => void;
    const pendingFlush = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const flush = vi.fn(() => pendingFlush);
    const pending = createRef<PendingController>();
    const jump = createRef<JumpController>();
    render(
      provider(
        <>
          <PendingHarness ref={pending} />
          <KeyboardShortcuts />
          <JumpHarness ref={jump} />
        </>,
      ),
    );
    act(() => pending.current!.register('/workspace/pending.json', flush));

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      jump.current!.jumpToDok('AUTH-SIGNUP');
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(routerPush).toHaveBeenCalledOnce();
    expect(routerPush).toHaveBeenCalledWith('/doks');
    expect(jump.current!.selectedDok()).toBeNull();
    expect(jump.current!.recentCount()).toBe(0);
  });

  it('restores the consolidation service selector when its guarded query push fails', async () => {
    const flush = vi.fn(async () => false);
    const pending = createRef<PendingController>();
    const config: ConsolidatedFeatureConfig = {
      projectName: 'workspace',
      basedOnFeaturesAt: '2026-07-17T00:00:00.000Z',
      generatedAt: '2026-07-17T00:00:00.000Z',
      model: 'test',
      groups: [],
      originalFeatureIds: [],
      userReviewed: false,
      stats: {
        originalFeatures: 0,
        consolidatedFeatures: 0,
        merges: 0,
        excluded: 0,
      },
    };
    render(
      provider(
        <>
          <PendingHarness ref={pending} />
          <ConsolidationBoard
            initialConfig={config}
            initialRevision="web-revision"
            path="/workspace/.doklo/cache/web.consolidated.json"
            services={['web', 'api']}
            activeService="web"
          />
        </>,
      ),
    );
    act(() => pending.current!.register('/workspace/pending.json', flush));
    const select = document.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Expected the consolidation service selector.');

    await act(async () => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(flush).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
    expect(select.value).toBe('web');
  });
});
