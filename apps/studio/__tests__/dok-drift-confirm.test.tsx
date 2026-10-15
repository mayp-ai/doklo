// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dok, LexiconFile, RolesFile, Workspace } from '@doklo-beta/core';
import {
  DokDriftConfirmBar,
  DokDriftConfirmEntry,
  useDokDriftConfirmController,
} from '../components/dok-drift-confirm';
import { StudioProvider } from '../components/studio-store';
import DokCatalogPage from '../app/(hub)/doks/page';
import type { DokDriftView } from '../lib/dok-drift';
import type { DokCatalogData, LoadState } from '../lib/load-state';

const mocks = vi.hoisted(() => ({
  readDoksDrift: vi.fn(),
  bulkConfirm: vi.fn(),
  bulkActivate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../lib/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/actions')>()),
  readDoksDriftAction: mocks.readDoksDrift,
  bulkConfirmDoksStillAccurateAction: mocks.bulkConfirm,
  bulkActivateDoksAction: mocks.bulkActivate,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function dok(dokId: string, status: Dok['status']): Dok {
  return {
    dok_id: dokId,
    name: `${dokId} name`,
    status,
    tags: [],
    surfaces: ['web'],
    description: `${dokId} description`,
    _meta: { version: 1, history: [] },
  } as Dok;
}

// Catalog order: PAGE, ROWS, TRACK, FRESH.
const doks = [
  dok('PAGE', 'draft'),
  dok('ROWS', 'active'),
  dok('TRACK', 'active'),
  dok('FRESH', 'active'),
];
const revisions: Record<string, string> = {
  PAGE: 'a'.repeat(64),
  ROWS: 'b'.repeat(64),
  TRACK: 'c'.repeat(64),
  FRESH: 'd'.repeat(64),
};

function staleEntry(dokId: string, overrides: Partial<DokDriftView> = {}): DokDriftView {
  return {
    dokId,
    revision: revisions[dokId] ?? 'e'.repeat(64),
    drift: { stale: true, reason: 'changed' },
    verdict: null,
    blocked: null,
    ...overrides,
  };
}

const STALE = [
  staleEntry('PAGE'),
  staleEntry('ROWS', {
    verdict: { model: 'anthropic/claude-sonnet-5', summary: 'Still holds.', checked: [] },
  }),
  staleEntry('TRACK', {
    drift: { stale: true, reason: 'tracking-expanded' },
    blocked: 'TRACKING_REVIEW_REQUIRED',
  }),
];

const roots: Root[] = [];

function Harness({ onModeChange }: { onModeChange?: (active: boolean) => void }) {
  const controller = useDokDriftConfirmController({
    doks,
    revisions,
    locale: 'en',
    onModeChange,
  });
  return (
    <div>
      <DokDriftConfirmEntry controller={controller} />
      <DokDriftConfirmBar controller={controller} />
      {doks.map((item) => (
        <div key={item.dok_id} data-row={item.dok_id}>
          {item.dok_id}
          {controller.entries.has(item.dok_id) ? <span>stale</span> : null}
          {controller.confirmableIds.has(item.dok_id) ? (
            <input
              type="checkbox"
              aria-label={controller.copy.selectToConfirm(item.dok_id)}
              checked={controller.selectedIds.has(item.dok_id)}
              onChange={() => controller.toggleDok(item.dok_id)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  await settle();
  return container;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

function confirmBox(root: ParentNode, dokId: string): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(
    `input[aria-label="Select ${dokId} to confirm still accurate"]`,
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

beforeEach(() => {
  document.body.replaceChildren();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.readDoksDrift.mockResolvedValue({ ok: true, stale: STALE });
  mocks.bulkConfirm.mockResolvedValue({
    ok: true,
    confirmed: [
      { dokId: 'PAGE', revision: 'f'.repeat(64) },
      { dokId: 'ROWS', revision: '0'.repeat(64) },
    ],
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('bulk "Still accurate" controls', () => {
  it('opens on the stale Doks a source read found; only the confirmable ones are selectable', async () => {
    const onModeChange = vi.fn();
    const container = await render(<Harness onModeChange={onModeChange} />);
    expect(container.querySelector('[data-testid="dok-drift-confirm-bar"]')).toBeNull();
    expect(mocks.readDoksDrift).not.toHaveBeenCalled();

    await click(buttonByText(container, 'Confirm stale Doks'));

    expect(mocks.readDoksDrift).toHaveBeenCalledOnce();
    expect(onModeChange).toHaveBeenLastCalledWith(true);
    const bar = container.querySelector<HTMLElement>('[data-testid="dok-drift-confirm-bar"]');
    if (!bar) throw new Error('Missing confirm bar.');
    // The one warning line: a person's judgement, recorded only as hashes.
    const warning = document.getElementById(bar.getAttribute('aria-labelledby') ?? '');
    expect(warning?.textContent).toBe(
      'Confirming is a person’s judgement that each Dok still matches its code. Doklo keeps no record of it other than the re-stamped source hashes.',
    );
    expect(confirmBox(container, 'PAGE')).not.toBeNull();
    expect(confirmBox(container, 'ROWS')).not.toBeNull();
    // Stale, but its recovered tracking still needs review: listed, not selectable.
    expect(container.querySelector('[data-row="TRACK"]')?.textContent).toContain('stale');
    expect(confirmBox(container, 'TRACK')).toBeNull();
    expect(confirmBox(container, 'FRESH')).toBeNull();
    expect(buttonByText(bar, 'Confirm 0 still accurate').disabled).toBe(true);
  });

  it('confirms the selection against the loaded revisions, in catalog order', async () => {
    const onModeChange = vi.fn();
    const container = await render(<Harness onModeChange={onModeChange} />);
    await click(buttonByText(container, 'Confirm stale Doks'));

    const rows = confirmBox(container, 'ROWS');
    const page = confirmBox(container, 'PAGE');
    if (!rows || !page) throw new Error('Missing checkboxes.');
    await click(rows);
    await click(page);
    await click(buttonByText(container, 'Confirm 2 still accurate'));

    expect(mocks.bulkConfirm).toHaveBeenCalledWith({
      targets: [
        { dokId: 'PAGE', expectedRevision: revisions.PAGE },
        { dokId: 'ROWS', expectedRevision: revisions.ROWS },
      ],
    });
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('2 Doks confirmed still accurate');
    expect(container.querySelector('[data-testid="dok-drift-confirm-bar"]')).toBeNull();
    expect(onModeChange).toHaveBeenLastCalledWith(false);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('selects and clears every confirmable Dok with one control', async () => {
    const container = await render(<Harness />);
    await click(buttonByText(container, 'Confirm stale Doks'));
    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all stale Doks"]',
    );
    if (!selectAll) throw new Error('Missing select-all.');

    await click(selectAll);
    expect(confirmBox(container, 'PAGE')?.checked).toBe(true);
    expect(confirmBox(container, 'ROWS')?.checked).toBe(true);
    expect(container.textContent).toContain('Confirm 2 still accurate');

    await click(selectAll);
    expect(confirmBox(container, 'PAGE')?.checked).toBe(false);
    expect(confirmBox(container, 'ROWS')?.checked).toBe(false);
  });

  it('reports a partial failure and keeps only the failed Doks selected', async () => {
    mocks.bulkConfirm.mockResolvedValueOnce({
      ok: false,
      code: 'PARTIAL_FAILURE',
      error: '1 Dok(s) could not be confirmed.',
      confirmed: [{ dokId: 'PAGE', revision: 'f'.repeat(64) }],
      failures: [{ dokId: 'ROWS', code: 'WRITE_FAILED', error: 'permission denied', preserved: true }],
    });
    const container = await render(<Harness />);
    await click(buttonByText(container, 'Confirm stale Doks'));
    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all stale Doks"]',
    );
    if (!selectAll) throw new Error('Missing select-all.');
    await click(selectAll);
    await click(buttonByText(container, 'Confirm 2 still accurate'));

    expect(container.querySelector('[role="status"]')?.textContent).toContain('1 confirmed; 1 failed');
    // The confirmed Dok is fresh now: it cannot be picked again.
    expect(confirmBox(container, 'PAGE')).toBeNull();
    expect(confirmBox(container, 'ROWS')?.checked).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the selection and offers a reload after a refused preflight', async () => {
    mocks.bulkConfirm.mockResolvedValueOnce({
      ok: false,
      code: 'PREFLIGHT_FAILED',
      error: '1 Dok(s) failed confirmation preflight.',
      confirmed: [],
      failures: [{ dokId: 'ROWS', code: 'CONFLICT', error: 'changed', preserved: true }],
    });
    const container = await render(<Harness />);
    await click(buttonByText(container, 'Confirm stale Doks'));
    const rows = confirmBox(container, 'ROWS');
    if (!rows) throw new Error('Missing checkbox.');
    await click(rows);
    await click(buttonByText(container, 'Confirm 1 still accurate'));

    expect(confirmBox(container, 'ROWS')?.checked).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain('The Doks or their sources changed. Reload Doks before retrying.');
    expect(mocks.refresh).not.toHaveBeenCalled();
    await click(buttonByText(container, 'Reload'));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('says so when nothing is stale, without opening the mode', async () => {
    mocks.readDoksDrift.mockResolvedValueOnce({ ok: true, stale: [] });
    const onModeChange = vi.fn();
    const container = await render(<Harness onModeChange={onModeChange} />);

    await click(buttonByText(container, 'Confirm stale Doks'));

    expect(container.querySelector('[data-testid="dok-drift-confirm-bar"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'No stale Doks — every tracked source matches its Dok or changed in form only.',
    );
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('reports a failed source read with reload guidance', async () => {
    mocks.readDoksDrift.mockRejectedValueOnce(new Error('Server action not found'));
    const container = await render(<Harness />);

    await click(buttonByText(container, 'Confirm stale Doks'));

    expect(container.querySelector('[data-testid="dok-drift-confirm-bar"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Could not check the Doks’ sources. Reload Doks and try again.',
    );
    expect(buttonByText(container, 'Reload')).toBeTruthy();
  });
});

describe('Doks list wiring', () => {
  const workspaceState: LoadState<Workspace> = {
    kind: 'ready',
    path: '/workspace/workspace.json',
    revision: 'workspace-revision',
    data: {
      workspace_id: 'atlas',
      name: 'Atlas',
      default_locale: 'en',
      supported_locales: ['en'],
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
    },
  };
  const doksState: LoadState<DokCatalogData> = {
    kind: 'ready',
    path: '/workspace/.doklo/hub/doks',
    revision: 'doks',
    data: {
      doks,
      revisions,
      paths: Object.fromEntries(doks.map((item) => [
        item.dok_id,
        `/workspace/.doklo/hub/doks/${item.dok_id}.json`,
      ])),
    },
  };
  const lexiconState: LoadState<LexiconFile> = {
    kind: 'empty',
    path: '/workspace/.doklo/hub/lexicon.json',
    revision: 'lexicon',
    data: { version: 1, terms: [] },
  };
  const rolesState: LoadState<RolesFile> = {
    kind: 'empty',
    path: '/workspace/.doklo/hub/roles.json',
    revision: 'roles',
    data: { version: 1, roles: [] },
  };

  function page() {
    return render(
      <StudioProvider
        layerCounts={{ doks: doks.length, lexicon: 0, ia: 0, roles: 0 }}
        workspaceState={workspaceState}
        doksState={doksState}
        lexiconState={lexiconState}
        rolesState={rolesState}
      >
        <DokCatalogPage />
      </StudioProvider>,
    );
  }

  function chip(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
      .find((candidate) => candidate.textContent?.startsWith(label));
    if (!found) throw new Error(`Missing filter chip ${label}`);
    return found;
  }

  it('opens beside "Review Doks", shows every status with stale tags, and restores the filter on cancel', async () => {
    const container = await page();
    await click(chip(container, 'Draft'));
    expect(chip(container, 'Draft').getAttribute('aria-pressed')).toBe('true');

    const entry = buttonByText(container, 'Confirm stale Doks');
    expect(entry.parentElement?.contains(buttonByText(container, 'Review Doks'))).toBe(true);
    await click(entry);

    // A stale Dok can have any status, so the mode lists them all.
    expect(chip(container, 'All').getAttribute('aria-pressed')).toBe('true');
    const rowsRow = container.querySelector<HTMLElement>('[data-row-id="ROWS"]');
    expect(rowsRow?.textContent).toContain('Stale · code changed');
    expect(rowsRow?.textContent).toContain('Judge: still accurate');
    expect(container.querySelector('[data-row-id="TRACK"]')?.textContent)
      .toContain('Stale · tracking review');
    expect(confirmBox(container, 'ROWS')).not.toBeNull();
    expect(confirmBox(container, 'TRACK')).toBeNull();
    expect(container.querySelector('[data-row-id="FRESH"]')?.textContent).not.toContain('Stale');

    await click(buttonByText(container, 'Cancel'));
    expect(container.querySelector('[data-testid="dok-drift-confirm-bar"]')).toBeNull();
    expect(chip(container, 'Draft').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).not.toContain('Stale · code changed');
  });

  it('closes confirm mode when review opens, and review hands back the filter from before both', async () => {
    const container = await page();
    await click(chip(container, 'Active'));
    await click(buttonByText(container, 'Confirm stale Doks'));
    expect(confirmBox(container, 'ROWS')).not.toBeNull();

    await click(buttonByText(container, 'Review Doks'));

    expect(container.querySelector('[data-testid="dok-drift-confirm-bar"]')).toBeNull();
    expect(confirmBox(container, 'ROWS')).toBeNull();
    expect(chip(container, 'Draft').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('input[aria-label="Select PAGE for review"]')).not.toBeNull();

    await click(buttonByText(container, 'Cancel review'));
    expect(chip(container, 'Active').getAttribute('aria-pressed')).toBe('true');
  });
});
