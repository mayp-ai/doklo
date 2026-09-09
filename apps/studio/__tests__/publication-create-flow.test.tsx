// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicationCreateFlow } from '../components/publication-create-flow';
import type {
  PublicationTemplateReadModel,
  PublicationWorkspaceModel,
} from '../lib/publication-read-model';

describe('PublicationCreateFlow', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    root = createRoot(host);
    vi.stubGlobal('React', React);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      previewResponse('<article>Stable preview</article>'),
    )));
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

  it('renders all five steps and never offers local automatic publishing', async () => {
    await render(model('en'));

    expect(stepLabels()).toEqual([
      'Choose document',
      'Choose content',
      'Choose update behavior',
      'Choose output and delivery',
      'Review',
    ]);
    expect(host.textContent).toContain('Review before publishing');
    expect(host.textContent).toContain('Manual');
    expect(host.textContent).not.toMatch(/automatic publishing/i);
  });

  it('uses Template scope defaults and keeps output language independent', async () => {
    await render(model('en'));
    await click(button('Alpha Experimental'));
    await click(button('Continue'));

    const allEligible = inputByLabel('All eligible') as HTMLInputElement;
    expect(allEligible.checked).toBe(true);
    expect(host.textContent).toContain('2 Doks');

    await click(button('Continue'));
    await click(button('Continue'));
    const locale = selectByLabel('Document language');
    expect([...locale.options].map((option) => option.value)).toEqual(['en', 'ko']);
  });

  it('initializes the draft from the Template default format instead of display order', async () => {
    const initial = model('en');
    initial.templates[0] = {
      ...initial.templates[0]!,
      output_formats: ['markdown', 'html'],
      default_format: 'html',
    };

    await render(initial);
    await click(button('Continue'));
    await click(button('Continue'));
    await click(button('Continue'));

    expect(selectByLabel('Output format').value).toBe('html');
  });

  it('shows supported and default formats independently from the preview canvas format', async () => {
    await render(model('en'));

    expect(previewFact('Supported formats')).toBe('Markdown · HTML');
    expect(previewFact('Default')).toBe('Markdown');
  });

  it('advances to content selection when the chosen document is confirmed', async () => {
    await render(model('en'));

    await click(button('Use this document'));

    expect(
      host.querySelector('[data-active-create-step]')
        ?.getAttribute('data-active-create-step'),
    ).toBe('2');
    expect(
      host.querySelector('[aria-hidden="false"] h2')?.textContent,
    ).toBe('Choose content');
  });

  it('filters the stable-first Template catalog by status and reader context', async () => {
    await render(model('en'));

    expect(templateOptionNames()).toEqual([
      'Stable Help',
      'Alpha Experimental',
      'Zulu Experimental',
    ]);
    expect(templateFilterLabels()).toEqual([
      'All',
      'Stable',
      'Experimental',
    ]);
    expect(host.textContent).not.toContain('Recommended');
    expect(host.textContent).not.toContain('Per Dok');
    expect(host.textContent).not.toContain('Whole product');

    await click(button('Experimental'));
    expect(templateOptionNames()).toEqual([
      'Alpha Experimental',
      'Zulu Experimental',
    ]);

    await typeInto(inputByPlaceholder('Search templates'), 'leadership');
    expect(templateOptionNames()).toEqual(['Alpha Experimental']);
  });

  it('loads the selected Template preview and ignores the aborted stale result', async () => {
    const stableRequest = deferred<Response>();
    const alphaRequest = deferred<Response>();
    const mockedFetch = vi.mocked(globalThis.fetch);
    mockedFetch.mockImplementation((input) => {
      const url = String(input);
      return url.includes('/stable-help/')
        ? stableRequest.promise
        : alphaRequest.promise;
    });
    await render(model('en'));

    const stableCall = mockedFetch.mock.calls.find(
      ([input]) => String(input).includes('/stable-help/'),
    );
    expect(stableCall).toBeDefined();
    await click(templateOption('Alpha Experimental'));

    const alphaCalls = mockedFetch.mock.calls.filter(
      ([input]) => String(input)
        === '/api/livedocs/templates/alpha-experimental/preview',
    );
    expect(alphaCalls).toHaveLength(1);
    expect(alphaCalls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ locale: 'en' }),
    });
    expect((stableCall?.[1]?.signal as AbortSignal | undefined)?.aborted)
      .toBe(true);
    expect(livePreviewStatus()).toContain('Preparing candidate preview');
    expect(templateOption('Alpha Experimental').getAttribute('aria-selected'))
      .toBe('true');

    alphaRequest.resolve(previewResponse(
      '<article data-preview="alpha">Alpha preview</article>',
    ));
    await flush();

    const iframe = host.querySelector<HTMLIFrameElement>(
      'iframe[title="Alpha Experimental document preview"]',
    );
    expect(iframe?.srcdoc).toContain('data-preview="alpha"');
    expect(button('Use this document')).toBeTruthy();

    stableRequest.resolve(previewResponse(
      '<article data-preview="stale">Stale preview</article>',
    ));
    await flush();
    expect(iframe?.srcdoc).not.toContain('data-preview="stale"');
  });

  it('moves and selects Template options with listbox arrow keys', async () => {
    await render(model('en'));
    const stableOption = templateOption('Stable Help');
    stableOption.focus();

    await keyDown(stableOption, 'ArrowDown');

    const alphaOption = templateOption('Alpha Experimental');
    expect(document.activeElement).toBe(alphaOption);
    expect(stableOption.tabIndex).toBe(-1);
    expect(alphaOption.tabIndex).toBe(0);
    expect(alphaOption.getAttribute('aria-selected')).toBe('true');
    expect(vi.mocked(globalThis.fetch).mock.calls.some(
      ([input]) => String(input)
        === '/api/livedocs/templates/alpha-experimental/preview',
    )).toBe(true);
  });

  it('offers only eligible or direct Dok selection in Studio', async () => {
    await render(model('en'));
    await click(button('Continue'));

    expect(selectionLabels()).toEqual(['All eligible', 'Choose Doks']);
    expect(host.textContent).not.toContain('Filter');
  });

  it('keeps the draft when the already-selected Template is selected again', async () => {
    await render(model('en'));
    const name = host.querySelector<HTMLInputElement>('#publication-name');
    expect(name).not.toBeNull();
    await typeInto(name!, 'custom-publication-name');

    await click(templateOption('Stable Help'));

    expect(name!.value).toBe('custom-publication-name');
  });

  it('keeps a partially created Publication visible when its initial render fails', async () => {
    const initial = model('en');
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) === '/api/livedocs' && init?.method === 'POST') {
        const created = structuredClone(initial);
        return Response.json({
          status: 'partial',
          completed: ['create'],
          failed: 'render',
          code: 'PUBLICATION_RENDER_FAILED',
          model: created,
        }, { status: 207 });
      }
      return previewResponse('<article>Stable preview</article>');
    });
    await render(initial);
    for (let step = 1; step < 5; step += 1) {
      await click(button('Continue'));
    }

    await click(button('Create publication'));
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Publication created, but the initial document build failed.',
    );
    expect(
      host.querySelector<HTMLAnchorElement>(
        'a[href="/livedocs?publication=stable-help"]',
      )?.textContent,
    ).toContain('Open publication');
    expect(button('Create publication').disabled).toBe(false);
  });

  it('renders the complete Korean flow from the workspace locale', async () => {
    await render(model('ko'));

    expect(host.textContent).toContain('새 발행물');
    expect(stepLabels()).toEqual([
      '문서 선택',
      '내용 범위 선택',
      '갱신 방식 선택',
      '출력과 발행 설정',
      '최종 확인',
    ]);
    expect(templateFilterLabels()).toEqual([
      'All',
      'Stable',
      'Experimental',
    ]);
    expect(templateStabilityLabels()).toEqual([
      'Stable',
      'Experimental',
      'Experimental',
    ]);
    expect(host.textContent).toContain('일상적인 사용을 위해 검증되었습니다.');
    expect(host.textContent).toContain('공유 전에 검토하세요.');
    expect(host.textContent).toContain('이 문서 선택');
    expect(previewFact('지원 형식')).toBe('Markdown · HTML');
    expect(previewFact('기본값')).toBe('Markdown');
    expect(host.textContent).not.toMatch(/automatic/i);
  });

  async function render(initialModel: PublicationWorkspaceModel) {
    await act(async () => {
      root.render(<PublicationCreateFlow initialModel={initialModel} />);
    });
    await flush();
  }

  function button(name: string): HTMLButtonElement {
    const match = [...host.querySelectorAll('button')]
      .find((element) => element.textContent?.includes(name));
    if (!match) throw new Error(`Button not found: ${name}`);
    return match;
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => element.click());
  }

  async function keyDown(
    element: HTMLElement,
    key: string,
  ): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        key,
      }));
    });
    await flush();
  }

  async function typeInto(
    element: HTMLInputElement,
    value: string,
  ): Promise<void> {
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function inputByLabel(label: string): HTMLInputElement {
    const element = [...host.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.includes(label))
      ?.querySelector('input');
    if (!element) throw new Error(`Input not found: ${label}`);
    return element;
  }

  function selectByLabel(label: string): HTMLSelectElement {
    const id = [...host.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.includes(label))
      ?.htmlFor;
    const element = id
      ? host.querySelector<HTMLSelectElement>(`#${id}`)
      : undefined;
    if (!element) throw new Error(`Select not found: ${label}`);
    return element;
  }

  function stepLabels(): string[] {
    return [...host.querySelectorAll('[data-create-step]')]
      .map((element) => element.getAttribute('aria-label') ?? '');
  }

  function inputByPlaceholder(placeholder: string): HTMLInputElement {
    const element = host.querySelector<HTMLInputElement>(
      `input[placeholder="${placeholder}"]`,
    );
    if (!element) throw new Error(`Input not found: ${placeholder}`);
    return element;
  }

  function templateOption(name: string): HTMLButtonElement {
    const element = [...host.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    )].find((candidate) => candidate.textContent?.includes(name));
    if (!element) throw new Error(`Template option not found: ${name}`);
    return element;
  }

  function templateOptionNames(): string[] {
    return [...host.querySelectorAll('[role="option"]')]
      .map((element) =>
        element.querySelector('[data-template-name]')?.textContent ?? '',
      );
  }

  function templateFilterLabels(): string[] {
    return [...host.querySelectorAll('[data-template-filter]')]
      .map((element) => element.textContent ?? '');
  }

  function templateStabilityLabels(): string[] {
    return [...host.querySelectorAll('[data-template-stability]')]
      .map((element) => element.textContent ?? '');
  }

  function livePreviewStatus(): string {
    const element = host.querySelector('[aria-live="polite"]');
    if (!element) throw new Error('Preview live status not found');
    return element.textContent ?? '';
  }

  function previewFact(label: string): string | undefined {
    const term = [...host.querySelectorAll(
      '.publication-template-preview-facts dt',
    )].find((element) => element.textContent === label);
    return term?.parentElement?.querySelector('dd')?.textContent
      ?? undefined;
  }

  function selectionLabels(): string[] {
    return [...host.querySelectorAll<HTMLInputElement>(
      'input[name="selection-kind"]',
    )].map((input) =>
      input.closest('label')
        ?.querySelector('[data-selection-label]')
        ?.textContent
        ?? '',
    );
  }
});

