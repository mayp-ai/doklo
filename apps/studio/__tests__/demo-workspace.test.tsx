// @vitest-environment jsdom

// Honest first run: the sample workspace bundled with Studio must never be
// mistakable for the user's own analysis. It carries an on-disk marker, and
// every Studio surface renders an explicit demo label because of it.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  loadAllIaMock,
  loadDemoWorkspaceStateMock,
  loadDoksStateMock,
  loadLexiconStateMock,
  loadRolesStateMock,
  loadWorkspaceStateMock,
} = vi.hoisted(() => ({
  loadAllIaMock: vi.fn(),
  loadDemoWorkspaceStateMock: vi.fn(),
  loadDoksStateMock: vi.fn(),
  loadLexiconStateMock: vi.fn(),
  loadRolesStateMock: vi.fn(),
  loadWorkspaceStateMock: vi.fn(),
}));

vi.mock('../lib/data', () => ({
  loadAllIa: loadAllIaMock,
  loadDoksState: loadDoksStateMock,
  loadLexiconState: loadLexiconStateMock,
  loadRolesState: loadRolesStateMock,
  loadWorkspaceState: loadWorkspaceStateMock,
  workspaceRoot: () => '/workspace',
}));

vi.mock('../lib/demo-workspace', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/demo-workspace')>(),
  loadDemoWorkspaceState: loadDemoWorkspaceStateMock,
}));

import RootLayout from '../app/layout';
import { DemoWorkspaceBanner } from '../components/demo-workspace-banner';
import { demoMarkerPath, loadDemoWorkspaceState } from '../lib/demo-workspace';

const STUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** The un-mocked implementation, exercised against real directories. */
const realLoadDemoWorkspaceState = await vi
  .importActual<typeof import('../lib/demo-workspace')>('../lib/demo-workspace')
  .then((mod) => mod.loadDemoWorkspaceState);

async function workspaceTmp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-demo-marker-'));
  await mkdir(join(root, '.doklo'), { recursive: true });
  return root;
}

/** Depth-first search over a returned server-component element tree. */
function findElement(
  node: ReactNode,
  match: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  const props = node.props as { children?: ReactNode };
  return findElement(props.children, match);
}

const roots: Root[] = [];

function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadWorkspaceStateMock.mockResolvedValue({
    kind: 'ready',
    path: '/workspace/workspace.json',
    revision: 'w',
    data: { workspace_id: 'ws', name: 'Workspace', services: [], default_locale: 'en' },
  });
  loadDoksStateMock.mockResolvedValue({
    kind: 'empty',
    path: '/workspace/.doklo/hub/doks',
    revision: 'd',
    data: { doks: [], revisions: {}, paths: {} },
  });
  loadLexiconStateMock.mockResolvedValue({
    kind: 'empty',
    path: '/workspace/.doklo/hub/lexicon.json',
    revision: 'l',
    data: { version: 1, terms: [] },
  });
  loadRolesStateMock.mockResolvedValue({
    kind: 'empty',
    path: '/workspace/.doklo/hub/roles.json',
    revision: 'r',
    data: { version: 1, roles: [] },
  });
  loadAllIaMock.mockResolvedValue({});
  loadDemoWorkspaceStateMock.mockResolvedValue({
    status: 'own',
    markerPath: '/workspace/.doklo/DEMO_WORKSPACE',
    reason: null,
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
});

describe('demo workspace detection', () => {
  it('resolves the marker under the workspace .doklo directory', () => {
    expect(demoMarkerPath('/workspace')).toBe('/workspace/.doklo/DEMO_WORKSPACE');
  });

  it('reports a workspace with no marker as the user’s own', async () => {
    const root = await workspaceTmp();

    await expect(realLoadDemoWorkspaceState(root)).resolves.toEqual({
      status: 'own',
      markerPath: demoMarkerPath(root),
      reason: null,
    });
  });

  it('reports a marked workspace as demo data', async () => {
    const root = await workspaceTmp();
    await writeFile(demoMarkerPath(root), 'Sample data bundled with Doklo Studio.\n', 'utf-8');

    await expect(realLoadDemoWorkspaceState(root)).resolves.toEqual({
      status: 'demo',
      markerPath: demoMarkerPath(root),
      reason: null,
    });
  });

  it('reports an unreadable marker as unverified, not as demo, and keeps the reason', async () => {
    const root = await workspaceTmp();
    // Present but not readable as a file: neither "this is the sample" nor
    // "this is yours" can be claimed from it.
    await mkdir(demoMarkerPath(root));

    await expect(realLoadDemoWorkspaceState(root)).resolves.toEqual({
      status: 'unverified',
      markerPath: demoMarkerPath(root),
      reason: 'EISDIR',
    });
  });

  it('reports a workspace with no .doklo directory at all as the user’s own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-demo-bare-'));

    await expect(realLoadDemoWorkspaceState(root)).resolves.toMatchObject({ status: 'own' });
  });
});

