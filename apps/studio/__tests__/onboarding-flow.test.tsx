// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingShell } from '../components/onboarding/shell';
import type { WizardWorkspaceState } from '../lib/wizard-actions';

const { wizardRunScanMock, wizardGetDoksMock } = vi.hoisted(() => ({
  wizardRunScanMock: vi.fn(),
  wizardGetDoksMock: vi.fn(),
}));

vi.mock('../lib/wizard-actions', () => ({
  wizardRunScan: wizardRunScanMock,
  wizardGetDoks: wizardGetDoksMock,
}));

const initialState: WizardWorkspaceState = {
  workspaceName: 'Atlas',
  workspacePath: '/workspace',
  services: [{
    serviceId: 'web',
    framework: 'nextjs',
    scan: { status: 'missing', counts: null },
  }],
  existingDoks: 0,
  doks: [],
  generation: { status: 'none', summary: null, completedAt: null },
  model: 'anthropic/claude-sonnet-4-20250514',
  provider: 'anthropic',
};

const roots: Root[] = [];
let consentSequence = 0;

function jsonStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}

function openJsonStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return {
    stream: new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
      },
    }),
    emit(event: Record<string, unknown>) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    close() {
      controller.close();
    },
    fail(message: string) {
      controller.error(new Error(message));
    },
  };
}

function rejectedJsonStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error(message));
    },
  });
}

async function renderOnboarding(state = initialState): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <OnboardingShell workspaceName="Atlas" initialState={state} />,
    );
  });
  return host;
}

function button(name: string): HTMLButtonElement {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!target) throw new Error(`Could not find button: ${name}`);
  return target;
}

