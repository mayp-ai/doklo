// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../components/app-header';
import { StudioProvider } from '../components/studio-store';

vi.mock('next/navigation', () => ({
  usePathname: () => '/doks/AUTH-SIGNIN',
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('AppHeader navigation', () => {
  it('links the Dok editor breadcrumb back to the Dok collection', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <StudioProvider
          layerCounts={{ doks: 1, lexicon: 0, ia: 0, roles: 0 }}
        >
          <AppHeader workspace={null} />
        </StudioProvider>,
      );
    });

    const dokLinks = [...container.querySelectorAll<HTMLAnchorElement>('a')]
      .filter((anchor) => anchor.textContent?.trim() === 'Doks');

    expect(dokLinks).toHaveLength(1);
    expect(dokLinks[0]?.getAttribute('href')).toBe('/doks');
  });
});