describe('bundled sample workspace', () => {
  it('ships the demo marker so Studio can never render it as real analysis', () => {
    const marker = readFileSync(join(STUDIO_DIR, 'demo', '.doklo', 'DEMO_WORKSPACE'), 'utf-8');

    expect(marker.trim().length).toBeGreaterThan(0);
    expect(marker.toLowerCase()).toContain('demo');
  });

  it('names itself as a demo in its own workspace metadata', () => {
    const workspace = JSON.parse(
      readFileSync(join(STUDIO_DIR, 'demo', 'workspace.json'), 'utf-8'),
    ) as { name: string; workspace_id: string };

    expect(workspace.name.toLowerCase()).toContain('demo');
    expect(workspace.workspace_id.toLowerCase()).toContain('demo');
  });
});

describe('DemoWorkspaceBanner', () => {
  it('states the data is a demo, denies it came from the user’s code, and names the real commands', () => {
    const container = render(
      <DemoWorkspaceBanner
        state={{ status: 'demo', markerPath: '/ws/.doklo/DEMO_WORKSPACE', reason: null }}
      />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('Demo data');
    expect(text).toMatch(/not (generated )?from your code/i);
    expect(text).toContain('doklo init');
    expect(text).toContain('doklo generate');
  });

  it('claims nothing when the marker could not be read, and shows why', () => {
    const container = render(
      <DemoWorkspaceBanner
        state={{ status: 'unverified', markerPath: '/ws/.doklo/DEMO_WORKSPACE', reason: 'EACCES' }}
      />,
    );
    const text = container.textContent ?? '';

    // Asserting "this is the bundled sample" over the user's real Hub is the
    // same dishonesty in the other direction.
    expect(text).not.toMatch(/not (generated )?from your code/i);
    expect(text).not.toMatch(/\bDemo data\b/);
    expect(text).toMatch(/could not|couldn’t|unable/i);
    expect(text).toContain('/ws/.doklo/DEMO_WORKSPACE');
    expect(text).toContain('EACCES');
  });
});

describe('RootLayout demo labeling', () => {
  it('marks the document and renders the banner for a demo workspace', async () => {
    loadDemoWorkspaceStateMock.mockResolvedValue({
      status: 'demo',
      markerPath: '/workspace/.doklo/DEMO_WORKSPACE',
      reason: null,
    });

    const tree = await RootLayout({ children: null });
    const body = findElement(tree, (element) => element.type === 'body');

    expect(body).not.toBeNull();
    expect((body!.props as Record<string, unknown>)['data-doklo-workspace']).toBe('demo');
    expect(findElement(tree, (element) => element.type === DemoWorkspaceBanner)).not.toBeNull();
  });

  it('marks an unverified workspace distinctly from a demo one', async () => {
    loadDemoWorkspaceStateMock.mockResolvedValue({
      status: 'unverified',
      markerPath: '/workspace/.doklo/DEMO_WORKSPACE',
      reason: 'EACCES',
    });

    const tree = await RootLayout({ children: null });
    const body = findElement(tree, (element) => element.type === 'body');
    const banner = findElement(tree, (element) => element.type === DemoWorkspaceBanner);

    expect((body!.props as Record<string, unknown>)['data-doklo-workspace']).toBe('unverified');
    expect(banner).not.toBeNull();
    expect((banner!.props as { state: { status: string; reason: string | null } }).state).toEqual({
      status: 'unverified',
      markerPath: '/workspace/.doklo/DEMO_WORKSPACE',
      reason: 'EACCES',
    });
  });

  it('leaves a real workspace unlabeled', async () => {
    const tree = await RootLayout({ children: null });
    const body = findElement(tree, (element) => element.type === 'body');

    expect((body!.props as Record<string, unknown>)['data-doklo-workspace']).toBeUndefined();
    expect(findElement(tree, (element) => element.type === DemoWorkspaceBanner)).toBeNull();
  });
});
