// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerRailNav } from '../components/layer-rail-nav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/livedocs',
}));
vi.mock('../components/studio-store', () => ({
  useStudio: () => ({
    layerCounts: {
      doks: 8,
      lexicon: 4,
      ia: 2,
      roles: 3,
    },
  }),
}));

describe('LayerRail Publication count', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    root = createRoot(host);
    vi.stubGlobal('React', React);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      publications: [{}, {}],
    })));
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

  it('shows the persisted Publication count instead of the Template gallery count', async () => {
    await act(async () => {
      root.render(<LayerRailNav />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(
      host.querySelector<HTMLAnchorElement>('a[href="/livedocs"]')
        ?.textContent,
    ).toMatch(/Live Docs\s*2/);
  });
});
