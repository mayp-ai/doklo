// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicationWorkbench } from '../components/publication-workbench';
import type {
  PublicationTemplateReadModel,
  PublicationWorkspaceModel,
} from '../lib/publication-read-model';

describe('PublicationWorkbench', () => {
  let root: Root;
  let host: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    root = createRoot(host);
    vi.stubGlobal('React', React);
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      if (init?.method === 'POST') {
        return Response.json({ model: model() });
      }
      if (url === '/api/livedocs') {
        return Response.json(model());
      }
      return Response.json({ model: model() });
    });
    vi.stubGlobal('fetch', fetchMock);
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('renders Publication-first navigation, bilingual statuses, and mobile detail tabs', async () => {
    const withChanges = model() as PublicationWorkspaceModel & {
      publications: Array<PublicationWorkspaceModel['publications'][number] & {
        change_summary?: unknown;
      }>;
    };
    withChanges.publications[0]!.change_summary = {
      added: [{ dok_id: 'AUTH-NEW', name: 'New sign-in' }],
      changed: [{ dok_id: 'AUTH', name: 'Authentication' }],
      removed: [{ dok_id: 'AUTH-OLD', name: 'Old sign-in' }],
      excluded: [{
        dok_id: 'DRAFT',
        name: 'Draft sign-in',
        reason: 'unreviewed',
      }],
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      return Response.json({ model: withChanges });
    });
    await render(withChanges);

    expect(host.textContent).toContain('Review Help');
    expect(host.textContent).toContain('Manual Guide');
    expect(host.textContent).toContain('Update available');
    expect(host.textContent).toContain('Approve render');
    expect(host.textContent).not.toMatch(/automatic publishing/i);
    expect(
      [...host.querySelectorAll('[data-publication-tab]')]
        .map((element) => element.textContent?.trim()),
    ).toEqual(['Preview', 'Changes', 'Settings']);
    expect(host.textContent).toContain('AUTH-NEW');
    expect(host.textContent).toContain('AUTH');
    expect(host.textContent).toContain('AUTH-OLD');
    expect(host.textContent).toContain('DRAFT');
    expect(
      [...host.querySelectorAll('[data-publication-tab]')]
        .map((element) => element.getAttribute('role')),
    ).toEqual(['tab', 'tab', 'tab']);
  });

  it('selects the Publication named by the page deep link', async () => {
    await act(async () => {
      root.render(
        <PublicationWorkbench
          initialModel={model()}
          initialPublicationName="manual-guide"
        />,
      );
    });

    expect(
      host.querySelector('[aria-current="page"]')?.textContent,
    ).toContain('Manual Guide');
  });

  it('automatically requests one candidate per review fingerprint and refreshes on focus', async () => {
    await render(model());
    await flush();

    expect(fetchMock.mock.calls.filter(
      ([url]) => String(url).endsWith('/preview'),
    )).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.some(
      ([url, init]) => url === '/api/livedocs' && init === undefined,
    )).toBe(true);
    expect(fetchMock.mock.calls.filter(
      ([url]) => String(url).endsWith('/preview'),
    )).toHaveLength(1);
  });

  it('shows localized action errors instead of raw CLI messages', async () => {
    const korean = model();
    korean.locale = 'ko';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/action')) {
        return Response.json({
          code: 'PUBLICATION_FINGERPRINT_STALE',
          error: 'The Dok Hub changed. Refresh before running this action.',
        }, { status: 409 });
      }
      if (String(url).endsWith('/preview')) {
        return Response.json({
          code: 'PUBLICATION_PREVIEW_FAILED',
          error: 'Raw preview failure',
        }, { status: 500 });
      }
      return Response.json({ model: korean });
    });

    await render(korean);
    const approve = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('승인하고 생성'),
    );
    expect(approve).toBeDefined();
    await act(async () => {
      approve!.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain(
      'Dok Hub가 변경됐습니다. 새 후보를 확인한 뒤 승인하세요.',
    );
    expect(host.textContent).not.toContain(
      'The Dok Hub changed. Refresh before running this action.',
    );
  });

  it('reports a refreshed selection followed by a failed render without claiming it rendered', async () => {
    const korean = model();
    korean.locale = 'ko';
    korean.publications[0]!.publication.selection = {
      mode: 'filter',
      statuses: ['active'],
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/action')) {
        return Response.json({
          status: 'partial',
          completed: ['resnapshot'],
          failed: 'render',
          code: 'PUBLICATION_RENDER_FAILED',
          model: korean,
        }, { status: 207 });
      }
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      if (url === '/api/livedocs') return Response.json(korean);
      return Response.json({ model: korean });
    });

    await render(korean);
    const approve = buttonContaining('승인하고 생성');
    await act(async () => {
      approve.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain(
      'Dok 선택은 갱신됐지만 문서 생성에 실패했습니다.',
    );
    expect(host.textContent).not.toContain('생성 완료, 발행 차단됨');
  });

  it('reports a publish failure after a completed render as rendered and publish-blocked', async () => {
    const withDestination = model();
    withDestination.publications[0]!.publication.destination = {
      kind: 'repo_path',
      path: 'docs/help',
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/action')) {
        return Response.json({
          status: 'partial',
          completed: ['render', 'publish-dry-run'],
          failed: 'publish',
          code: 'PUBLICATION_PUBLISH_BLOCKED',
          model: withDestination,
        }, { status: 207 });
      }
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      if (url === '/api/livedocs') return Response.json(withDestination);
      return Response.json({ model: withDestination });
    });

    await render(withDestination);
    await act(async () => {
      buttonContaining('Approve and publish').click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Rendered; publish blocked');
  });

  it('does not show Publication A official output while Publication B detail fails', async () => {
    const initial = model();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Candidate A</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      if (String(url).includes('/api/livedocs/review-help')) {
        return Response.json({
          model: initial,
          official_preview: htmlPreview('review-fingerprint', 'Official A'),
        });
      }
      if (String(url).includes('/api/livedocs/manual-guide')) {
        return Response.json(
          { code: 'PUBLICATION_PREVIEW_FAILED' },
          { status: 500 },
        );
      }
      if (url === '/api/livedocs') return Response.json(initial);
      return Response.json({ model: initial });
    });

    await render(initial);
    await flush();
    await act(async () => buttonContaining('Official').click());
    expect(host.querySelector('iframe')?.srcdoc).toBe('Official A');

    await act(async () => buttonContaining('Manual Guide').click());
    await flush();

    expect(host.querySelector('iframe')?.srcdoc).not.toBe('Official A');
    expect(host.textContent).toContain('No preview is available yet.');
  });

  it('retries an aborted candidate when returning to the same Publication', async () => {
    const initial = model();
    const firstCandidate = deferred<Response>();
    let candidateCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        candidateCalls += 1;
        if (candidateCalls === 1) return firstCandidate.promise;
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Retried candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      if (url === '/api/livedocs') return Response.json(initial);
      return Response.json({ model: initial });
    });

    await render(initial);
    await act(async () => buttonContaining('Manual Guide').click());
    await act(async () => buttonContaining('Review Help').click());
    await flush();

    expect(candidateCalls).toBe(2);
    expect(host.querySelector('iframe')?.srcdoc).toContain(
      'Retried candidate',
    );
    expect(host.textContent).not.toContain('Preparing candidate preview');

    firstCandidate.resolve(Response.json({
      kind: 'html',
      fingerprint: 'review-fingerprint',
      html: '<html><body>Aborted candidate</body></html>',
      filename: 'candidate.html',
      mime: 'text/html; charset=utf-8',
      output_count: 1,
    }));
  });

  it('keeps the newest model when overlapping refreshes resolve out of order', async () => {
    const initial = model();
    const olderRequest = deferred<Response>();
    const newerRequest = deferred<Response>();
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<html><body>Candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      if (url === '/api/livedocs') {
        refreshCalls += 1;
        return refreshCalls === 1
          ? olderRequest.promise
          : newerRequest.promise;
      }
      return Response.json({ model: initial });
    });
    await render(initial);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    const newest = structuredClone(initial);
    newest.publications[0]!.publication.display_name = 'Newest Review';
    newerRequest.resolve(Response.json(newest));
    await flush();
    expect(host.textContent).toContain('Newest Review');

    const stale = structuredClone(initial);
    stale.publications[0]!.publication.display_name = 'Stale Review';
    olderRequest.resolve(Response.json(stale));
    await flush();

    expect(host.textContent).toContain('Newest Review');
    expect(host.textContent).not.toContain('Stale Review');
  });

  it('exposes pressed preview modes and a mode-aware iframe title', async () => {
    const initial = model();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        return Response.json(htmlPreview(
          'review-fingerprint',
          'Candidate preview document',
        ));
      }
      if (String(url).includes('/api/livedocs/review-help')) {
        return Response.json({
          model: initial,
          official_preview: htmlPreview(
            'review-fingerprint',
            'Official preview document',
          ),
        });
      }
      if (url === '/api/livedocs') return Response.json(initial);
      return Response.json({ model: initial });
    });
    await render(initial);
    await flush();

    const official = buttonContaining('Official');
    const candidate = buttonContaining('Candidate');
    expect(official.getAttribute('aria-pressed')).toBe('false');
    expect(candidate.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('iframe')?.title).toBe('Candidate preview');

    await act(async () => official.click());
    expect(official.getAttribute('aria-pressed')).toBe('true');
    expect(candidate.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('iframe')?.title).toBe('Official preview');
  });

  it('switches between every rendered per-Dok document', async () => {
    const initial = model();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'review-fingerprint',
          html: '<article>Banner help</article>',
          filename: 'ADMIN-BANNER.html',
          mime: 'text/html; charset=utf-8',
          output_count: 2,
          documents: [
            {
              kind: 'html',
              html: '<article>Banner help</article>',
              filename: 'ADMIN-BANNER.html',
              mime: 'text/html; charset=utf-8',
              dok_id: 'ADMIN-BANNER',
            },
            {
              kind: 'html',
              html: '<article>Mentor help</article>',
              filename: 'ADMIN-MENTOR.html',
              mime: 'text/html; charset=utf-8',
              dok_id: 'ADMIN-MENTOR',
            },
          ],
        });
      }
      if (url === '/api/livedocs') return Response.json(initial);
      return Response.json({ model: initial });
    });

    await render(initial);
    await flush();

    const outputButtons = [
      ...host.querySelectorAll<HTMLButtonElement>(
        '[data-publication-output]',
      ),
    ];
    expect(outputButtons.map((button) => button.textContent?.trim())).toEqual([
      'ADMIN-BANNER',
      'ADMIN-MENTOR',
    ]);
    expect(host.querySelector('iframe')?.srcdoc).toContain('Banner help');

    await act(async () => outputButtons[1]!.click());

    expect(outputButtons[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(outputButtons[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('iframe')?.srcdoc).toContain('Mentor help');
  });

  it('uses build and download action copy without exposing resnapshot', async () => {
    const dynamic = model();
    dynamic.publications[1]!.publication.selection = {
      mode: 'filter',
      statuses: ['active'],
    };
    await render(dynamic, 'manual-guide');

    expect(host.textContent).toContain('Build latest document');
    expect(host.textContent).toContain('Download ZIP');
    expect(host.textContent).not.toContain('Resnapshot');

    const korean = structuredClone(dynamic);
    korean.locale = 'ko';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/preview')) {
        return Response.json({
          kind: 'html',
          fingerprint: 'manual-fingerprint',
          html: '<html><body>Candidate</body></html>',
          filename: 'candidate.html',
          mime: 'text/html; charset=utf-8',
          output_count: 1,
        });
      }
      return Response.json({ model: korean });
    });
    await render(korean, 'manual-guide');

    expect(host.textContent).toContain('최신 문서 만들기');
    expect(host.textContent).toContain('ZIP 내려받기');
    expect(host.textContent).not.toContain('스냅샷 갱신');
  });

  it('reloads the official preview after an official render changes evidence', async () => {
    const initial = model();
    const fresh = structuredClone(initial);
    const initialManual = initial.publications[1]!;
    const freshManual = fresh.publications[1]!;
    initialManual.evidence = evidenceWithOutput('old-output');
    freshManual.evidence = evidenceWithOutput('new-output');
    let detailRequests = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        init?.method === 'POST'
        && String(url).endsWith('/action')
      ) {
        return Response.json({ status: 'success', model: fresh });
      }
      if (String(url).includes('/api/livedocs/manual-guide')) {
        detailRequests += 1;
        const current = detailRequests === 1 ? initial : fresh;
        return Response.json({
          model: current,
          official_preview: {
            kind: 'html',
            fingerprint: 'manual-fingerprint',
            html: detailRequests === 1 ? 'Old official' : 'New official',
            filename: 'manual.html',
            mime: 'text/html; charset=utf-8',
            output_count: 1,
          },
        });
      }
      if (url === '/api/livedocs') return Response.json(fresh);
      return Response.json({ model: fresh });
    });

    await act(async () => {
      root.render(
        <PublicationWorkbench
          initialModel={initial}
          initialPublicationName="manual-guide"
        />,
      );
    });
    await flush();
    expect(detailRequests).toBe(1);

    const renderButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Build latest document',
    );
    await act(async () => {
      renderButton!.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await flush();

    expect(detailRequests).toBe(2);
    expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toBe(
      'New official',
    );
  });

  async function render(
    initialModel: PublicationWorkspaceModel,
    initialPublicationName?: string,
  ) {
    await act(async () => {
      root.render(
        <PublicationWorkbench
          key={`${initialModel.locale}:${initialPublicationName ?? ''}`}
          initialModel={initialModel}
          initialPublicationName={initialPublicationName}
        />,
      );
    });
  }

  function buttonContaining(name: string): HTMLButtonElement {
    const match = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((element) => element.textContent?.includes(name));
    if (!match) throw new Error(`Button not found: ${name}`);
    return match;
  }
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function model(): PublicationWorkspaceModel {
  const template: PublicationTemplateReadModel = {
    name: 'help-page',
    version: '1.1.0',
    source: 'builtin' as const,
    stability: 'stable' as const,
    display_name: 'Help Page',
    description: 'Customer help',
    audience: 'Customers',
    purpose: 'Explain a task',
    job: 'Complete a task',
    required_input: 'Active Doks',
    scope: 'per_dok' as const,
    default_format: 'html',
    output_formats: ['html' as const],
    supported_locales: ['en', 'ko'],
    default_locale: 'en',
    variables: {},
    selection: {
      scope: 'per_dok' as const,
      eligible_dok_ids: ['AUTH'],
      default_kind: 'explicit' as const,
      allowed_kinds: ['all_eligible', 'filter', 'explicit'],
      excluded: [],
    },
  };
  return {
    locale: 'en',
    workspace_default_locale: 'en',
    templates: [template],
    doks: [{
      dok_id: 'AUTH',
      name: 'Authentication',
      status: 'active',
      tags: [],
      surfaces: ['web'],
    }],
    errors: [],
    publications: [
      {
        publication: {
          schema_version: 1,
          name: 'review-help',
          display_name: 'Review Help',
          template: 'help-page',
          selection: {
            mode: 'explicit',
            dok_ids: ['AUTH'],
          },
          selected_dok_ids: ['AUTH'],
          format: 'html',
          locale: 'en',
          vars: {},
          output_dir: 'help-page/review-help',
          update_mode: 'review',
          created_at: '2026-07-17T03:04:05.678Z',
        },
        effective_update_mode: 'review',
        definition_path: '/workspace/review-help.json',
        definition_sha256: 'review-definition',
        template,
        status: {
          render_state: 'update_available',
          publish_state: 'no_destination',
          freshness: 'proven',
          template_update_available: false,
          reasons: ['content_changed'],
          resolved_dok_ids: ['AUTH'],
          input_fingerprint: 'review-fingerprint',
        },
      },
      {
        publication: {
          schema_version: 1,
          name: 'manual-guide',
          display_name: 'Manual Guide',
          template: 'help-page',
          selection: {
            mode: 'explicit',
            dok_ids: ['AUTH'],
          },
          selected_dok_ids: ['AUTH'],
          format: 'html',
          locale: 'en',
          vars: {},
          output_dir: 'help-page/manual-guide',
          created_at: '2026-07-17T03:04:05.678Z',
        },
        effective_update_mode: 'manual',
        definition_path: '/workspace/manual-guide.json',
        definition_sha256: 'manual-definition',
        template,
        status: {
          render_state: 'current',
          publish_state: 'no_destination',
          freshness: 'proven',
          template_update_available: false,
          reasons: [],
          resolved_dok_ids: ['AUTH'],
          input_fingerprint: 'manual-fingerprint',
        },
      },
    ],
  };
}

function evidenceWithOutput(sha256: string) {
  return {
    outputs: [{
      relative_path: '.doklo/output/help-page/manual-guide/manual.html',
      sha256,
    }],
  } as never;
}

function htmlPreview(
  fingerprint: string,
  html: string,
) {
  return {
    kind: 'html' as const,
    fingerprint,
    html,
    filename: 'preview.html',
    mime: 'text/html; charset=utf-8' as const,
    output_count: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
