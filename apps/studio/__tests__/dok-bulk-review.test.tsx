// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import {
  DokBulkReviewBar,
  useDokBulkReviewController,
} from '../components/dok-bulk-review';
import { dokBulkReviewCopy } from '../lib/dok-bulk-review-copy';

const mocks = vi.hoisted(() => ({
  bulkActivate: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../lib/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/actions')>()),
  bulkActivateDoksAction: mocks.bulkActivate,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const FIRST_REVISION = 'a'.repeat(64);
const SECOND_REVISION = 'b'.repeat(64);
const ACTIVE_REVISION = 'c'.repeat(64);

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

const doks = [
  dok('AUTH-SIGNIN', 'draft'),
  dok('PAY', 'draft'),
  dok('PROFILE', 'active'),
];

const revisions = {
  'AUTH-SIGNIN': FIRST_REVISION,
  PAY: SECOND_REVISION,
  PROFILE: ACTIVE_REVISION,
};

function Harness({
  locale = 'en',
  onReviewModeChange,
}: {
  locale?: string;
  onReviewModeChange?: (reviewMode: boolean) => void;
}) {
  const controller = useDokBulkReviewController({
    doks,
    revisions,
    locale,
    onReviewModeChange,
  });
  return (
    <div>
      <DokBulkReviewBar controller={controller} draftCount={2} />
      {doks.map((item) => (
        <label key={item.dok_id}>
          {item.dok_id}
          <input
            type="checkbox"
            aria-label={`Select ${item.dok_id} for review`}
            disabled={!controller.reviewMode || item.status !== 'draft'}
            checked={controller.selectedIds.has(item.dok_id)}
            onChange={() => controller.toggleDok(item.dok_id)}
          />
        </label>
      ))}
      <button type="button" onClick={controller.clearForFilterChange}>
        Change filter
      </button>
    </div>
  );
}

function renderHarness(
  locale = 'en',
  onReviewModeChange?: (reviewMode: boolean) => void,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(
    <Harness locale={locale} onReviewModeChange={onReviewModeChange} />,
  ));
  return container;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function checkbox(root: ParentNode, dokId: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(
    `input[aria-label="Select ${dokId} for review"]`,
  );
  if (!input) throw new Error(`Missing checkbox ${dokId}`);
  return input;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  mocks.bulkActivate.mockResolvedValue({
    ok: true,
    activated: [
      { dokId: 'AUTH-SIGNIN', revision: 'd'.repeat(64) },
      { dokId: 'PAY', revision: 'e'.repeat(64) },
    ],
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('Dok bulk review copy', () => {
  it('keeps English and Korean copy structurally aligned with English fallback', () => {
    const english = dokBulkReviewCopy('en');
    const korean = dokBulkReviewCopy('ko-KR');
    expect(dokBulkReviewCopy('fr')).toBe(english);
    expect(Object.keys(korean)).toEqual(Object.keys(english));
    expect(english.warning).toContain('reviewed product context');
    expect(korean.warning).toContain('검토된 제품 정보');
    expect(english.warning).toContain(
      'Staged change proposals are recorded to history on approval.',
    );
    expect(korean.warning).toContain('준비된 변경 제안은 승인 시 이력에 기록됩니다.');
    expect(english.acknowledgment).toBe('I understand the impact');
    expect(korean.acknowledgment).toBe('영향을 확인했습니다');
    expect(english.activateAll(2)).toBe('Mark all 2 drafts active');
    expect(korean.activateAll(2)).toBe('Draft 2개 모두 Active 처리');
  });
});

describe('Dok bulk review controls', () => {
  it('separates guidance, selected actions, and the complete-Draft action without truncated labels', async () => {
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    const reviewBar = container.querySelector<HTMLElement>(
      'section[aria-labelledby]',
    );
    if (!reviewBar) throw new Error('Missing review bar.');
    expect(reviewBar.className).toContain('bg-status-draft-bg');
    expect(reviewBar.className).not.toContain('bg-status-review-bg');

    const header = reviewBar.querySelector('header');
    const selectedActions = reviewBar.querySelector<HTMLElement>(
      '[role="group"][aria-label="Selected Doks"]',
    );
    const allDraftActions = reviewBar.querySelector<HTMLElement>(
      '[role="group"][aria-label="All Drafts"]',
    );
    const cancel = buttonByText(reviewBar, 'Cancel review');
    const activateSelected = buttonByText(reviewBar, 'Mark 0 as active');
    const activateAll = buttonByText(reviewBar, 'Mark all 2 drafts active');

    expect(header?.contains(cancel)).toBe(true);
    expect(selectedActions?.contains(activateSelected)).toBe(true);
    expect(allDraftActions?.contains(activateAll)).toBe(true);
    expect(activateSelected.className).toContain('whitespace-nowrap');
    expect(activateAll.className).toContain('whitespace-nowrap');
    expect(reviewBar.textContent).not.toContain('…');
  });

  it('reports entry and exit so the catalog can own the review filter lifecycle', async () => {
    const onReviewModeChange = vi.fn();
    const container = renderHarness('en', onReviewModeChange);

    await click(buttonByText(container, 'Review Doks'));
    expect(onReviewModeChange).toHaveBeenLastCalledWith(true);

    await click(buttonByText(container, 'Cancel review'));
    expect(onReviewModeChange).toHaveBeenLastCalledWith(false);

    await click(buttonByText(container, 'Review Doks'));
    await click(checkbox(container, 'AUTH-SIGNIN'));
    await click(buttonByText(container, 'Mark 1 as active'));
    expect(onReviewModeChange).toHaveBeenLastCalledWith(false);
  });

  it('activates a partial selection directly, without a confirmation dialog', async () => {
    mocks.bulkActivate.mockResolvedValueOnce({
      ok: true,
      activated: [{ dokId: 'AUTH-SIGNIN', revision: 'd'.repeat(64) }],
    });
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    expect(container.textContent).toContain(
      'Active Doks may be treated as reviewed product context',
    );
    expect(checkbox(container, 'PROFILE').disabled).toBe(true);

    await click(checkbox(container, 'AUTH-SIGNIN'));
    await click(buttonByText(container, 'Mark 1 as active'));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.bulkActivate).toHaveBeenCalledWith({
      mode: 'selected',
      targets: [{ dokId: 'AUTH-SIGNIN', expectedRevision: FIRST_REVISION }],
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('1 Dok marked active');
  });

  // Activating every draft weighs the same however the user got there, so a
  // selection that happens to cover them all takes the same acknowledgement as
  // the explicit "mark all" button — including the server-side check that the
  // draft set has not shifted underneath, which `mode: 'all_drafts'` carries.
  it('routes a full selection through the same acknowledgment', async () => {
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    await click(checkbox(container, 'AUTH-SIGNIN'));
    await click(checkbox(container, 'PAY'));
    await click(buttonByText(container, 'Mark 2 as active'));

    const modal = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(modal).not.toBeNull();
    expect(mocks.bulkActivate).not.toHaveBeenCalled();

    const acknowledgment = modal?.querySelector<HTMLInputElement>(
      'input[aria-label="I understand the impact"]',
    );
    if (!acknowledgment) throw new Error('Missing acknowledgment checkbox.');
    await click(acknowledgment);
    await click(buttonByText(modal ?? document, 'Mark all 2 as active'));

    expect(mocks.bulkActivate).toHaveBeenCalledWith({
      mode: 'all_drafts',
      targets: [
        { dokId: 'AUTH-SIGNIN', expectedRevision: FIRST_REVISION },
        { dokId: 'PAY', expectedRevision: SECOND_REVISION },
      ],
    });
  });

  it('selects and clears every draft with one control', async () => {
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    const selectAll = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all drafts"]',
    );
    if (!selectAll) throw new Error('Missing select-all checkbox.');

    await click(selectAll);
    expect(checkbox(container, 'AUTH-SIGNIN').checked).toBe(true);
    expect(checkbox(container, 'PAY').checked).toBe(true);
    expect(container.textContent).toContain('Mark 2 as active');

    await click(selectAll);
    expect(checkbox(container, 'AUTH-SIGNIN').checked).toBe(false);
    expect(checkbox(container, 'PAY').checked).toBe(false);
  });

  it('requires one explicit acknowledgment for the complete Draft set', async () => {
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    await click(buttonByText(container, 'Mark all 2 drafts active'));
    const modal = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(modal).not.toBeNull();
    const confirm = buttonByText(modal ?? document, 'Mark all 2 as active');
    expect(
      modal?.querySelector('input[aria-label="Confirmation phrase"]'),
    ).toBeNull();
    expect(modal?.querySelector('[role="alert"]')?.textContent).toContain(
      'trusted product context',
    );
    const acknowledgment = modal?.querySelector<HTMLInputElement>(
      'input[aria-label="I understand the impact"]',
    );
    if (!acknowledgment) throw new Error('Missing acknowledgment checkbox.');
    expect(acknowledgment.checked).toBe(false);
    expect(confirm.disabled).toBe(true);

    await click(acknowledgment);
    expect(acknowledgment.checked).toBe(true);
    expect(confirm.disabled).toBe(false);
    await click(confirm);

    expect(mocks.bulkActivate).toHaveBeenCalledWith({
      mode: 'all_drafts',
      targets: [
        { dokId: 'AUTH-SIGNIN', expectedRevision: FIRST_REVISION },
        { dokId: 'PAY', expectedRevision: SECOND_REVISION },
      ],
    });
  });

  it('clears direct selection when the catalog filter changes', async () => {
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    await click(checkbox(container, 'AUTH-SIGNIN'));
    expect(checkbox(container, 'AUTH-SIGNIN').checked).toBe(true);

    await click(buttonByText(container, 'Change filter'));

    expect(checkbox(container, 'AUTH-SIGNIN').checked).toBe(false);
  });

  it('reports partial success and keeps only failed Drafts selected', async () => {
    mocks.bulkActivate.mockResolvedValueOnce({
      ok: false,
      code: 'PARTIAL_FAILURE',
      error: 'one failed',
      activated: [{ dokId: 'AUTH-SIGNIN', revision: 'd'.repeat(64) }],
      failures: [{
        dokId: 'PAY',
        code: 'WRITE_FAILED',
        error: 'permission denied',
        preserved: true,
      }],
    });
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    await click(checkbox(container, 'AUTH-SIGNIN'));
    await click(checkbox(container, 'PAY'));

    // Selecting both covers the whole draft set, so this goes through the
    // acknowledgment before reaching the activation call.
    await click(buttonByText(container, 'Mark 2 as active'));
    const modal = document.querySelector<HTMLElement>('[role="dialog"]');
    const acknowledgment = modal?.querySelector<HTMLInputElement>(
      'input[aria-label="I understand the impact"]',
    );
    if (!acknowledgment) throw new Error('Missing acknowledgment checkbox.');
    await click(acknowledgment);
    await click(buttonByText(modal ?? document, 'Mark all 2 as active'));

    expect(container.textContent).toContain('1 activated; 1 failed');
    expect(checkbox(container, 'AUTH-SIGNIN').checked).toBe(false);
    expect(checkbox(container, 'PAY').checked).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('keeps selection and offers reload guidance after preflight failure', async () => {
    mocks.bulkActivate.mockResolvedValueOnce({
      ok: false,
      code: 'PREFLIGHT_FAILED',
      error: 'revision changed',
      activated: [],
      failures: [{
        dokId: 'AUTH-SIGNIN',
        code: 'CONFLICT',
        error: 'revision changed',
        preserved: true,
      }],
    });
    const container = renderHarness();
    await click(buttonByText(container, 'Review Doks'));
    await click(checkbox(container, 'AUTH-SIGNIN'));

    await click(buttonByText(container, 'Mark 1 as active'));

    expect(checkbox(container, 'AUTH-SIGNIN').checked).toBe(true);
    expect(container.textContent).toContain('Reload Doks before retrying');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
