// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidationAction } from '../lib/hooks/use-consolidation-reducer';
import type { ConsolidatedFeature, ConsolidatedFeatureGroup } from '../lib/consolidation';
import { FeatureRow } from '../components/consolidation/feature-row';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function feature(overrides: Partial<ConsolidatedFeature> = {}): ConsolidatedFeature {
  return {
    canonical_id: 'auth-signin',
    label: 'Sign in',
    decision: 'keep',
    members: ['auth-signin'],
    primary_route: '/signin',
    reason: '',
    user_reviewed: false,
    dok_id_prefix: 'AUTH-SIGNIN',
    ...overrides,
  };
}

function renderRow(
  f: ConsolidatedFeature,
  groups: ConsolidatedFeatureGroup[] = [],
  onAct: (a: ConsolidationAction) => void = vi.fn(),
): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ul>
        <FeatureRow
          feature={f}
          groupId="auth"
          groups={groups}
          onAct={onAct}
          onConfirmAct={vi.fn()}
          selected={false}
          onToggleSelect={vi.fn()}
        />
      </ul>,
    );
  });
  return container;
}

function prefixInput(container: ParentNode, label: ConsolidatedFeature['label']): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `input[aria-label="Edit dok_id_prefix for ${label}"]`,
  );
}

// React tracks the DOM node's "last known value" on the instance itself, so a
// plain `el.value = x` (which goes through that same tracked setter) leaves
// nothing for the synthetic change/input handler to detect — it never fires.
// Going through the native prototype setter bypasses React's tracking, which
// is the established workaround already used elsewhere in this suite (see
// editor-persistence.test.tsx, honest-controls.test.tsx).
function typeInto(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('FeatureRow', () => {
  it('renders the dok_id_prefix verbatim, without a dead -001 serial suffix', () => {
    const container = renderRow(feature({ dok_id_prefix: 'AUTH-SIGNIN' }));
    expect(prefixInput(container, 'Sign in')?.value).toBe('AUTH-SIGNIN');
    expect(container.textContent).not.toContain('-001');
  });

  it('renders a 3-segment dok_id_prefix exactly as given', () => {
    const container = renderRow(feature({ dok_id_prefix: 'ADMIN-USER-BAN' }));
    expect(prefixInput(container, 'Sign in')?.value).toBe('ADMIN-USER-BAN');
  });

  it('renders the dok_id_prefix as an editable, valid-looking input for a live feature', () => {
    const container = renderRow(feature({ dok_id_prefix: 'AUTH-SIGNIN', decision: 'keep' }));
    const input = prefixInput(container, 'Sign in');
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);
    expect(input?.getAttribute('aria-invalid')).toBe('false');
  });

  it('flags a lowercase dok_id_prefix as invalid without reverting the typed value', () => {
    const container = renderRow(feature({ dok_id_prefix: 'auth-signin' }));
    const input = prefixInput(container, 'Sign in');
    // Not blocked/rewritten — the exact (invalid) value the user has stays visible.
    expect(input?.value).toBe('auth-signin');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.className).toContain('status-draft-fg');
  });

  it('flags a BR-reserved dok_id_prefix as invalid (grammar-valid but reserved segment)', () => {
    const container = renderRow(feature({ dok_id_prefix: 'BR-FOO' }));
    const input = prefixInput(container, 'Sign in');
    expect(input?.value).toBe('BR-FOO');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
  });

  it('dispatches editDokIdPrefix with the exact typed value on change', () => {
    const onAct = vi.fn();
    const container = renderRow(feature({ dok_id_prefix: 'AUTH-SIGNIN' }), [], onAct);
    const input = prefixInput(container, 'Sign in');
    if (!input) throw new Error('Expected the dok_id_prefix input.');
    act(() => typeInto(input, 'AUTH-LOGIN'));
    expect(onAct).toHaveBeenCalledWith({
      type: 'editDokIdPrefix',
      canonicalId: 'auth-signin',
      dokIdPrefix: 'AUTH-LOGIN',
    });
  });

  it('does not render an editable prefix input for an excluded feature', () => {
    const container = renderRow(feature({ decision: 'exclude', dok_id_prefix: 'AUTH-SIGNIN' }));
    expect(prefixInput(container, 'Sign in')).toBeNull();
    expect(container.querySelector('span.font-mono')?.textContent).toBe('AUTH-SIGNIN');
  });
});
