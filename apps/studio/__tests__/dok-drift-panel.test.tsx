// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Dok,
  LexiconFile,
  RolesFile,
  Workspace,
} from '@doklo-beta/core';
import { DokDriftPanel } from '../components/dok-drift-panel';
import { DokEditor } from '../components/dok-editor';
import { StudioProvider, useStudio } from '../components/studio-store';
import {
  ENGLISH_DOK_DRIFT_COPY,
  KOREAN_DOK_DRIFT_COPY,
  dokDriftCopy,
} from '../lib/dok-drift-copy';
import type { DokDriftView, DokJudgeVerdict } from '../lib/dok-drift';
import type { DokCatalogData, LoadState } from '../lib/load-state';
import authDokJson from '../demo/.doklo/hub/doks/AUTH-SOCIAL.json';

const mocks = vi.hoisted(() => ({
  readDrift: vi.fn(),
  confirm: vi.fn(),
  saveDok: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../lib/actions', () => ({
  readDokDriftAction: mocks.readDrift,
  confirmDokStillAccurateAction: mocks.confirm,
  saveDokAction: mocks.saveDok,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const REVISION = 'a'.repeat(64);
const VERDICT: DokJudgeVerdict = {
  model: 'anthropic/claude-sonnet-5',
  summary: 'The Dok never states a page size, so it still holds.',
  checked: [{
    claimPath: 'business_rules.rules[0].description',
    files: ['src/rows.ts', 'src/lib/paging.ts'],
    reason: 'The ten-row limit is unchanged.',
  }],
};

function view(overrides: Partial<DokDriftView> = {}): { ok: true } & DokDriftView {
  return {
    ok: true,
    dokId: 'ROWS',
    revision: REVISION,
    drift: { stale: true, reason: 'changed' },
    verdict: null,
    blocked: null,
    ...overrides,
  };
}

const roots: Root[] = [];

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

function panel(
  props: Partial<{ revision: string; locale: string; editsPending: boolean }> = {},
) {
  return render(
    <DokDriftPanel
      dokId="ROWS"
      revision={props.revision ?? REVISION}
      locale={props.locale ?? 'en'}
      editsPending={props.editsPending ?? false}
    />,
  );
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  mocks.readDrift.mockResolvedValue(view());
  mocks.confirm.mockResolvedValue({
    ok: true,
    dokId: 'ROWS',
    path: '/workspace/.doklo/hub/doks/ROWS.json',
    revision: 'b'.repeat(64),
    drift: { stale: false, reason: 'format-only' },
    stamped: { logic_hash_normalized: 'ts-tree-v1+ts5.6.3:abc', source_commit: null, files: 1 },
    judgeCacheRemoved: true,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('Dok drift copy', () => {
  it('keeps English and Korean copy structurally aligned with English fallback', () => {
    expect(dokDriftCopy('fr')).toBe(ENGLISH_DOK_DRIFT_COPY);
    expect(dokDriftCopy('ko-KR')).toBe(KOREAN_DOK_DRIFT_COPY);
    expect(Object.keys(KOREAN_DOK_DRIFT_COPY)).toEqual(Object.keys(ENGLISH_DOK_DRIFT_COPY));
    expect(ENGLISH_DOK_DRIFT_COPY.confirm).toBe('Still accurate');
    expect(KOREAN_DOK_DRIFT_COPY.confirm).toBe('여전히 맞다');
    expect(KOREAN_DOK_DRIFT_COPY.verdictTitle).toBe('판사 확인: 그대로 맞음');
    expect(ENGLISH_DOK_DRIFT_COPY.bulkWarning).toContain('person’s judgement');
    expect(ENGLISH_DOK_DRIFT_COPY.bulkWarning).toContain('re-stamped source hashes');
    expect(KOREAN_DOK_DRIFT_COPY.bulkWarning).toContain('다시 찍힌 소스 해시');
  });
});

describe('Dok drift panel', () => {
  it('stays out of the way while the Dok is fresh', async () => {
    mocks.readDrift.mockResolvedValue(view({ drift: { stale: false, reason: 'format-only' } }));
    const container = await panel();

    expect(mocks.readDrift).toHaveBeenCalledWith({ dokId: 'ROWS' });
    expect(container.querySelector('[data-testid="dok-drift-panel"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the drift read fails', async () => {
    mocks.readDrift.mockRejectedValueOnce(new Error('Server action not found'));
    const failedCall = await panel();
    expect(failedCall.textContent).toBe('');

    mocks.readDrift.mockResolvedValueOnce({
      ok: false,
      code: 'UNREADABLE',
      path: '/workspace/workspace.json',
      error: 'unreadable',
    });
    const failedRead = await panel();
    expect(failedRead.textContent).toBe('');
  });

  it('says why the Dok is stale, points regeneration at doklo sync, and offers one button', async () => {
    const container = await panel();
    const section = container.querySelector<HTMLElement>('[data-testid="dok-drift-panel"]');
    if (!section) throw new Error('Missing drift panel.');

    expect(section.getAttribute('aria-label')).toBe('Source drift');
    expect(section.textContent).toContain(
      'The code this Dok tracks changed since it was generated or last confirmed.',
    );
    expect(section.textContent).toContain('A tracked source file changed.');
    expect(section.textContent).toContain('Regeneration happens with `doklo sync`.');
    expect([...section.querySelectorAll('button')].map((button) => button.textContent))
      .toEqual(['Still accurate']);
    expect(buttonByText(section, 'Still accurate').disabled).toBe(false);
    expect(section.querySelector('[data-testid="dok-drift-verdict"]')).toBeNull();
    expect(section.textContent).not.toMatch(/regenerate now/i);
  });

  it('shows the judge’s unconfirmed verdict with the claims and files it checked', async () => {
    mocks.readDrift.mockResolvedValue(view({ verdict: VERDICT }));
    const container = await panel();
    const verdict = container.querySelector<HTMLElement>('[data-testid="dok-drift-verdict"]');
    if (!verdict) throw new Error('Missing verdict.');

    expect(verdict.textContent).toContain('Judge check: still accurate');
    expect(verdict.textContent).toContain('by anthropic/claude-sonnet-5');
    expect(verdict.textContent).toContain(VERDICT.summary);
    expect(verdict.textContent).toContain('Unconfirmed — the judge’s opinion, not a review.');
    expect(verdict.textContent).toContain('What the judge checked');
    const codes = [...verdict.querySelectorAll('code')].map((node) => node.textContent);
    expect(codes).toEqual([
      'business_rules.rules[0].description',
      'src/rows.ts',
      'src/lib/paging.ts',
    ]);
    expect(verdict.textContent).toContain('The ten-row limit is unchanged.');
    // The verdict informs the person; it never stands in for the button.
    expect(buttonByText(container, 'Still accurate').disabled).toBe(false);
  });

  it('confirms against the editor’s revision, then hides the panel and reloads the catalog', async () => {
    mocks.readDrift.mockResolvedValue(view({ verdict: VERDICT }));
    const container = await panel();

    await click(buttonByText(container, 'Still accurate'));

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledWith({ dokId: 'ROWS', expectedRevision: REVISION });
    expect(container.querySelector('[data-testid="dok-drift-panel"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Confirmed. This Dok reads fresh until its tracked sources change again.',
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('keeps the button disabled over unsaved edits and when a confirmation cannot apply', async () => {
    const pending = await panel({ editsPending: true });
    expect(buttonByText(pending, 'Still accurate').disabled).toBe(true);
    expect(pending.textContent).toContain('Save your edits before confirming.');

    mocks.readDrift.mockResolvedValue(view({
      drift: { stale: true, reason: 'tracking-expanded' },
      blocked: 'TRACKING_REVIEW_REQUIRED',
    }));
    const tracking = await panel();
    expect(buttonByText(tracking, 'Still accurate').disabled).toBe(true);
    expect(tracking.textContent).toContain('Recovered source tracking needs review.');
    expect(tracking.textContent).toContain('Confirming cannot clear it.');

    mocks.readDrift.mockResolvedValue(view({
      drift: { stale: true, reason: 'missing-file' },
      blocked: 'NOTHING_TO_CONFIRM',
    }));
    const missing = await panel();
    expect(buttonByText(missing, 'Still accurate').disabled).toBe(true);
    expect(missing.textContent).toContain('A tracked source file is missing or cannot be read.');

    await click(buttonByText(missing, 'Still accurate'));
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('reports a refused confirmation and offers a reload after a conflict', async () => {
    mocks.confirm.mockResolvedValueOnce({
      ok: false,
      code: 'CONFLICT',
      path: '/workspace/.doklo/hub/doks/ROWS.json',
      error: 'Dok changed outside Studio. Reload before saving again.',
      preserved: true,
    });
    const container = await panel();

    await click(buttonByText(container, 'Still accurate'));

    expect(container.querySelector('[data-testid="dok-drift-panel"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'The Dok changed outside this view. Reload before confirming.',
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    await click(buttonByText(container, 'Reload'));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('uses the Korean copy for a Korean workspace', async () => {
    mocks.readDrift.mockResolvedValue(view({ verdict: VERDICT }));
    const container = await panel({ locale: 'ko' });

    expect(buttonByText(container, '여전히 맞다')).toBeTruthy();
    expect(container.textContent).toContain('판사 확인: 그대로 맞음');
    expect(container.textContent).toContain('재생성은 `doklo sync`로 합니다.');
  });
});

describe('Dok editor drift panel', () => {
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
  const lexiconState: LoadState<LexiconFile> = {
    kind: 'empty',
    path: '/workspace/.doklo/hub/lexicon.json',
    revision: 'lexicon-revision',
    data: { version: 1, terms: [] },
  };
  const rolesState: LoadState<RolesFile> = {
    kind: 'empty',
    path: '/workspace/.doklo/hub/roles.json',
    revision: 'roles-revision',
    data: { version: 1, roles: [] },
  };

  function SeedDok() {
    const { setEditingDok } = useStudio();
    useEffect(() => setEditingDok(dok), [setEditingDok]);
    return <DokEditor />;
  }

  function editor() {
    return render(
      <StudioProvider
        layerCounts={{ doks: 1, lexicon: 0, ia: 0, roles: 0 }}
        workspaceState={workspaceState}
        doksState={doksState}
        lexiconState={lexiconState}
        rolesState={rolesState}
      >
        <SeedDok />
      </StudioProvider>,
    );
  }

  async function changeDescription(container: HTMLElement, value: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');
    if (!textarea) throw new Error('Missing description.');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(textarea),
        'value',
      )?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    mocks.readDrift.mockImplementation(async () => view({ dokId: dok.dok_id }));
    mocks.saveDok.mockResolvedValue({ ok: true, path: dokPath, revision: 'dok-revision-2' });
  });

  it('shows the panel for a stale Dok and confirms against the loaded revision', async () => {
    const container = await editor();

    expect(mocks.readDrift).toHaveBeenCalledWith({ dokId: dok.dok_id });
    expect(container.querySelector('[data-testid="dok-drift-panel"]')).not.toBeNull();
    await click(buttonByText(container, 'Still accurate'));
    expect(mocks.confirm).toHaveBeenCalledWith({
      dokId: dok.dok_id,
      expectedRevision: 'dok-revision',
    });
  });

  it('holds the confirmation over unsaved edits, then checks against the revision the save wrote', async () => {
    const container = await editor();

    await changeDescription(container, 'A person rewrote this paragraph.');
    expect(buttonByText(container, 'Still accurate').disabled).toBe(true);
    expect(container.textContent).toContain('Save your edits before confirming.');

    // An active Dok's prose edit saves it back to draft (the editor's rule).
    await click(buttonByText(container, 'Save as draft'));
    expect(mocks.saveDok).toHaveBeenCalledOnce();
    // The save moved the Dok: its drift (and any verdict, keyed by its text)
    // is read again, and the confirmation checks the revision just written.
    expect(mocks.readDrift).toHaveBeenCalledTimes(2);
    await click(buttonByText(container, 'Still accurate'));
    expect(mocks.confirm).toHaveBeenCalledWith({
      dokId: dok.dok_id,
      expectedRevision: 'dok-revision-2',
    });
  });
});
