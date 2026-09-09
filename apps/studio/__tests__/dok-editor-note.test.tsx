// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dok, Workspace } from '@doklo-beta/core';
import type { DokCatalogData, LoadState } from '../lib/load-state';
import { StudioProvider, useStudio } from '../components/studio-store';
import { DokEditor } from '../components/dok-editor';
import authDokJson from '../demo/.doklo/hub/doks/AUTH-SOCIAL.json';

const actions = vi.hoisted(() => ({
  saveDok: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('../lib/actions', () => ({
  saveDokAction: actions.saveDok,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: actions.routerPush, refresh: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const dok = authDokJson as Dok;
const dokPath = `/workspace/.doklo/hub/doks/${dok.dok_id}.json`;

const workspaceState: LoadState<Workspace> = {
  kind: 'ready',
  path: '/workspace/workspace.json',
  revision: 'workspace-revision',
  data: {
    workspace_id: 'test-workspace',
    name: 'Workspace',
    default_locale: 'en',
    supported_locales: ['en', 'ko'],
    services: [],
  } as Workspace,
};
const doksState: LoadState<DokCatalogData> = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/doks',
  revision: 'catalog-revision',
  data: {
    doks: [dok],
    revisions: { [dok.dok_id]: 'dok-revision' },
    paths: { [dok.dok_id]: dokPath },
  },
};

const roots: Root[] = [];

function SeedDok({ value = dok }: { value?: Dok }) {
  const { setEditingDok } = useStudio();
  useEffect(() => setEditingDok(value), [setEditingDok, value]);
  return <DokEditor />;
}

function provider(child: ReactNode) {
  return (
    <StudioProvider
      layerCounts={{ doks: 1, lexicon: 0, ia: 0, roles: 0 }}
      workspaceState={workspaceState}
      doksState={doksState}
      initialDoks={[dok]}
      projectLocales={['en', 'ko']}
    >
      {child}
    </StudioProvider>
  );
}

function render(child: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(provider(child)));
  return container;
}

async function change(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      'value',
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Expected button "${label}".`);
  return found;
}

function noteInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[name="change-note"]');
  if (!input) throw new Error('Expected the change-note input.');
  return input;
}

function categorySelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>(
    'select[name="change-category"]',
  );
  if (!select) throw new Error('Expected the change-category select.');
  return select;
}

async function expandMeta(container: HTMLElement) {
  const toggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.includes('_meta'),
  );
  if (!toggle) throw new Error('Expected the _meta toggle.');
  await act(async () => toggle.click());
}

beforeEach(() => {
  document.body.replaceChildren();
  for (const action of Object.values(actions)) action.mockReset();
  actions.saveDok.mockResolvedValue({
    ok: true,
    path: dokPath,
    revision: 'dok-revision-2',
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('Dok change note', () => {
  it('sends the trimmed note and its category with the save, then clears both inputs', async () => {
    const draftDok = { ...dok, status: 'draft' as const };
    const container = render(<SeedDok value={draftDok} />);
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Dok name"]');
    if (!name) throw new Error('Expected the Dok name input.');

    await change(name, 'Social sign-in');
    await change(noteInput(container), '   Added Kakao login   ');
    await change(categorySelect(container), 'added');

    await act(async () => {
      button(container, 'Save').click();
      await Promise.resolve();
    });

    expect(actions.saveDok).toHaveBeenCalledOnce();
    expect(actions.saveDok).toHaveBeenCalledWith(
      expect.objectContaining({
        dokId: 'AUTH-SOCIAL',
        expectedRevision: 'dok-revision',
        note: 'Added Kakao login',
        category: 'added',
      }),
    );
    expect(noteInput(container).value).toBe('');
    expect(categorySelect(container).value).toBe('');
  });

  it('describes the note field without demanding one', () => {
    const container = render(<SeedDok />);
    const input = noteInput(container);

    expect(input.placeholder).toBe('What changed? (optional)');
    expect(input.maxLength).toBe(500);
    expect(categorySelect(container).getAttribute('aria-label')).toBe('Change category');
    expect([...categorySelect(container).options].map((option) => option.value)).toEqual([
      '', 'added', 'fixed', 'security', 'deprecated', 'removed',
    ]);
    expect(categorySelect(container).options[0]?.textContent).toBe('Changed');
  });

  it('enables a note-only save and sends it with an empty patch', async () => {
    const container = render(<SeedDok />);

    expect(button(container, 'Saved').disabled).toBe(true);
    await change(noteInput(container), 'Documented what the regeneration did');
    const save = button(container, 'Save');
    expect(save.disabled).toBe(false);

    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(actions.saveDok).toHaveBeenCalledOnce();
    expect(actions.saveDok).toHaveBeenCalledWith({
      dokId: 'AUTH-SOCIAL',
      patch: {},
      expectedRevision: 'dok-revision',
      note: 'Documented what the regeneration did',
    });
    expect(noteInput(container).value).toBe('');
  });

  it('leaves the note out of the save when only whitespace was typed', async () => {
    const draftDok = { ...dok, status: 'draft' as const };
    const container = render(<SeedDok value={draftDok} />);
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Dok name"]');
    if (!name) throw new Error('Expected the Dok name input.');

    await change(name, 'Social sign-in');
    await change(noteInput(container), '    ');

    await act(async () => {
      button(container, 'Save').click();
      await Promise.resolve();
    });

    expect(actions.saveDok).toHaveBeenCalledWith({
      dokId: 'AUTH-SOCIAL',
      patch: { name: 'Social sign-in' },
      expectedRevision: 'dok-revision',
    });
  });
});

describe('Dok history rows', () => {
  const historyDok = {
    ...dok,
    _meta: {
      ...dok._meta,
      version: 5,
      history: [
        {
          version: 3,
          date: '2026-08-01',
          change: 'Kakao 추가',
          kind: 'edited' as const,
          category: 'added' as const,
        },
        {
          version: 3,
          date: '2026-08-02',
          change: 'Marked reviewed',
          kind: 'status' as const,
          from: 'draft' as const,
          to: 'active' as const,
        },
        {
          version: 5,
          date: '2026-08-03',
          change: 'Regenerated from code',
          kind: 'regenerated' as const,
          author: 'pumpa',
        },
      ],
    },
  } as Dok;

  it('renders repeated history versions without a duplicate React key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = render(<SeedDok value={historyDok} />);
    await expandMeta(container);

    const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
    errors.mockRestore();

    expect(logged).not.toContain('same key');
    expect(container.textContent).toContain(
      'v3 · 2026-08-02 · status · draft → active · Marked reviewed',
    );
    expect(container.textContent).toContain(
      'v3 · 2026-08-01 · edited · added · Kakao 추가',
    );
    expect(container.textContent).toContain(
      'v5 · 2026-08-03 · regenerated · Regenerated from code · @pumpa',
    );
  });

  it('reads a history entry with no kind as an edit', async () => {
    const container = render(<SeedDok />);
    await expandMeta(container);

    expect(container.textContent).toContain('v1 · 2026-03-12 · edited · 초기 구현 (Google만)');
  });
});

describe('staged change proposal', () => {
  const proposedDok = {
    ...dok,
    _meta: {
      ...dok._meta,
      pending_change: {
        summary: 'Regenerated: 2 steps added, 1 rule changed',
        source: 'diff' as const,
        base_version: 3,
        previous_status: 'active' as const,
      },
    },
  } as Dok;

  it('shows the staged proposal and says a typed note overrides it', async () => {
    const container = render(<SeedDok value={proposedDok} />);
    const proposal = container.querySelector('[data-testid="pending-proposal"]');
    if (!proposal) throw new Error('Expected the staged proposal line.');

    expect(proposal.textContent).toContain(
      'Proposed: Regenerated: 2 steps added, 1 rule changed',
    );
    expect(proposal.textContent).toContain(
      'Recorded to history when you activate — your note overrides it.',
    );

    await expandMeta(container);
    expect(container.textContent).toContain(
      'pending: Regenerated: 2 steps added, 1 rule changed (diff)',
    );
  });

  it('shows nothing when no proposal is staged', async () => {
    const container = render(<SeedDok />);

    expect(container.querySelector('[data-testid="pending-proposal"]')).toBeNull();
    await expandMeta(container);
    expect(container.textContent).not.toContain('pending:');
  });
});
