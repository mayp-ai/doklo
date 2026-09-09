import { describe, expect, it } from 'vitest';
import type { Dok, DokHistoryEntry } from '@doklo-beta/core';
import { buildDokSnapshots, classifyDokChanges } from '../src/dok-changes.js';

const emptyLexicon = { version: 1, terms: [] } as never;
const emptyRoles = { version: 1, roles: [] } as never;

function dok(id: string, over: Partial<Dok> = {}): Dok {
  return {
    dok_id: id,
    name: `Feature ${id}`,
    status: 'active',
    tags: [],
    surfaces: [],
    description: `Description of ${id}`,
    _meta: { version: 1, history: [], logic_hash: `hash-${id}` },
    ...over,
  } as Dok;
}

describe('classifyDokChanges', () => {
  it('reports no baseline on first render', () => {
    const result = classifyDokChanges([dok('PAY')], undefined);

    expect(result.baseline_found).toBe(false);
    expect(result.has_customer_changes).toBe(false);
    expect(result.unchanged.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.notes).toEqual({});
    expect(result.notes_text).toEqual({});
  });

  it('classifies added, changed, removed, unchanged deterministically', () => {
    const baseline = [
      {
        dok_id: 'AUTH',
        name: 'Sign in',
        logic_hash: 'hash-AUTH',
        status: 'active' as const,
      },
      {
        dok_id: 'PAY',
        name: 'Checkout',
        logic_hash: 'old-hash',
        status: 'active' as const,
      },
      {
        dok_id: 'OLD',
        name: 'Legacy thing',
        logic_hash: 'hash-OLD',
        status: 'active' as const,
      },
    ];
    const current = [dok('PAY'), dok('AUTH'), dok('NEW')];

    const result = classifyDokChanges(current, baseline);

    expect(result.baseline_found).toBe(true);
    expect(result.has_customer_changes).toBe(true);
    expect(result.added.map((item) => item.dok_id)).toEqual(['NEW']);
    expect(result.changed.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(result.unchanged.map((item) => item.dok_id)).toEqual(['AUTH']);
    expect(result.removed.map((item) => item.dok_id)).toEqual(['OLD']);
  });

  it('never claims changed when either side lacks a logic hash', () => {
    const baseline = [{ dok_id: 'PAY', name: 'Checkout', status: 'active' as const }];
    const result = classifyDokChanges([dok('PAY')], baseline);

    expect(result.changed).toEqual([]);
    expect(result.unchanged.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(result.has_customer_changes).toBe(false);
  });
});

describe('classifyDokChanges note join', () => {
  const history: DokHistoryEntry[] = [
    {
      version: 1,
      date: '2026-08-01',
      change: 'Active before history tracking began',
      kind: 'baseline',
    },
    { version: 2, date: '2026-08-02', change: 'Recorded before the digest', kind: 'edited' },
    {
      version: 3,
      date: '2026-08-10',
      change: 'Sent to review',
      kind: 'status',
      from: 'active',
      to: 'review',
    },
    { version: 4, date: '2026-08-11', change: 'Split payment added', kind: 'edited' },
    // A hand-written entry with no `kind` reads as 'edited'.
    { version: 5, date: '2026-08-12', change: 'Refund window extended' },
    {
      version: 6,
      date: '2026-08-13',
      change: 'Rebuilt from the new checkout module',
      kind: 'regenerated',
    },
    {
      version: 7,
      date: '2026-08-14',
      change: 'Active before history tracking began',
      kind: 'baseline',
    },
  ];

  function withHistory(id: string, version: number, logicHash: string): Dok {
    return dok(id, { _meta: { version, history, logic_hash: logicHash } as never });
  }

  it('joins the notes recorded since the snapshot version onto each changed Dok', () => {
    const result = classifyDokChanges(
      [withHistory('PAY', 7, 'hash-PAY')],
      [
        {
          dok_id: 'PAY',
          name: 'Checkout',
          logic_hash: 'old-hash',
          version: 2,
          status: 'active' as const,
        },
      ],
    );

    expect(result.changed.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(result.notes.PAY?.map((entry) => entry.change)).toEqual([
      'Split payment added',
      'Refund window extended',
      'Rebuilt from the new checkout module',
    ]);
    expect(result.notes_text.PAY).toBe(
      'Split payment added; Refund window extended; Rebuilt from the new checkout module',
    );
  });

  it('joins notes only onto changed Doks, never onto added or unchanged ones', () => {
    const result = classifyDokChanges(
      [
        withHistory('PAY', 7, 'hash-PAY'),
        withHistory('AUTH', 7, 'hash-AUTH'),
        withHistory('NEW', 7, 'hash-NEW'),
      ],
      [
        {
          dok_id: 'PAY',
          name: 'Checkout',
          logic_hash: 'old-hash',
          version: 2,
          status: 'active' as const,
        },
        {
          dok_id: 'AUTH',
          name: 'Sign in',
          logic_hash: 'hash-AUTH',
          version: 2,
          status: 'active' as const,
        },
      ],
    );

    expect(result.changed.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(Object.keys(result.notes)).toEqual(['PAY']);
    expect(Object.keys(result.notes_text)).toEqual(['PAY']);
  });

  it('adds no key for a changed Dok whose history holds nothing since the snapshot', () => {
    const result = classifyDokChanges(
      [withHistory('PAY', 7, 'hash-PAY')],
      [
        {
          dok_id: 'PAY',
          name: 'Checkout',
          logic_hash: 'old-hash',
          version: 7,
          status: 'active' as const,
        },
      ],
    );

    expect(result.changed.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(result.notes).toEqual({});
    expect(result.notes_text).toEqual({});
  });

  it('skips the join for evidence recorded before snapshot versions existed', () => {
    const result = classifyDokChanges(
      [withHistory('PAY', 7, 'hash-PAY')],
      [
        {
          dok_id: 'PAY',
          name: 'Checkout',
          logic_hash: 'old-hash',
          status: 'active' as const,
        },
      ],
    );

    expect(result.changed.map((item) => item.dok_id)).toEqual(['PAY']);
    expect(result.notes).toEqual({});
    expect(result.notes_text).toEqual({});
  });
});

describe('buildDokSnapshots', () => {
  it('resolves names to plain strings and sorts by dok_id', () => {
    const snapshots = buildDokSnapshots({
      doks: [
        dok('PAY'),
        dok('AUTH', { _meta: { version: 1, history: [] } as never }),
      ],
      selectedDokIds: ['PAY', 'AUTH'],
      locale: 'ko',
      primaryLocale: 'en',
      lexicon: emptyLexicon,
      roles: emptyRoles,
    });

    expect(snapshots).toEqual([
      {
        dok_id: 'AUTH',
        name: 'Feature AUTH',
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        version: 1,
        status: 'active',
      },
      {
        dok_id: 'PAY',
        name: 'Feature PAY',
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        logic_hash: 'hash-PAY',
        version: 1,
        status: 'active',
      },
    ]);
  });

  it('records the Dok version so the next render can join the notes since', () => {
    const snapshots = buildDokSnapshots({
      doks: [
        dok('PAY', { _meta: { version: 4, history: [] } as never }),
        dok('AUTH', { _meta: { history: [] } as never }),
      ],
      selectedDokIds: ['PAY', 'AUTH'],
      locale: 'en',
      primaryLocale: 'en',
      lexicon: emptyLexicon,
      roles: emptyRoles,
    });

    expect(snapshots.map((snapshot) => [snapshot.dok_id, snapshot.version])).toEqual([
      ['AUTH', 1],
      ['PAY', 4],
    ]);
  });
});