function receiptRow(title: string): HTMLLIElement {
  const row = [...document.querySelectorAll<HTMLLIElement>('ul[aria-live="polite"] > li')]
    .find((candidate) => candidate.textContent?.includes(title));
  if (!row) throw new Error(`Could not find receipt row: ${title}`);
  return row;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function queueGenerationResponse(response: Response): string {
  consentSequence += 1;
  const token = `test-consent-${consentSequence}`;
  (fetch as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(Response.json({ consentToken: token }))
    .mockResolvedValueOnce(response);
  return token;
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  wizardRunScanMock.mockReset();
  wizardGetDoksMock.mockReset();
  consentSequence = 0;
  wizardRunScanMock.mockResolvedValue({
    ok: true,
    workspaceName: 'Atlas',
    serviceCount: 1,
    counts: { routes: 2, components: 4, stores: 1 },
    featureGroups: [],
    totalDoks: 0,
  });
  wizardGetDoksMock.mockResolvedValue([
    { dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft', anchorFiles: [] },
  ]);
  vi.stubGlobal('fetch', vi.fn());
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('onboarding generation flow', () => {
  it('exits the completed onboarding journey into the Doks catalog', async () => {
    await renderOnboarding({
      ...initialState,
      existingDoks: 0,
      doks: [{ dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft', anchorFiles: [] }],
      generation: {
        status: 'complete',
        summary: {
          sourceFeatures: 1,
          success: 1,
          failed: 0,
          skipped: 0,
          dokTargets: 1,
          dokTargetIds: ['AUTH-SIGNIN'],
        },
        completedAt: '2026-07-23T00:00:00.000Z',
      },
    });

    await click(button('Check for code changes'));
    await click(button('View your Hub'));
    await click(button('See Live Docs'));

    const exit = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      .find((candidate) => candidate.textContent?.includes('Finish in Dok Studio'));
    expect(exit?.getAttribute('href')).toBe('/doks');
  });

  it('does not generate until the user clicks Generate Doks', async () => {
    await renderOnboarding();

    expect(fetch).not.toHaveBeenCalled();
    await click(button('Get started'));
    expect(fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('source excerpts');

    const consentToken = queueGenerationResponse(
      new Response(jsonStream([{ stage: 'error', message: 'stop after request assertion' }])),
    );
    await click(button('Generate Doks'));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/wizard/generate?service=web',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-doklo-generation-action': 'request-consent' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/wizard/generate?service=web',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'x-doklo-generation-action': 'start-generation',
          'x-doklo-generation-consent': consentToken,
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('advances only after done and clean-close', async () => {
    const transport = openJsonStream();
    queueGenerationResponse(new Response(transport.stream));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));

    transport.emit({ stage: 'scan', status: 'reused' });
    transport.emit({ stage: 'consent-plan', phase: 'consolidation', plan: { calls: { consolidate: 1 } } });
    transport.emit({ stage: 'consolidate', status: 'running', featureGroups: 1 });
    transport.emit({ stage: 'consolidate', status: 'completed', featureGroups: 1 });
    transport.emit({ stage: 'consent-plan', phase: 'generation', plan: { calls: { generate: 1 } } });
    transport.emit({ stage: 'roles', status: 'skipped', added: 0, kept: 0 });
    transport.emit({ stage: 'lexicon', status: 'skipped', termCount: 0 });
    transport.emit({ stage: 'plan', total: 1 });
    transport.emit({ stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true });
    transport.emit({ stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).not.toContain('View your Hub');

    transport.emit({ stage: 'clean-close' });
    transport.close();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('View your Hub');
    expect(wizardGetDoksMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a scan failure before making a generation request', async () => {
    wizardRunScanMock.mockRejectedValueOnce(new Error('scan unavailable'));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));

    await act(async () => { await Promise.resolve(); });

    expect(fetch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('scan unavailable');
  });

  it('shows one localized scan summary and collapsed file diagnostics without duplicating the server message', async () => {
    wizardRunScanMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'PARSER_LEDGER_INCOMPLETE',
        serviceId: 'web',
        failedFiles: [
          {
            file: 'src/broken.js',
            stages: ['ast'],
            reason: "TS1005 667:34 ';' expected.",
            diagnosticCount: 655,
          },
          {
            file: 'src/also-broken.js',
            stages: ['ast'],
            reason: "TS1128 668:42 Declaration or statement expected.",
            diagnosticCount: 2,
          },
        ],
        preserved: ['/workspace/.doklo/cache/web.scan.json'],
        nextCommand: 'doklo scan --service web',
      },
    });
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('KO'));
    await click(button('Dok 생성'));
    await act(async () => { await Promise.resolve(); });

    const summary = '코드 파일 2개를 읽지 못해 스캔을 중단했어요. 아래 파일을 확인한 뒤 다시 실행하세요.';
    expect(document.body.textContent?.split(summary)).toHaveLength(2);
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain(summary);
    const details = alert?.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('오류 내용 보기');
    expect(details?.textContent).toContain('src/broken.js');
    expect(details?.textContent).toContain("TS1005 667:34 ';' expected.");
    expect(details?.textContent).toContain('추가 진단 654건');
    expect(details?.textContent).toContain('기존 스캔 결과는 그대로 보존됐어요.');
    const scanRow = receiptRow('스캔');
    expect(scanRow.textContent).toContain('코드 파일 2개를 읽지 못했어요.');
    expect(scanRow.textContent).not.toContain(summary);
    expect(document.body.textContent).not.toContain('An error occurred in the Server Components render');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps consent rejection to localized wizard copy', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Response.json({ error: 'forbidden' }, { status: 403 }),
    );
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); });

    const alert = document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Generation request was rejected');
    expect(alert).not.toContain('Generation consent request failed');
  });

  it('retries remaining work with the same non-force POST endpoint', async () => {
    const firstConsent = queueGenerationResponse(
      new Response(JSON.stringify({ error: 'busy' }), { status: 409 }),
    );
    const retryConsent = queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 1 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); });

    expect(document.body.textContent).toContain('Another generation run is already active');
    expect(document.body.textContent).toContain('Wait for it to finish');
    const reloadStatus = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      .find((candidate) => candidate.textContent?.trim() === 'Reload status');
    expect(reloadStatus?.getAttribute('href')).toBe('/onboarding');
    await click(button('KO'));
    expect(document.body.textContent).toContain('작업이 끝날 때까지 기다린 뒤 상태를 새로고침');
    expect(document.body.textContent).toContain('상태 새로고침');
    await click(button('EN'));
    await click(button('Retry remaining'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(retryConsent).not.toBe(firstConsent);
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/wizard/generate?service=web',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-doklo-generation-consent': retryConsent,
        }),
      }),
    );
    expect(document.body.textContent).not.toContain('Reload status');
  });

  it('scans and posts only the service selected in the receipt', async () => {
    const transport = openJsonStream();
    queueGenerationResponse(new Response(transport.stream));
    await renderOnboarding({
      ...initialState,
      services: [
        { serviceId: 'web', framework: 'nextjs', scan: { status: 'missing', counts: null } },
        { serviceId: 'api', framework: 'spring-boot', scan: { status: 'missing', counts: null } },
      ],
    });
    await click(button('Get started'));
    const select = document.querySelector<HTMLSelectElement>('#onboarding-service')!;
    await act(async () => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click(button('Generate Doks'));

    expect(wizardRunScanMock).toHaveBeenCalledWith('api');
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/wizard/generate?service=api',
      expect.objectContaining({ method: 'POST' }),
    );
    await act(async () => {
      transport.emit({ stage: 'error', message: 'stop' });
      transport.close();
      await Promise.resolve();
    });
  });

  it('keeps a first-run successful Dok as partial when a later Dok fails', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 2 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: false, error: 'provider timeout' },
      { stage: 'done', succeeded: 1, failed: 1, layerFailed: 0 },
      { stage: 'error', message: 'No Anthropic API key. Run `doklo auth` and retry.' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(wizardGetDoksMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Retry remaining');
    expect(document.body.textContent).toContain('No Anthropic API key. Run `doklo auth` and retry.');
    expect(document.body.textContent).toContain('provider timeout');
    expect(document.body.textContent).not.toContain('1 Dok failures');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('keeps every failed Dok diagnostic and every terminal result diagnostic visible', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 3 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: false, error: 'provider timeout' },
      { stage: 'dok-done', dokId: 'AUTH-RESET', success: false, error: 'quota exhausted' },
      { stage: 'done', succeeded: 1, failed: 2, layerFailed: 0 },
      {
        stage: 'error',
        message: 'AUTH-SIGNUP: provider timeout',
        diagnostics: [
          { code: 'DOK_GENERATION_FAILED', message: 'AUTH-SIGNUP: provider timeout' },
          { code: 'DOK_GENERATION_FAILED', message: 'AUTH-RESET: quota exhausted' },
        ],
      },
    ])));

    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain('AUTH-SIGNUP: provider timeout');
    expect(alert?.textContent).toContain('AUTH-RESET: quota exhausted');
    const dokRow = [...document.querySelectorAll<HTMLLIElement>('li')]
      .find((row) => row.textContent?.includes('Dok generation'));
    expect(dokRow?.textContent).toContain('AUTH-SIGNUP: provider timeout');
    expect(dokRow?.textContent).toContain('AUTH-RESET: quota exhausted');
  });

  it('keeps restored persisted progress and overall counts when every retry Dok fails', async () => {
    const restoredPartial: WizardWorkspaceState = {
      ...initialState,
      existingDoks: 1,
      doks: [{
        dok_id: 'AUTH-SIGNIN',
        name: 'Persisted sign in',
        status: 'draft',
        anchorFiles: ['app/login/page.tsx'],
      }],
      generation: {
        status: 'partial',
        summary: {
          sourceFeatures: 4,
          success: 3,
          skipped: 0,
          failed: 1,
          dokTargets: 2,
          dokTargetIds: ['AUTH-SIGNIN', 'AUTH-SIGNUP'],
        },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    };
    wizardGetDoksMock.mockResolvedValueOnce(restoredPartial.doks);
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 1 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: false, error: 'provider timeout' },
      { stage: 'done', succeeded: 0, failed: 1, layerFailed: 0 },
      { stage: 'error', message: 'Generate completed with 1 Dok failed.' },
    ])));

    await renderOnboarding(restoredPartial);
    await click(button('Resume remaining work'));
    expect(document.body.textContent).toContain('1 / 2');
    await click(button('Retry remaining'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(wizardGetDoksMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Persisted sign in');
    expect(document.body.textContent).toContain('1 / 2');
    expect(document.body.textContent).toContain('Retry remaining');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('resets service-attributed lifecycle state before starting another service', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 2 },
      {
        stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true,
        dok: { dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft' },
      },
      { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: false, error: 'provider timeout' },
      { stage: 'done', succeeded: 1, failed: 1, layerFailed: 0 },
      { stage: 'error', message: 'Generate completed with 1 Dok failed.' },
    ])));
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 0 },
      { stage: 'done', succeeded: 0, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ])));
    await renderOnboarding({
      ...initialState,
      services: [
        { serviceId: 'web', framework: 'nextjs', scan: { status: 'missing', counts: null } },
        { serviceId: 'api', framework: 'spring-boot', scan: { status: 'missing', counts: null } },
      ],
    });
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('Sign in');

    const select = document.querySelector<HTMLSelectElement>('#onboarding-service')!;
    await act(async () => {
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.body.textContent).not.toContain('provider timeout');
    expect(document.body.textContent).not.toContain('Sign in');
    expect(document.body.textContent).toContain('0 / 0');

    await click(button('Generate Doks'));
    expect(wizardRunScanMock).toHaveBeenLastCalledWith('api');
  });

  it('fails closed when the reloaded Hub is missing a successful Dok', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 1 },
      { stage: 'dok-done', dokId: 'NEW', success: true },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('Generation finished, but the Hub has no Doks');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('opens a nonempty existing Hub after a valid zero-work completion', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 0 },
      { stage: 'done', succeeded: 0, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(wizardGetDoksMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('View your Hub');
  });

  it('keeps a zero-work empty Hub in scan guidance instead of a failed or complete state', async () => {
    wizardGetDoksMock.mockResolvedValueOnce([]);
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 0 },
      { stage: 'done', succeeded: 0, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('No Dok candidates were found');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('Retry remaining');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('preserves an IA error while a later code-mapping layer succeeds', async () => {
    wizardGetDoksMock.mockResolvedValueOnce([]);
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 0 },
      { stage: 'ia', serviceId: 'web', status: 'error', count: 0, error: 'ia file is invalid' },
      { stage: 'code-mapping', serviceId: 'web', status: 'written', count: 2 },
      { stage: 'done', succeeded: 0, failed: 0, layerFailed: 1 },
      { stage: 'error', message: 'Generate completed with 1 layer failed.' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('ia file is invalid');
    expect(document.body.textContent).not.toContain('No Dok candidates were found');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('marks a missing response body as a terminal failure', async () => {
    queueGenerationResponse(new Response(null, { status: 200 }));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('no progress stream');
  });

  it('reconciles a persisted Dok before classifying a rejected progress stream', async () => {
    wizardGetDoksMock.mockResolvedValueOnce([
      { dok_id: 'AUTH-SIGNIN', name: 'Persisted sign in', status: 'draft', anchorFiles: [] },
    ]);
    queueGenerationResponse(new Response(rejectedJsonStream('socket disconnected')));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(wizardGetDoksMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Persisted sign in');
    expect(document.body.textContent).toContain('Retry remaining');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'generation may still be active',
    );
  });

  it('keeps an unchanged restored partial Hub after the retry stream disconnects', async () => {
    const restoredPartial: WizardWorkspaceState = {
      ...initialState,
      existingDoks: 1,
      doks: [{
        dok_id: 'AUTH-SIGNIN',
        name: 'Persisted sign in',
        status: 'draft',
        anchorFiles: ['app/login/page.tsx'],
      }],
      generation: {
        status: 'partial',
        summary: {
          sourceFeatures: 4,
          success: 3,
          skipped: 0,
          failed: 1,
          dokTargets: 2,
          dokTargetIds: ['AUTH-SIGNIN', 'AUTH-SIGNUP'],
        },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    };
    const transport = openJsonStream();
    wizardGetDoksMock.mockResolvedValueOnce(restoredPartial.doks);
    queueGenerationResponse(new Response(transport.stream));
    await renderOnboarding(restoredPartial);
    await click(button('Resume remaining work'));
    await click(button('Retry remaining'));

    await act(async () => {
      transport.emit({ stage: 'plan', total: 1 });
      transport.fail('socket disconnected');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(wizardGetDoksMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Persisted sign in');
    expect(document.body.textContent).toContain('1 / 2');
    expect(document.body.textContent).toContain('Retry remaining');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'generation may still be active',
    );
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('does not repaint generated Doks when successful done reaches EOF without clean-close', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 1 },
      { stage: 'dok-start', dokId: 'AUTH-SIGNIN' },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('before clean completion');
    expect(receiptRow('Dok generation').textContent).toContain('Generated AUTH-SIGNIN');
    expect(receiptRow('Dok generation').textContent).not.toContain('Failed');
  });

  it('keeps a zero-work stream without clean-close as a protocol failure', async () => {
    wizardGetDoksMock.mockResolvedValueOnce([]);
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 0 },
      { stage: 'done', succeeded: 0, failed: 0, layerFailed: 0 },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'before clean completion',
    );
    expect(document.body.textContent).not.toContain('No Dok candidates were found');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('keeps completed Doks and layers truthful after a standalone bridge error', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 1 },
      { stage: 'dok-start', dokId: 'AUTH-SIGNIN' },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'ia', serviceId: 'web', status: 'written', count: 2 },
      { stage: 'code-mapping', serviceId: 'web', status: 'written', count: 2 },
      { stage: 'error', message: 'credentials unavailable' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('credentials unavailable');
    expect(receiptRow('Dok generation').textContent).not.toContain('Failed');
    expect(receiptRow('IA').textContent).toContain('Complete');
    expect(receiptRow('Code mapping').textContent).toContain('Complete');
  });

  it('keeps the Dok row failed when a later Dok succeeds before a standalone error', async () => {
    queueGenerationResponse(new Response(jsonStream([
      { stage: 'plan', total: 2 },
      { stage: 'dok-done', dokId: 'AUTH-SIGNUP', success: false, error: 'AUTH-SIGNUP provider timeout' },
      { stage: 'dok-start', dokId: 'AUTH-SIGNIN' },
      { stage: 'dok-done', dokId: 'AUTH-SIGNIN', success: true },
      { stage: 'error', message: 'credentials unavailable after generation' },
    ])));
    await renderOnboarding();
    await click(button('Get started'));
    await click(button('Generate Doks'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('credentials unavailable');
    expect(receiptRow('Dok generation').textContent).toContain('AUTH-SIGNUP provider timeout');
    expect(receiptRow('Dok generation').textContent).toContain('Failed');
  });

  it('labels the locale control and focuses the next step heading', async () => {
    await renderOnboarding();
    const locale = document.querySelector('[role="group"]')!;
    expect(locale.getAttribute('aria-label')).toBe('Language');
    expect(document.querySelector('button[aria-pressed="true"]')?.textContent).toBe('EN');
    await click(button('Get started'));
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.body.textContent).toContain('Waiting');
  });
});