function model(locale: 'en' | 'ko'): PublicationWorkspaceModel {
  return {
    locale,
    workspace_default_locale: locale,
    templates: [
      template({
        name: 'stable-help',
        display_name: locale === 'ko' ? '안정 도움말' : 'Stable Help',
        scope: 'per_dok',
        default_kind: 'explicit',
        stability: 'stable',
        description: locale === 'ko'
          ? '고객이 기능을 이해하도록 돕습니다.'
          : 'Help customers understand the product.',
        audience: locale === 'ko' ? '지원팀' : 'Support teams',
        purpose: locale === 'ko'
          ? '지원 문서를 최신으로 유지'
          : 'Keep support guidance current',
        job: locale === 'ko' ? '기능 이해' : 'Understand a feature',
      }),
      template({
        name: 'alpha-experimental',
        display_name: locale === 'ko' ? '알파 실험' : 'Alpha Experimental',
        scope: 'workspace',
        default_kind: 'all_eligible',
        stability: 'experimental',
        description: locale === 'ko'
          ? '리더십 검토를 위한 제품 개요입니다.'
          : 'A product overview for leadership review.',
        audience: locale === 'ko' ? '리더십' : 'Leadership',
        purpose: locale === 'ko'
          ? '제품 방향 공유'
          : 'Share product direction',
        job: locale === 'ko' ? '전략 검토' : 'Review strategy',
      }),
      template({
        name: 'zulu-experimental',
        display_name: locale === 'ko' ? '줄루 실험' : 'Zulu Experimental',
        scope: 'selected_doks',
        default_kind: 'template',
        stability: 'experimental',
        description: locale === 'ko'
          ? '제품 출시를 준비하는 튜토리얼입니다.'
          : 'A tutorial for preparing a product launch.',
        audience: locale === 'ko' ? '제품팀' : 'Product teams',
        purpose: locale === 'ko'
          ? '출시 준비'
          : 'Prepare a launch',
        job: locale === 'ko' ? '출시 계획' : 'Plan a launch',
        eligible_dok_ids: ['AUTH'],
      }),
    ],
    publications: [],
    doks: [
      {
        dok_id: 'AUTH',
        name: 'Authentication',
        status: 'active',
        tags: ['public'],
        surfaces: ['web'],
      },
      {
        dok_id: 'HELP',
        name: 'Help',
        status: 'active',
        tags: ['public'],
        surfaces: ['web'],
      },
    ],
    errors: [],
  };
}

