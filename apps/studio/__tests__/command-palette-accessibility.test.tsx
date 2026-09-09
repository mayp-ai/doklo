// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { AppHeader } from '../components/app-header';
import { CommandPalette } from '../components/command-palette';
import { StudioProvider, useStudio } from '../components/studio-store';
import type { StudioIaTree } from '../lib/ia-route';

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/doks',
  useRouter: () => ({ push: routerPush }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

const dok = {
  dok_id: 'AUTH-SIGNIN',
  name: 'Authentication',
  description: 'Sign-in behavior',
  status: 'active',
  surfaces: ['web'],
  tags: [],
  _meta: { version: 1, history: [] },
} as Dok;

function TransientPaletteTrigger() {
  const { openPalette } = useStudio();
  const [visible, setVisible] = useState(true);
  return (
    <>
      {visible && (
        <button type="button" onClick={() => openPalette()}>
          Open transient search
        </button>
      )}
      <button type="button" onClick={() => setVisible(false)}>
        Remove transient trigger
      </button>
    </>
  );
}

function renderPalette(iaTrees: StudioIaTree[] = []) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: 1, lexicon: 0, ia: iaTrees.length, roles: 0 }}
        initialDoks={[dok]}
        initialIaTrees={iaTrees}
      >
        <AppHeader workspace={null} />
        <TransientPaletteTrigger />
        <CommandPalette />
      </StudioProvider>,
    );
  });
  return container;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  routerPush.mockReset();
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  if (originalScrollIntoView) {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
  document.body.replaceChildren();
});

describe('command palette accessibility', () => {
  it('moves initial focus from the opening trigger to Search', async () => {
    const container = renderPalette();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Open search"]');
    expect(trigger).not.toBeNull();
    trigger?.focus();

    await click(trigger as HTMLButtonElement);

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Search"]'));
  });

  it('wraps Tab at the last focusable and Shift+Tab at the first focusable', async () => {
    const container = renderPalette();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Open search"]');
    trigger?.focus();
    await click(trigger as HTMLButtonElement);

    const search = document.querySelector<HTMLInputElement>('[aria-label="Search"]');
    const result = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-palette-row]'),
    ].at(-1);
    expect(search).not.toBeNull();
    expect(result).not.toBeNull();

    result?.focus();
    const forwardTab = new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    });
    act(() => {
      result?.dispatchEvent(forwardTab);
    });
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);

    const backwardTab = new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    });
    act(() => {
      search?.dispatchEvent(backwardTab);
    });
    expect(backwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(result);
  });

  it('closes on Escape and restores the connected opening trigger', async () => {
    const container = renderPalette();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Open search"]');
    trigger?.focus();
    await click(trigger as HTMLButtonElement);

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('restores the stable header trigger after outside close when the opener was removed', async () => {
    const container = renderPalette();
    const fallback = container.querySelector<HTMLButtonElement>('[aria-label="Open search"]');
    const transient = buttonByText(container, 'Open transient search');
    transient.focus();
    await click(transient);
    await click(buttonByText(container, 'Remove transient trigger'));
    expect(transient.isConnected).toBe(false);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await click(dialog as HTMLElement);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fallback).not.toBeNull();
    expect(document.activeElement).toBe(fallback);
  });

  it('renders and preserves an explicit empty IA target path', async () => {
    const tree: StudioIaTree = {
      key: 'web::empty-path',
      serviceId: 'web',
      treeId: 'empty-path',
      type: 'sitemap',
      source: 'manual',
      platform: 'both',
      nodes: [{
        key: 'web::empty-path/root',
        path: '',
        seg: '',
        title: 'Empty path route',
        platform: 'both',
        tags: [],
        unmapped: true,
        children: [],
      }],
    };
    const container = renderPalette([tree]);
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open search"]',
    )!;
    await click(trigger);
    const routeResult = [...document.querySelectorAll<HTMLButtonElement>(
      '[data-palette-row]',
    )].find((row) => row.textContent?.includes('Empty path route'))!;

    expect(
      routeResult.querySelector('[aria-label="Empty path"]')?.textContent,
    ).toBe('""');

    await click(routeResult);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(routerPush).toHaveBeenCalledWith(
      '/ia?service=web&tree=empty-path&node=web%3A%3Aempty-path%2Froot&path=',
    );
  });
});
