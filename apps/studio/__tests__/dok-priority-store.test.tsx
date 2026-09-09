// @vitest-environment jsdom

import {
  act,
  createRef,
  forwardRef,
  useImperativeHandle,
  type RefObject,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import type { BlastRadius, BusinessImpact } from '@doklo-beta/core/schemas';
import {
  StudioProvider,
  useDoks,
  useDoksByDomain,
  useStudio,
} from '../components/studio-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function dok(dok_id: string, impact?: string, blast?: string): Dok {
  return {
    dok_id,
    name: dok_id,
    status: 'active',
    tags: [],
    surfaces: [],
    description: 'x',
    ...(impact === undefined
      ? {}
      : {
          priority: {
            impact,
            blast_radius: blast ?? 'degrading',
            signals: [],
            curated: {},
          },
        }),
    _meta: { version: 1, history: [] },
  } as unknown as Dok;
}

const DOKS: Dok[] = [
  dok('AUTH-RESET', 'enabling', 'degrading'),
  dok('AUTH-SIGNIN', 'enabling', 'blocking'),
  dok('PAY-CHECKOUT', 'revenue', 'degrading'),
  dok('ZED-ABOUT', 'supporting', 'cosmetic'),
];

interface Controller {
  ids: () => string[];
  domains: () => [string, string[]][];
  setSort: (sort: 'priority' | 'id' | 'recent') => void;
  setImpact: (f: BusinessImpact | 'all') => void;
  setBlast: (f: BlastRadius | 'all') => void;
}

const Probe = forwardRef<Controller>(function Probe(_, ref) {
  const studio = useStudio();
  const doks = useDoks();
  const byDomain = useDoksByDomain();
  useImperativeHandle(
    ref,
    () => ({
      ids: () => doks.map((d) => d.dok_id),
      domains: () => byDomain.map(([domain, list]) => [
        domain,
        list.map((d) => d.dok_id),
      ]),
      setSort: studio.setSort,
      setImpact: studio.setImpactFilter,
      setBlast: studio.setBlastFilter,
    }),
    [byDomain, doks, studio],
  );
  return null;
});

const roots: Root[] = [];

async function mount(doks: Dok[]): Promise<RefObject<Controller | null>> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ref = createRef<Controller>();
  await act(async () => {
    root.render(
      <StudioProvider
        layerCounts={{ doks: doks.length, lexicon: 0, ia: 0, roles: 0 }}
        initialDoks={doks}
      >
        <Probe ref={ref} />
      </StudioProvider>,
    );
  });
  return ref;
}

afterEach(async () => {
  await act(async () => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
});

describe('priority sort', () => {
  it('is the default sort', async () => {
    const ref = await mount(DOKS);
    expect(ref.current?.ids()).toEqual([
      'PAY-CHECKOUT',
      'AUTH-SIGNIN',
      'AUTH-RESET',
      'ZED-ABOUT',
    ]);
  });

  // The whole point of the grouping requirement: the domain holding the
  // highest-impact Dok comes first, with its own children intact. This falls
  // out of useDoksByDomain preserving first-appearance order — no grouping
  // code change is involved, and this test is what proves that.
  it('orders domains by their best Dok while keeping children together', async () => {
    const ref = await mount(DOKS);
    expect(ref.current?.domains()).toEqual([
      ['PAY', ['PAY-CHECKOUT']],
      ['AUTH', ['AUTH-SIGNIN', 'AUTH-RESET']],
      ['ZED', ['ZED-ABOUT']],
    ]);
  });

  it('still supports the id sort', async () => {
    const ref = await mount(DOKS);
    await act(async () => ref.current?.setSort('id'));
    expect(ref.current?.ids()).toEqual([
      'AUTH-RESET',
      'AUTH-SIGNIN',
      'PAY-CHECKOUT',
      'ZED-ABOUT',
    ]);
  });
});

describe('axis filters', () => {
  it('filters on impact', async () => {
    const ref = await mount(DOKS);
    await act(async () => ref.current?.setImpact('revenue'));
    expect(ref.current?.ids()).toEqual(['PAY-CHECKOUT']);
  });

  it('filters on blast radius', async () => {
    const ref = await mount(DOKS);
    await act(async () => ref.current?.setBlast('blocking'));
    expect(ref.current?.ids()).toEqual(['AUTH-SIGNIN']);
  });

  it('combines the two axes with AND', async () => {
    const ref = await mount(DOKS);
    await act(async () => {
      ref.current?.setImpact('enabling');
      ref.current?.setBlast('cosmetic');
    });
    expect(ref.current?.ids()).toEqual([]);
  });

  // Sorting has to place everything, so it gives unjudged a mid-pack slot.
  // Filtering passes only what is actually claimed, so an unjudged Dok is
  // excluded rather than being treated as enabling/degrading.
  it('excludes unjudged Doks when an axis filter is active', async () => {
    const ref = await mount([dok('NONE'), dok('E', 'enabling', 'degrading')]);
    await act(async () => ref.current?.setImpact('enabling'));
    expect(ref.current?.ids()).toEqual(['E']);
  });

  it('keeps unjudged Doks visible while both axis filters are off', async () => {
    const ref = await mount([dok('NONE'), dok('E', 'enabling', 'degrading')]);
    expect(ref.current?.ids()).toEqual(['E', 'NONE']);
  });
});
