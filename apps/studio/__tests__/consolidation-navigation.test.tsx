// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidatedFeatureConfig } from '../lib/consolidation';
import { StudioProvider } from '../components/studio-store';

const {
  listConsolidatedServices,
  loadConsolidated,
  loadConsolidatedState,
  routerPush,
  saveConsolidated,
} = vi.hoisted(() => ({
  listConsolidatedServices: vi.fn(),
  loadConsolidated: vi.fn(),
  loadConsolidatedState: vi.fn(),
  routerPush: vi.fn(),
  saveConsolidated: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('../lib/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/data')>();
  return {
    ...actual,
    listConsolidatedServices,
    loadConsolidated,
    loadConsolidatedState,
  };
});

vi.mock('../lib/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/actions')>();
  return { ...actual, saveConsolidatedAction: saveConsolidated };
});

import ConsolidationPage from '../app/(hub)/consolidation/page';

const roots: Root[] = [];

function provider(children: ReactNode) {
  return (
    <StudioProvider layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}>
      {children}
    </StudioProvider>
  );
}

function configFor(service: string): ConsolidatedFeatureConfig {
  const canonicalId = `${service}-feature`;
  return {
    projectName: service,
    basedOnFeaturesAt: '2026-07-17T00:00:00.000Z',
    generatedAt: '2026-07-17T00:00:00.000Z',
    model: 'test',
    groups: [
      {
        group_id: `${service}-group`,
        label: `${service} group`,
        excluded: [],
        features: [
          {
            canonical_id: canonicalId,
            label: `${service} feature`,
            decision: 'keep',
            members: [canonicalId],
            primary_route: `/${service}`,
            reason: 'test fixture',
            user_reviewed: false,
            dok_id_prefix: service.toUpperCase(),
          },
        ],
      },
    ],
    originalFeatureIds: [canonicalId],
    userReviewed: false,
    stats: {
      originalFeatures: 1,
      consolidatedFeatures: 1,
      merges: 0,
      excluded: 0,
    },
  };
}

async function pageFor(service: string) {
  return ConsolidationPage({ searchParams: Promise.resolve({ service }) });
}

beforeEach(() => {
  routerPush.mockReset();
  saveConsolidated.mockReset();
  listConsolidatedServices.mockReset();
  loadConsolidated.mockReset();
  loadConsolidatedState.mockReset();
  listConsolidatedServices.mockResolvedValue(['web', 'api', 'worker']);
  loadConsolidated.mockImplementation(async (service: string) => configFor(service));
  loadConsolidatedState.mockImplementation(async (service: string) => ({
    kind: 'ready',
    path: `/workspace/.doklo/cache/${service}.consolidated.json`,
    revision: `rev-${service}-1`,
    data: configFor(service),
  }));
  saveConsolidated.mockResolvedValue({
    ok: true,
    path: '/workspace/.doklo/cache/api.consolidated.json',
    revision: 'rev-api-2',
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('consolidation service navigation', () => {
  it('remounts service B state before edits so saving B never submits service A config', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const webPage = await pageFor('web');
    act(() => root.render(provider(webPage)));

    const serviceSelect = document.querySelector<HTMLSelectElement>('select');
    if (!serviceSelect) throw new Error('Expected the service selector.');
    await act(async () => {
      serviceSelect.value = 'api';
      serviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(routerPush).toHaveBeenCalledWith('?service=api');

    const apiPage = await pageFor('api');
    act(() => root.render(provider(apiPage)));

    const exclude = document.querySelector<HTMLButtonElement>('button[aria-label="Exclude"]');
    const truthfulExclude = exclude ?? document.querySelector<HTMLButtonElement>('button[aria-label="Exclude api feature"]');
    if (!truthfulExclude) throw new Error('Expected the API feature exclude button.');
    act(() => truthfulExclude.click());
    const confirmExclude = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Exclude Dok',
    );
    if (!confirmExclude) throw new Error('Expected the exclude confirmation.');
    act(() => confirmExclude.click());
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Save',
    );
    if (!save) throw new Error('Expected the consolidation Save button.');
    await act(async () => save.click());

    expect(saveConsolidated).toHaveBeenCalledOnce();
    const [input] = saveConsolidated.mock.calls[0] as [{
      serviceId: string;
      config: ConsolidatedFeatureConfig;
      expectedRevision: string;
    }];
    const submitted = input.config;
    expect(input.serviceId).toBe('api');
    expect(input.expectedRevision).toBe('rev-api-1');
    expect(submitted.projectName).toBe('api');
    expect(submitted.groups[0].features[0]).toMatchObject({
      canonical_id: 'api-feature',
      decision: 'exclude',
    });
    expect(JSON.stringify(submitted)).not.toContain('web-feature');
  });

  it('coalesces a second service switch while the first query navigation is pending', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const webPage = await pageFor('web');
    act(() => root.render(provider(webPage)));
    const serviceSelect = document.querySelector<HTMLSelectElement>('select');
    if (!serviceSelect) throw new Error('Expected the service selector.');

    await act(async () => {
      serviceSelect.value = 'api';
      serviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      serviceSelect.value = 'worker';
      serviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(routerPush).toHaveBeenCalledOnce();
    expect(routerPush).toHaveBeenCalledWith('?service=api');
  });
});
