// @vitest-environment jsdom

// Honest first run: the wizard's MCP cut illustrates querying the Hub the
// user just generated. When that Hub holds no Dok there is nothing to query,
// and the illustration must say so instead of naming a Dok the user does not
// have — a borrowed ID reads as "Doklo found AUTH-SIGNIN in your code".

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingProvider } from '../components/onboarding/onboarding-store';
import { StepHub } from '../components/onboarding/step-hub';
import type { WizardWorkspaceState } from '../lib/wizard-actions';

vi.mock('../lib/wizard-actions', () => ({
  wizardRunScan: vi.fn(),
  wizardGetDoks: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function state(doks: WizardWorkspaceState['doks']): WizardWorkspaceState {
  return {
    workspaceName: 'Atlas',
    workspacePath: '/workspace',
    services: [{ serviceId: 'web', framework: 'nextjs', scan: { status: 'missing', counts: null } }],
    existingDoks: doks.length,
    doks,
    generation: { status: 'none', summary: null, completedAt: null },
    model: null,
    provider: null,
  };
}

function renderHub(doks: WizardWorkspaceState['doks']): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <OnboardingProvider initialState={state(doks)}>
        <StepHub />
      </OnboardingProvider>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('onboarding Hub step — MCP illustration', () => {
  it('queries a Dok the workspace actually holds', () => {
    const host = renderHub([
      { dok_id: 'BILLING-INVOICE', name: 'Issue an invoice', status: 'draft', anchorFiles: [] },
    ]);
    const text = host.textContent ?? '';

    expect(text).toContain('doklo.get_dok("BILLING-INVOICE")');
    expect(text).toContain('Issue an invoice');
    expect(text.toLowerCase()).not.toContain('example');
  });

  it('names no Dok at all when the Hub is empty, and labels the shape as an example', () => {
    const host = renderHub([]);
    const text = host.textContent ?? '';

    expect(text).not.toContain('AUTH-SIGNIN');
    expect(text).not.toMatch(/doklo\.get_dok\("[A-Z][A-Z0-9-]*"\)/);
    expect(text.toLowerCase()).toContain('example');
  });
});
