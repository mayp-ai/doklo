// @vitest-environment jsdom

import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidatedFeatureConfig } from '../lib/consolidation';
import type { LoadState } from '../lib/load-state';
import { revisionOf } from '../lib/load-state';
import { StudioProvider } from '../components/studio-store';
import { SaveBar } from '../components/consolidation/save-bar';

const {
  listConsolidatedServices,
  loadConsolidated,
  loadConsolidatedState,
  saveConsolidated,
} = vi.hoisted(() => ({
  listConsolidatedServices: vi.fn(),
  loadConsolidated: vi.fn(),
  loadConsolidatedState: vi.fn(),
  saveConsolidated: vi.fn(),
}));

vi.mock('../lib/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/data')>()),
  listConsolidatedServices,
  loadConsolidated,
  loadConsolidatedState,
}));

vi.mock('../lib/actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/actions')>()),
  saveConsolidatedAction: saveConsolidated,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import ConsolidationPage from '../app/(hub)/consolidation/page';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const DEMO = resolve(process.cwd(), 'demo');
const originalRoot = process.env.DOKLO_WORKSPACE_ROOT;
const scratchRoots: string[] = [];
const roots: Root[] = [];

function configFor(service = 'web'): ConsolidatedFeatureConfig {
  const canonicalId = `${service}-feature`;
  return {
    projectName: service,
    basedOnFeaturesAt: '2026-07-17T00:00:00.000Z',
    generatedAt: '2026-07-17T00:00:00.000Z',
    model: 'test',
    groups: [{
      group_id: `${service}-group`,
      label: `${service} group`,
      excluded: [],
      features: [{
        canonical_id: canonicalId,
        label: `${service} feature`,
        decision: 'keep',
        members: [canonicalId],
        primary_route: `/${service}`,
        reason: 'test fixture',
        user_reviewed: false,
        dok_id_prefix: service.toUpperCase(),
      }],
    }],
    originalFeatureIds: [canonicalId],
    userReviewed: false,
    stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
  };
}

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'doklo-consolidation-state-')));
  scratchRoots.push(dir);
  await cp(DEMO, dir, { recursive: true });
  process.env.DOKLO_WORKSPACE_ROOT = dir;
  return dir;
}

function provider(children: ReactNode) {
  return (
    <StudioProvider layerCounts={{ doks: 0, lexicon: 0, ia: 0, roles: 0 }}>
      {children}
    </StudioProvider>
  );
}

function render(children: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(provider(children)));
  return container;
}

function SaveBarHarness(props: Omit<React.ComponentProps<typeof SaveBar>, 'dirty' | 'onSaved'>) {
  const [dirty, setDirty] = useState(true);
  return (
    <SaveBar
      {...props}
      dirty={dirty}
      onSaved={() => {
        setDirty(false);
        return true;
      }}
    />
  );
}

function button(container: ParentNode, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  listConsolidatedServices.mockResolvedValue(['web']);
  loadConsolidated.mockResolvedValue(configFor());
  loadConsolidatedState.mockResolvedValue({
    kind: 'ready',
    path: '/workspace/.doklo/cache/web.consolidated.json',
    revision: 'rev-1',
    data: configFor(),
  } satisfies LoadState<ConsolidatedFeatureConfig>);
});

afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  if (originalRoot === undefined) delete process.env.DOKLO_WORKSPACE_ROOT;
  else process.env.DOKLO_WORKSPACE_ROOT = originalRoot;
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('consolidation persisted load state', () => {
  it('loads the exact file bytes, canonical path, and SHA-256 revision', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const actual = await vi.importActual<Record<string, unknown>>('../lib/data');
    const loader = actual.loadConsolidatedState as
      | ((serviceId: string) => Promise<LoadState<ConsolidatedFeatureConfig>>)
      | undefined;

    expect(loader).toBeTypeOf('function');
    if (!loader) return;
    const state = await loader('web');
    expect(state).toMatchObject({ kind: 'ready', path, revision: revisionOf(before) });
  });

  it('loads a legacy route-slug collision through the in-memory compatibility parser', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const collision: ConsolidatedFeatureConfig = {
      projectName: 'test',
      basedOnFeaturesAt: '2026-09-08T00:00:00.000Z',
      generatedAt: '2026-09-08T00:01:00.000Z',
      model: 'test',
      groups: [
        {
          group_id: 'direct',
          label: 'Direct',
          excluded: [],
          features: [{
            canonical_id: 'create-template',
            label: 'Direct template',
            decision: 'keep',
            prev_decision: 'merge',
            members: ['create-template'],
            primary_route: '/create-template',
            reason: '',
            user_reviewed: false,
            dok_id_prefix: 'TEMPLATE',
            source_files: ['app/create/template/page.tsx'],
            logic_files: ['app/create/template/page.tsx'],
          }],
        },
        {
          group_id: 'nested',
          label: 'Nested',
          excluded: [],
          features: [{
            canonical_id: 'create-template',
            label: 'Nested template',
            decision: 'keep',
            members: ['create-template'],
            primary_route: '/create/template',
            reason: '',
            user_reviewed: false,
            dok_id_prefix: 'CREATE-TPL',
            source_files: ['app/create/template/page.tsx'],
            logic_files: ['app/create/template/page.tsx'],
          }],
        },
      ],
      originalFeatureIds: ['create-template', 'create-template'],
      userReviewed: false,
      stats: { originalFeatures: 2, consolidatedFeatures: 2, merges: 0, excluded: 0 },
    };
    const before = `${JSON.stringify(collision, null, 2)}\n`;
    await writeFile(path, before, 'utf-8');
    const actual = await vi.importActual<Record<string, unknown>>('../lib/data');
    const loader = actual.loadConsolidatedState as
      (serviceId: string) => Promise<LoadState<ConsolidatedFeatureConfig>>;

    const state = await loader('web');

    expect(state).toMatchObject({ kind: 'ready', path, revision: revisionOf(before) });
    if (state.kind !== 'ready') return;
    expect(Object.fromEntries(
      state.data.groups.flatMap((group) => group.features)
        .map((feature) => [feature.primary_route, feature.canonical_id]),
    )).toEqual({
      '/create-template': 'create-template',
      '/create/template': 'create-template-path2',
    });
    expect(state.data.originalFeatureIds).toEqual([
      'create-template',
      'create-template-path2',
    ]);
    const features = state.data.groups.flatMap((group) => group.features);
    expect(features[0]?.prev_decision).toBe('merge');
    for (const feature of features) {
      expect(feature).not.toHaveProperty('source_files');
      expect(feature).not.toHaveProperty('logic_files');
    }
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('classifies invalid and unreadable bytes without changing them', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('../lib/data');
    const loader = actual.loadConsolidatedState as
      | ((serviceId: string) => Promise<LoadState<ConsolidatedFeatureConfig>>)
      | undefined;
    expect(loader).toBeTypeOf('function');
    if (!loader) return;

    const invalidRoot = await scratch();
    const invalidPath = join(invalidRoot, '.doklo', 'cache', 'web.consolidated.json');
    const invalidBytes = '{"groups":';
    await writeFile(invalidPath, invalidBytes, 'utf-8');
    const invalid = await loader('web');
    expect(invalid).toMatchObject({ kind: 'invalid', path: invalidPath });
    expect(await readFile(invalidPath, 'utf-8')).toBe(invalidBytes);

    const unreadableRoot = await scratch();
    const cache = join(unreadableRoot, '.doklo', 'cache');
    await rm(cache, { recursive: true, force: true });
    await writeFile(cache, 'not a directory', 'utf-8');
    const unreadablePath = join(cache, 'web.consolidated.json');
    const unreadable = await loader('web');
    expect(unreadable).toMatchObject({ kind: 'unreadable', path: unreadablePath });
    expect(await readFile(cache, 'utf-8')).toBe('not a directory');
  });

  it('discovers workspace services even when a cache parent is unreadable', async () => {
    const dir = await scratch();
    const cache = join(dir, '.doklo', 'cache');
    await rm(cache, { recursive: true, force: true });
    await writeFile(cache, 'not a directory', 'utf-8');
    const actual = await vi.importActual<Record<string, unknown>>('../lib/data');
    const listServices = actual.listConsolidatedServices as
      | (() => Promise<string[]>)
      | undefined;
    const loadState = actual.loadConsolidatedState as
      | ((serviceId: string) => Promise<LoadState<ConsolidatedFeatureConfig>>)
      | undefined;

    expect(listServices).toBeTypeOf('function');
    expect(loadState).toBeTypeOf('function');
    if (!listServices || !loadState) return;
    await expect(listServices()).resolves.toContain('web');
    await expect(loadState('web')).resolves.toMatchObject({
      kind: 'unreadable',
      path: join(cache, 'web.consolidated.json'),
    });
    expect(await readFile(cache, 'utf-8')).toBe('not a directory');
  });

  it('keeps an EACCES cache read distinct from missing without writing', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'web.consolidated.json');
    const before = await readFile(path, 'utf-8');
    const actual = await vi.importActual<Record<string, unknown>>('../lib/data');
    const loader = actual.loadConsolidatedState as
      | ((serviceId: string, reader: { readFile(path: string): Promise<string> }) =>
        Promise<LoadState<ConsolidatedFeatureConfig>>)
      | undefined;

    expect(loader).toBeTypeOf('function');
    if (!loader) return;
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const state = await loader('web', {
      readFile: vi.fn(async () => { throw denied; }),
    });

    expect(state).toMatchObject({ kind: 'unreadable', path, message: 'permission denied' });
    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  it('returns the exact missing path and never mounts write controls when no cache exists', async () => {
    const dir = await scratch();
    const path = join(dir, '.doklo', 'cache', 'api.consolidated.json');
    const actual = await vi.importActual<Record<string, unknown>>('../lib/data');
    const loader = actual.loadConsolidatedState as
      (serviceId: string) => Promise<LoadState<ConsolidatedFeatureConfig>>;
    await expect(loader('api')).resolves.toEqual({ kind: 'missing', path });

    listConsolidatedServices.mockResolvedValue(['web', 'api']);
    loadConsolidatedState.mockResolvedValue({ kind: 'missing', path });
    const page = await ConsolidationPage({ searchParams: Promise.resolve({ service: 'api' }) });
    const container = render(page);
    expect(loadConsolidatedState).toHaveBeenCalledWith('api');
    expect(container.querySelector('[data-group]')).toBeNull();
    expect(container.textContent).not.toContain('Save & generate');
    expect(container.textContent).toContain('doklo consolidate');
  });

  it.each(['invalid', 'unreadable'] as const)(
    'renders LoadRecovery and never mounts the editor for %s cache state',
    async (kind) => {
      const path = '/workspace/.doklo/cache/web.consolidated.json';
      loadConsolidated.mockResolvedValue(null);
      loadConsolidatedState.mockResolvedValue({ kind, path, message: `${kind} cache` });
      const page = await ConsolidationPage({ searchParams: Promise.resolve({ service: 'web' }) });
      const container = render(page);

      const alert = container.querySelector<HTMLElement>('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain(path);
      expect(alert?.textContent).toContain('No files were changed.');
      expect(container.querySelector('[data-group]')).toBeNull();
      expect(container.textContent).not.toContain('Save & generate');
    },
  );
});

