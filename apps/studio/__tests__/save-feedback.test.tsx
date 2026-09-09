// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../components/app-header';
import {
  StudioProvider,
  useStudio,
  type SaveStatus,
} from '../components/studio-store';

vi.mock('next/navigation', () => ({
  usePathname: () => '/doks/AUTH-SIGNIN',
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function StatusSeed({ status }: { status: SaveStatus }) {
  const { setSaveStatus } = useStudio();
  useEffect(() => setSaveStatus(status), [setSaveStatus, status]);
  return null;
}

function provider(children: ReactNode) {
  return (
    <StudioProvider layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}>
      {children}
    </StudioProvider>
  );
}

function renderStatus(
  status: SaveStatus,
  options: { reloadPage?: () => void } = {},
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(provider(
    <>
      <StatusSeed status={status} />
      <AppHeader workspace={null} reloadPage={options.reloadPage} />
    </>,
  )));
  return container;
}

function buttonByText(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('persistent save feedback', () => {
  it.each([
    {
      kind: 'error' as const,
      path: '/workspace/.doklo/hub/doks/AUTH-SIGNIN.json',
      message: 'disk is read only',
      expected: 'Save failed · /workspace/.doklo/hub/doks/AUTH-SIGNIN.json: disk is read only',
    },
    {
      kind: 'conflict' as const,
      path: '/workspace/.doklo/hub/roles.json',
      message: 'changed outside Studio',
      expected: 'File changed outside Studio · /workspace/.doklo/hub/roles.json',
    },
  ])('keeps $kind visible after ten seconds and exposes its real Retry', async ({ kind, path, message, expected }) => {
    const retry = vi.fn(async () => true);
    const container = renderStatus({ kind, path, message, retry });

    expect(container.textContent).toContain(expected);
    act(() => vi.advanceTimersByTime(10_000));
    expect(container.textContent).toContain(expected);

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Retry',
    );
    if (!button) throw new Error('Expected a Retry button.');
    await act(async () => button.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('offers Reload instead of Retry for a stale Server Action', () => {
    const retry = vi.fn(async () => false);
    const reloadPage = vi.fn();
    const container = renderStatus({
      kind: 'error',
      path: '/workspace/.doklo/hub/doks/AUTH-SIGNIN.json',
      message: 'Server Action "abc123" was not found on the server.',
      retry,
    }, { reloadPage });

    expect(container.textContent).toContain(
      'Studio restarted before this change could be saved · Reload required',
    );
    expect(buttonByText(container, 'Retry')).toBeNull();
    const reload = buttonByText(container, 'Reload');
    expect(reload).not.toBeNull();
    act(() => reload?.click());
    expect(reloadPage).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not classify an ordinary write failure as a restart', () => {
    const retry = vi.fn(async () => true);
    const container = renderStatus({
      kind: 'error',
      path: '/workspace/.doklo/hub/doks/AUTH-SIGNIN.json',
      message: 'disk is read only',
      retry,
    });

    expect(buttonByText(container, 'Retry')).not.toBeNull();
    expect(buttonByText(container, 'Reload')).toBeNull();
  });

  it.each([
    [{ kind: 'idle' } as SaveStatus, ''],
    [{ kind: 'dirty', path: '/workspace/dok.json' } as SaveStatus, 'Unsaved · /workspace/dok.json'],
    [{ kind: 'saving', path: '/workspace/dok.json' } as SaveStatus, 'Saving · /workspace/dok.json'],
    [{ kind: 'saved', path: '/workspace/dok.json' } as SaveStatus, 'Saved · /workspace/dok.json'],
  ])('maps %j to the exact header text', (status, expected) => {
    const container = renderStatus(status);
    const region = container.querySelector('[role="status"]');
    expect(region?.textContent).toBe(expected);
  });

  it('removes every legacy notifier and its fake no-op retry from production save controls', async () => {
    const paths = [
      '../components/studio-store.tsx',
      '../components/dok-editor.tsx',
      '../components/role-editor.tsx',
      '../components/lexicon-editor.tsx',
      '../components/translatable-editor.tsx',
      '../components/lexicon-suggestions.tsx',
    ];
    const sources = await Promise.all(
      paths.map((path) => readFile(resolve(process.cwd(), path.slice(3)), 'utf-8')),
    );
    const source = sources.join('\n');

    expect(source).not.toMatch(/notifySaving|notifySaved|notifySaveError/);
    expect(source).not.toContain('retry: async () => false');
  });
});
