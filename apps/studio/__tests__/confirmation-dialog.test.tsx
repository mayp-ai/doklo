// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidatedFeatureConfig } from '../lib/consolidation';
import { ConsolidationBoard } from '../components/consolidation/consolidation-board';
import { ConfirmationDialog } from '../components/confirmation-dialog';
import { SaveGuard } from '../components/save-guard';
import { StudioProvider } from '../components/studio-store';

const { routerPush, saveConsolidated } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  saveConsolidated: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('../lib/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/actions')>()),
  saveConsolidatedAction: saveConsolidated,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

class SilentEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
}

function TypedConfirmationHarness() {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={openerRef} type="button" onClick={() => setOpen(true)}>
        Open typed confirmation
      </button>
      {open ? (
        <ConfirmationDialog
          title="Activate every Draft?"
          description="This affects reviewed context."
          confirmLabel="Activate all"
          cancelLabel="Back"
          confirmDisabled={phrase !== 'ACTIVATE 2'}
          returnFocus={openerRef.current}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        >
          <label>
            Confirmation phrase
            <input
              aria-label="Confirmation phrase"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
            />
          </label>
        </ConfirmationDialog>
      ) : null}
    </>
  );
}

function config(): ConsolidatedFeatureConfig {
  const feature = (
    canonicalId: string,
    label: string,
    prefix: string,
  ): ConsolidatedFeatureConfig['groups'][number]['features'][number] => ({
    canonical_id: canonicalId,
    label,
    decision: 'keep',
    members: [canonicalId],
    primary_route: `/${canonicalId}`,
    reason: 'test fixture',
    user_reviewed: false,
    dok_id_prefix: prefix,
  });
  return {
    projectName: 'workspace',
    basedOnFeaturesAt: '2026-07-17T00:00:00.000Z',
    generatedAt: '2026-07-17T00:00:00.000Z',
    model: 'test',
    groups: [
      {
        group_id: 'auth',
        label: 'Auth group',
        excluded: [],
        features: [
          feature('auth-login', 'Auth feature', 'AUTH'),
          feature('auth-session', 'Session feature', 'SESSION'),
        ],
      },
      {
        group_id: 'catalog',
        label: 'Catalog group',
        excluded: [],
        features: [feature('catalog-list', 'Catalog feature', 'CATALOG')],
      },
    ],
    originalFeatureIds: ['auth-login', 'auth-session', 'catalog-list'],
    userReviewed: false,
    stats: { originalFeatures: 3, consolidatedFeatures: 3, merges: 0, excluded: 0 },
  };
}

function renderBoard(guarded = false) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <StudioProvider layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}>
        {guarded && <SaveGuard />}
        <ConsolidationBoard {...({
            initialConfig: config(),
            services: ['web', 'api'],
            activeService: 'web',
            initialRevision: 'rev-1',
            path: '/workspace/.doklo/cache/web.consolidated.json',
          } as React.ComponentProps<typeof ConsolidationBoard>)} />
        {guarded && <a href="/doks">Open Doks</a>}
      </StudioProvider>,
    );
  });
  return container;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