describe('revision-checked consolidation SaveBar', () => {
  it('passes the exact revision and adopts each successful returned revision', async () => {
    saveConsolidated
      .mockResolvedValueOnce({ ok: true, path: '/workspace/cache/web.json', revision: 'rev-2' })
      .mockResolvedValueOnce({ ok: true, path: '/workspace/cache/web.json', revision: 'rev-3' });
    const config = configFor();
    const container = render(
      <SaveBarHarness {...({
        service: 'web', config,
        editVersion: 1,
        initialRevision: 'rev-1', path: '/workspace/cache/web.json',
      } as React.ComponentProps<typeof SaveBarHarness>)} />,
    );

    await act(async () => { button(container, 'Save').click(); await Promise.resolve(); });
    await act(async () => { button(container, 'Save').click(); await Promise.resolve(); });

    expect(saveConsolidated.mock.calls).toEqual([
      [{ serviceId: 'web', config, expectedRevision: 'rev-1' }],
      [{ serviceId: 'web', config, expectedRevision: 'rev-2' }],
    ]);
    expect(container.textContent).toContain('/workspace/cache/web.json');
  });

  it('announces the actual affected path and retains a retry with the same revision', async () => {
    const path = '/workspace/.doklo/cache/web.consolidated.json';
    saveConsolidated
      .mockResolvedValueOnce({ ok: false, code: 'CONFLICT', path, error: 'revision changed', preserved: true })
      .mockResolvedValueOnce({ ok: true, path, revision: 'rev-2' });
    const config = configFor();
    const container = render(
      <SaveBar {...({
        service: 'web', config, dirty: true, editVersion: 1, onSaved: () => true,
        initialRevision: 'rev-1', path,
      } as React.ComponentProps<typeof SaveBar>)} />,
    );

    await act(async () => { button(container, 'Save').click(); await Promise.resolve(); });
    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain(path);
    expect(alert?.textContent).toContain('revision changed');

    await act(async () => { button(container, 'Retry').click(); await Promise.resolve(); });
    expect(saveConsolidated.mock.calls).toEqual([
      [{ serviceId: 'web', config, expectedRevision: 'rev-1' }],
      [{ serviceId: 'web', config, expectedRevision: 'rev-1' }],
    ]);
  });

  it('turns a rejected save promise into a persistent retryable path error', async () => {
    const path = '/workspace/.doklo/cache/web.consolidated.json';
    saveConsolidated
      .mockRejectedValueOnce(new Error('transport unavailable'))
      .mockResolvedValueOnce({ ok: true, path, revision: 'rev-2' });
    const config = configFor();
    const container = render(
      <SaveBarHarness {...({
        service: 'web', config, editVersion: 1,
        initialRevision: 'rev-1', path,
      } as React.ComponentProps<typeof SaveBarHarness>)} />,
    );

    await act(async () => {
      button(container, 'Save').click();
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain(path);
    expect(alert?.textContent).toContain('transport unavailable');
    expect(button(alert ?? container, 'Retry').disabled).toBe(false);

    await act(async () => {
      button(alert ?? container, 'Retry').click();
      await Promise.resolve();
    });
    expect(saveConsolidated.mock.calls).toEqual([
      [{ serviceId: 'web', config, expectedRevision: 'rev-1' }],
      [{ serviceId: 'web', config, expectedRevision: 'rev-1' }],
    ]);
    expect(container.textContent).toContain('Saved');
  });

  it('contains no legacy positional consolidation action call', async () => {
    const source = await readFile(resolve(process.cwd(), 'components/consolidation/save-bar.tsx'), 'utf-8');
    expect(source).toContain('expectedRevision');
    expect(source).not.toMatch(/saveConsolidatedAction\s*\(\s*service\s*,\s*config\s*\)/);
  });
});

describe('consolidation dok_id_prefix editing', () => {
  it('round-trips an edited dok_id_prefix through save without reverting the input', async () => {
    saveConsolidated.mockResolvedValue({
      ok: true,
      path: '/workspace/.doklo/cache/web.consolidated.json',
      revision: 'rev-2',
    });
    const page = await ConsolidationPage({ searchParams: Promise.resolve({ service: 'web' }) });
    const container = render(page);

    const prefixLabel = 'input[aria-label="Edit dok_id_prefix for web feature"]';
    const input = container.querySelector<HTMLInputElement>(prefixLabel);
    if (!input) throw new Error('Expected the dok_id_prefix input.');
    // React tracks the DOM node's "last known value" itself, so a plain
    // `input.value = x` (which routes through that same tracked setter)
    // leaves nothing for the synthetic change handler to detect. Going
    // through the native prototype setter bypasses the tracking — the same
    // workaround already used in editor-persistence.test.tsx / honest-controls.test.tsx.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter?.call(input, 'WEB-V2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector<HTMLInputElement>(prefixLabel)?.value).toBe('WEB-V2');

    await act(async () => { button(container, 'Save').click(); await Promise.resolve(); });

    expect(saveConsolidated).toHaveBeenCalledOnce();
    const [call] = saveConsolidated.mock.calls[0] as [{
      serviceId: string;
      config: ConsolidatedFeatureConfig;
      expectedRevision: string;
    }];
    expect(call.config.groups[0].features[0].dok_id_prefix).toBe('WEB-V2');

    // The board never re-syncs `config` from the server response after a save
    // (same as every other edit, e.g. decision) — so the edited prefix must
    // still be showing here, not reverted to the pre-edit value.
    expect(container.querySelector<HTMLInputElement>(prefixLabel)?.value).toBe('WEB-V2');
  });
});