function template(input: {
  name: string;
  display_name: string;
  scope: PublicationTemplateReadModel['scope'];
  default_kind: PublicationTemplateReadModel['selection']['default_kind'];
  stability: PublicationTemplateReadModel['stability'];
  description: string;
  audience: string;
  purpose: string;
  job: string;
  eligible_dok_ids?: string[];
}): PublicationTemplateReadModel {
  return {
    name: input.name,
    version: '1.0.0',
    source: 'builtin',
    stability: input.stability,
    display_name: input.display_name,
    description: input.description,
    audience: input.audience,
    purpose: input.purpose,
    job: input.job,
    required_input: 'Active Doks',
    scope: input.scope,
    default_format: 'markdown',
    output_formats: ['markdown', 'html'],
    supported_locales: ['en', 'ko'],
    default_locale: 'en',
    variables: {},
    selection: {
      scope: input.scope,
      eligible_dok_ids: input.eligible_dok_ids ?? ['AUTH', 'HELP'],
      default_kind: input.default_kind,
      allowed_kinds: ['all_eligible', 'filter', 'explicit'],
      excluded: [],
    },
  };
}

function previewResponse(html: string): Response {
  return Response.json({
    kind: 'html',
    fidelity: 'workspace',
    html,
    filename: 'preview.html',
    format: 'html',
    output_count: 1,
  });
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
