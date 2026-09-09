// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingShell } from '../components/onboarding/shell';
import type { WizardWorkspaceState } from '../lib/wizard-actions';

vi.mock('../lib/wizard-actions', () => ({
  wizardRunScan: vi.fn(),
  wizardGetDoks: vi.fn(),
}));

const roots: Root[] = [];

function workspaceState(
  overrides: Partial<WizardWorkspaceState> = {},
): WizardWorkspaceState {
  return {
    workspaceName: 'Atlas',
    workspacePath: '/workspace/atlas',
    services: [{
      serviceId: 'web',
      framework: 'nextjs',
      scan: { status: 'ready', counts: { routes: 2, components: 4, stores: 1 } },
    }],
    existingDoks: 0,
    doks: [],
    generation: { status: 'none', summary: null, completedAt: null },
    model: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    ...overrides,
  };
}

async function renderOnboarding(initialState: ReturnType<typeof workspaceState>): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<OnboardingShell workspaceName="Atlas" initialState={initialState} />);
  });
}

function button(name: string): HTMLButtonElement {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!target) throw new Error(`Could not find button: ${name}`);
  return target;
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('persisted onboarding readiness', () => {
  it.each(['missing', 'invalid', 'unreadable'] as const)(
    'explains that a %s scan cache will be refreshed automatically',
    async (status) => {
      await renderOnboarding(workspaceState({
        services: [{ serviceId: 'web', framework: 'nextjs', scan: { status, counts: null } }],
      }));

      expect(document.body.textContent).toContain(
        'Doklo will scan automatically before generation',
      );
    },
  );

  it('provides the automatic scan explanation in Korean', async () => {
    await renderOnboarding(workspaceState({
      services: [{
        serviceId: 'web',
        framework: 'nextjs',
        scan: { status: 'unreadable', counts: null },
      }],
    }));

    await act(async () => {
      button('KO').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('생성 전에 Doklo가 자동으로 다시 스캔합니다');
  });

  it('routes an empty persisted generation back to scan guidance instead of a ready Hub', async () => {
    await renderOnboarding(workspaceState({
      services: [{
        serviceId: 'web',
        framework: 'nextjs',
        scan: { status: 'ready', counts: { routes: 0, components: 0, stores: 0 } },
      }],
      generation: {
        status: 'no-candidates',
        summary: { sourceFeatures: 0, success: 0, skipped: 0, failed: 0 },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    }));

    expect(document.body.textContent).toContain('last scan found no Dok candidates');
    expect(document.body.textContent).not.toContain('Your Hub is ready');

    await act(async () => {
      button('Review scan scope').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('No Dok candidates were found');
    expect(document.body.textContent).not.toContain('View your Hub');
  });

  it('restores the receipt total from the union of Hub Doks and ledger targets', async () => {
    await renderOnboarding(workspaceState({
      existingDoks: 2,
      doks: [
        { dok_id: 'AUTH-SIGNIN', name: 'Sign in', status: 'draft', anchorFiles: [] },
        { dok_id: 'CAT', name: 'Catalog', status: 'draft', anchorFiles: [] },
      ],
      generation: {
        status: 'partial',
        summary: {
          sourceFeatures: 4,
          success: 3,
          skipped: 0,
          failed: 1,
          dokTargets: 2,
          dokTargetIds: ['AUTH-SIGNIN', 'MSG'],
        },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    }));

    await act(async () => {
      button('Resume remaining work').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('2 / 3');
  });

  it('renders cached scan and zero-success failure state before consent', async () => {
    await renderOnboarding(workspaceState({
      generation: {
        status: 'failed',
        summary: { sourceFeatures: 1, success: 0, skipped: 0, failed: 1 },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    }));

    expect(document.body.textContent).toContain('/workspace/atlas');
    expect(document.body.textContent).toContain('2 routes · 4 components · 1 store');
    expect(document.body.textContent).toContain('last generation stopped with 1 failed item');
    expect(button('Resume remaining work')).toBeTruthy();
  });

  it('does not call a complete Hub remaining work and restores persisted Doks', async () => {
    await renderOnboarding(workspaceState({
      existingDoks: 1,
      doks: [{
        dok_id: 'AUTH-SIGNIN',
        name: 'Sign in',
        status: 'draft',
        anchorFiles: ['app/login/page.tsx'],
      }],
      generation: {
        status: 'complete',
        summary: { sourceFeatures: 1, success: 1, skipped: 0, failed: 0 },
        completedAt: '2026-07-23T00:01:00.000Z',
      },
    }));

    expect(document.body.textContent).toContain('last generation completed');
    expect(document.body.textContent).not.toContain('remaining work');

    await act(async () => {
      button('Check for code changes').click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Sign in');
  });
});