function buttonOrLinkByText(root: ParentNode, text: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>('button, a')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing control ${text}`);
  return found;
}

function buttonByLabel(root: ParentNode, labels: string[]): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    labels.includes(candidate.getAttribute('aria-label') ?? ''),
  );
  if (!found) throw new Error(`Missing button labelled ${labels.join(' or ')}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function groupCount(container: ParentNode): number {
  return container.querySelectorAll('[data-group]').length;
}

function beforeUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

async function excludeAuthFeature(container: HTMLElement): Promise<void> {
  const authGroup = container.querySelector<HTMLElement>('[data-group="auth"]');
  if (!authGroup) throw new Error('Missing auth group');
  await click(buttonByLabel(authGroup, ['Exclude', 'Exclude Auth feature']));
  await click(buttonByText(dialog() ?? document, 'Exclude Dok'));
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  saveConsolidated.mockResolvedValue({
    ok: true,
    path: '/workspace/.doklo/cache/web.consolidated.json',
    revision: 'rev-2',
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('accessible destructive confirmation', () => {
  it('supports typed form content, localized cancellation, disabled confirmation, and focus return', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<TypedConfirmationHarness />));
    const opener = buttonByText(container, 'Open typed confirmation');

    await click(opener);
    const modal = dialog();
    expect(modal).not.toBeNull();
    expect(buttonByText(modal ?? document, 'Back')).not.toBeNull();
    expect(modal?.querySelector<HTMLInputElement>('input[aria-label="Confirmation phrase"]'))
      .not.toBeNull();
    expect(buttonByText(modal ?? document, 'Activate all').disabled).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not merge before confirmation and provides safe focus, a trap, Escape, and focus restore', async () => {
    const container = renderBoard();
    const groupChecks = [...container.querySelectorAll<HTMLInputElement>('input[aria-label^="Select group"]')];
    await click(groupChecks[0]);
    await click(groupChecks[1]);
    const merge = buttonByText(container, 'Merge selected groups (2)');

    await click(merge);
    expect(groupCount(container)).toBe(2);
    const modal = dialog();
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute('aria-modal')).toBe('true');
    expect(modal?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(modal?.getAttribute('aria-describedby')).toBeTruthy();
    const title = document.getElementById(modal?.getAttribute('aria-labelledby') ?? '');
    const description = document.getElementById(modal?.getAttribute('aria-describedby') ?? '');
    expect(title?.textContent).toContain('Merge');
    expect(description?.textContent).toContain('cannot be undone');

    const cancel = buttonByText(modal ?? document, 'Cancel');
    const confirm = buttonByText(modal ?? document, 'Merge groups');
    expect(document.activeElement).toBe(cancel);

    cancel.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }));
    expect(document.activeElement).toBe(confirm);
    confirm.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(merge);
    expect(groupCount(container)).toBe(2);

    await click(merge);
    await click(buttonByText(dialog() ?? document, 'Merge groups'));
    expect(groupCount(container)).toBe(1);
    expect(document.activeElement).toBe(container.querySelector('h1'));
  });

  it('does not split selected Doks before explicit confirmation', async () => {
    const container = renderBoard();
    const feature = container.querySelector<HTMLInputElement>('input[aria-label="Select Auth feature"]');
    if (!feature) throw new Error('Missing Auth feature selector');
    await click(feature);
    const split = buttonByText(container, 'Split selected Doks (1)');

    await click(split);
    expect(groupCount(container)).toBe(2);
    expect(dialog()).not.toBeNull();
    await click(buttonByText(dialog() ?? document, 'Split Doks'));
    expect(groupCount(container)).toBe(3);
    expect(document.activeElement).toBe(container.querySelector('h1'));
  });

  it('confirms feature exclude and include before either mutation', async () => {
    const container = renderBoard();
    const authGroup = container.querySelector<HTMLElement>('[data-group="auth"]');
    if (!authGroup) throw new Error('Missing auth group');
    const featureRow = authGroup.querySelector('li');
    const exclude = buttonByLabel(authGroup, ['Exclude', 'Exclude Auth feature']);

    await click(exclude);
    expect(featureRow?.className).not.toContain('line-through');
    await click(buttonByText(dialog() ?? document, 'Exclude Dok'));
    expect(featureRow?.className).toContain('line-through');

    const include = buttonByLabel(authGroup, ['Revert', 'Include Auth feature']);
    await click(include);
    expect(featureRow?.className).toContain('line-through');
    await click(buttonByText(dialog() ?? document, 'Include Dok'));
    expect(featureRow?.className).not.toContain('line-through');
  });

  it('confirms group exclude and include before either mutation', async () => {
    const container = renderBoard();
    const authGroup = container.querySelector<HTMLElement>('[data-group="auth"]');
    if (!authGroup) throw new Error('Missing auth group');
    const rows = () => [...authGroup.querySelectorAll('li')];
    const exclude = buttonByLabel(authGroup, ['Exclude entire group']);

    await click(exclude);
    expect(rows().every((row) => row.className.includes('line-through'))).toBe(false);
    await click(buttonByText(dialog() ?? document, 'Exclude group'));
    expect(rows().every((row) => row.className.includes('line-through'))).toBe(true);

    const include = buttonByLabel(authGroup, ['Revert group', 'Include entire group']);
    await click(include);
    expect(rows().every((row) => row.className.includes('line-through'))).toBe(true);
    await click(buttonByText(dialog() ?? document, 'Include group'));
    expect(rows().every((row) => row.className.includes('line-through'))).toBe(false);
  });

  it('does not persist or generate before Save & generate is confirmed', async () => {
    saveConsolidated.mockReturnValue(new Promise(() => {}));
    const container = renderBoard();
    const generate = buttonByText(container, 'Save & generate → (3)');

    await click(generate);
    expect(saveConsolidated).not.toHaveBeenCalled();
    const confirmation = dialog();
    expect(confirmation).not.toBeNull();
    expect(confirmation?.id).not.toBe('');
    expect(generate.getAttribute('aria-controls')).toBe(confirmation?.id);
    await click(buttonByText(confirmation ?? document, 'Save & generate'));
    expect(saveConsolidated).toHaveBeenCalledOnce();
    expect(generate.getAttribute('aria-controls')).toBe('generate-panel-dialog');
  });

  it('restores focus to stable save actions while Save & generate is pending and after failure', async () => {
    let rejectSave!: (cause: Error) => void;
    saveConsolidated.mockReturnValue(new Promise((_resolve, reject) => {
      rejectSave = reject;
    }));
    const container = renderBoard();

    await click(buttonByText(container, 'Save & generate → (3)'));
    await click(buttonByText(dialog() ?? document, 'Save & generate'));

    const saveActions = container.querySelector<HTMLElement>(
      '[aria-label="Consolidation save actions"]',
    );
    expect(saveActions).not.toBeNull();
    expect(saveActions?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(saveActions);

    await act(async () => {
      rejectSave(new Error('generation save transport failed'));
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'generation save transport failed',
    );
    expect(document.activeElement).toBe(saveActions);
    expect(document.querySelector('#generate-panel-dialog')).toBeNull();
  });

  it('keeps newer edits dirty when an older Save & generate snapshot resolves', async () => {
    let resolveSnapshot!: (result: {
      ok: true;
      path: string;
      revision: string;
    }) => void;
    saveConsolidated
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSnapshot = resolve;
      }))
      .mockResolvedValueOnce({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-3',
      });
    const container = renderBoard();
    const authGroup = container.querySelector<HTMLElement>('[data-group="auth"]');
    if (!authGroup) throw new Error('Missing auth group');

    await click(buttonByLabel(authGroup, ['Exclude', 'Exclude Auth feature']));
    await click(buttonByText(dialog() ?? document, 'Exclude Dok'));
    await click(buttonByText(container, 'Save & generate → (2)'));
    await click(buttonByText(dialog() ?? document, 'Save & generate'));
    expect(saveConsolidated).toHaveBeenCalledOnce();

    await click(buttonByLabel(authGroup, ['Revert', 'Include Auth feature']));
    await click(buttonByText(dialog() ?? document, 'Include Dok'));

    await act(async () => {
      resolveSnapshot({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-2',
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('newer edits remain');
    expect(container.textContent).toContain('Unsaved');
    expect(document.querySelector('#generate-panel-dialog')).toBeNull();

    const select = container.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Missing service select');
    await act(async () => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    await click(buttonByText(dialog() ?? document, 'Cancel'));

    await click(buttonByText(container, 'Save'));
    expect(saveConsolidated).toHaveBeenCalledTimes(2);
    expect(saveConsolidated.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 'rev-2',
      config: {
        groups: [
          expect.objectContaining({
            group_id: 'auth',
            features: expect.arrayContaining([
              expect.objectContaining({ canonical_id: 'auth-login', decision: 'keep' }),
            ]),
          }),
          expect.anything(),
        ],
      },
    });
  });

  it('guards dirty and in-flight consolidation from exit and same-origin links until save succeeds', async () => {
    let resolveSave!: (result: {
      ok: true;
      path: string;
      revision: string;
    }) => void;
    saveConsolidated.mockImplementation(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const container = renderBoard(true);
    await excludeAuthFeature(container);

    expect(beforeUnload().defaultPrevented).toBe(true);
    const link = buttonOrLinkByText(container, 'Open Doks');
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(clickEvent));

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(saveConsolidated).toHaveBeenCalledOnce();
    expect(routerPush).not.toHaveBeenCalled();
    expect(beforeUnload().defaultPrevented).toBe(true);

    await act(async () => {
      resolveSave({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-2',
      });
      await Promise.resolve();
    });

    expect(routerPush).toHaveBeenCalledWith('/doks');
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it('keeps the guard after a failed navigation save and releases it only after retry succeeds', async () => {
    saveConsolidated
      .mockResolvedValueOnce({
        ok: false,
        code: 'WRITE_FAILED',
        path: '/workspace/.doklo/cache/web.consolidated.json',
        error: 'permission denied',
        preserved: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-2',
      });
    const container = renderBoard(true);
    await excludeAuthFeature(container);

    await act(async () => {
      buttonOrLinkByText(container, 'Open Doks').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(routerPush).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('permission denied');
    expect(beforeUnload().defaultPrevented).toBe(true);

    await click(buttonByText(container, 'Retry'));

    expect(saveConsolidated).toHaveBeenCalledTimes(2);
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it('flushes an edit made during navigation save before routing', async () => {
    let resolveA!: (result: { ok: true; path: string; revision: string }) => void;
    let resolveB!: (result: { ok: true; path: string; revision: string }) => void;
    saveConsolidated
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const container = renderBoard(true);
    await excludeAuthFeature(container);

    act(() => buttonOrLinkByText(container, 'Open Doks').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    ));
    expect(saveConsolidated).toHaveBeenCalledOnce();

    const authGroup = container.querySelector<HTMLElement>('[data-group="auth"]');
    if (!authGroup) throw new Error('Missing auth group');
    await click(buttonByLabel(authGroup, ['Revert', 'Include Auth feature']));
    await click(buttonByText(dialog() ?? document, 'Include Dok'));

    await act(async () => {
      resolveA({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-2',
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(saveConsolidated).toHaveBeenCalledTimes(2);
    expect(saveConsolidated.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 'rev-2',
      config: {
        groups: expect.arrayContaining([
          expect.objectContaining({
            group_id: 'auth',
            features: expect.arrayContaining([
              expect.objectContaining({ canonical_id: 'auth-login', decision: 'keep' }),
            ]),
          }),
        ]),
      },
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(beforeUnload().defaultPrevented).toBe(true);

    await act(async () => {
      resolveB({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-3',
      });
      await Promise.resolve();
    });

    expect(routerPush).toHaveBeenCalledWith('/doks');
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it('truthfully saves dirty consolidation before switching service', async () => {
    let resolveSave!: (result: {
      ok: true;
      path: string;
      revision: string;
    }) => void;
    saveConsolidated.mockImplementation(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
    const container = renderBoard();
    const authGroup = container.querySelector<HTMLElement>('[data-group="auth"]');
    if (!authGroup) throw new Error('Missing auth group');
    await click(buttonByLabel(authGroup, ['Exclude', 'Exclude Auth feature']));
    const excludeDialog = dialog();
    expect(excludeDialog).not.toBeNull();
    if (!excludeDialog) return;
    await click(buttonByText(excludeDialog, 'Exclude Dok'));

    const select = container.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Missing service select');
    await act(async () => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(select.value).toBe('web');
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Save changes and switch to api?');
    expect(dialog()?.textContent).toContain('only switch after the save succeeds');
    await click(buttonByText(dialog() ?? document, 'Save and switch service'));

    expect(saveConsolidated).toHaveBeenCalledOnce();
    expect(saveConsolidated.mock.calls[0]?.[0]).toMatchObject({
      serviceId: 'web',
      expectedRevision: 'rev-1',
      config: {
        groups: expect.arrayContaining([
          expect.objectContaining({
            group_id: 'auth',
            features: expect.arrayContaining([
              expect.objectContaining({ canonical_id: 'auth-login', decision: 'exclude' }),
            ]),
          }),
        ]),
      },
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(select.value).toBe('web');

    await act(async () => {
      resolveSave({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-2',
      });
      await Promise.resolve();
    });

    expect(routerPush).toHaveBeenCalledWith('?service=api');
  });

  it('blocks a dirty service switch after save failure and preserves error retry', async () => {
    saveConsolidated
      .mockResolvedValueOnce({
        ok: false,
        code: 'WRITE_FAILED',
        path: '/workspace/.doklo/cache/web.consolidated.json',
        error: 'service switch save denied',
        preserved: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        path: '/workspace/.doklo/cache/web.consolidated.json',
        revision: 'rev-2',
      });
    const container = renderBoard();
    await excludeAuthFeature(container);
    const select = container.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Missing service select');

    await act(async () => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await click(buttonByText(dialog() ?? document, 'Save and switch service'));

    expect(routerPush).not.toHaveBeenCalled();
    expect(select.value).toBe('web');
    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain('/workspace/.doklo/cache/web.consolidated.json');
    expect(alert?.textContent).toContain('service switch save denied');
    expect(buttonByText(alert ?? container, 'Retry').disabled).toBe(false);

    await click(buttonByText(alert ?? container, 'Retry'));
    expect(saveConsolidated).toHaveBeenCalledTimes(2);
    expect(routerPush).not.toHaveBeenCalled();
    expect(select.value).toBe('web');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the reusable dialog source free of window.confirm and exposes the required semantics', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'components/confirmation-dialog.tsx'),
      'utf-8',
    ).catch(() => '');
    const board = await readFile(
      resolve(process.cwd(), 'components/consolidation/consolidation-board.tsx'),
      'utf-8',
    );

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(board).not.toContain('window.confirm');
  });
});
