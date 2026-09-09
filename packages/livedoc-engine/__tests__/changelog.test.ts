import { describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { buildChangelog, classifyDokHistory } from '../src/changelog.js';

const dok = (id: string, status: Dok['status'], history: Dok['_meta']['history']): Dok => ({
  dok_id: id,
  name: `Name ${id}`,
  description: 'd',
  status,
  tags: [],
  surfaces: [],
  _meta: { version: history.length + 1, history },
} as unknown as Dok);

describe('classifyDokHistory', () => {
  it('maps a new Dok: draft note hidden, first activation = added, later note keeps its category', () => {
    const items = classifyDokHistory(dok('A', 'active', [
      { version: 2, date: '2026-08-10', change: 'draft polish', kind: 'edited' },
      { version: 3, date: '2026-08-11', change: 'Activated', kind: 'status', from: 'draft', to: 'active' },
      { version: 4, date: '2026-08-12', change: 'Added CSV export', kind: 'edited', from: 'active', to: 'draft', category: 'added' },
      { version: 5, date: '2026-08-12', change: 'Activated', kind: 'status', from: 'draft', to: 'active' },
    ]));
    expect(items.map((i) => [i.category, i.entry.version, i.restored])).toEqual([
      ['added', 3, false], ['added', 4, false],
    ]);
    expect(items[0]!.dok_id).toBe('A');
    expect(items[0]!.name).toBe('Name A');
  });

  it('maps a legacy Dok: baseline hidden, re-approval hidden, edit = changed, deprecate/restore/archive', () => {
    const items = classifyDokHistory(dok('B', 'active', [
      { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
      { version: 2, date: '2026-08-16', change: 'Reworded', kind: 'edited', from: 'active', to: 'draft' },
      { version: 3, date: '2026-08-16', change: 'Activated', kind: 'status', from: 'draft', to: 'active' },
      { version: 4, date: '2026-08-17', change: 'Deprecated', kind: 'status', from: 'active', to: 'deprecated' },
      { version: 5, date: '2026-08-18', change: 'Activated', kind: 'status', from: 'deprecated', to: 'active' },
      { version: 6, date: '2026-08-19', change: 'Archived', kind: 'status', from: 'active', to: 'archived' },
    ]));
    expect(items.map((i) => [i.category, i.entry.version, i.restored])).toEqual([
      ['changed', 2, false], ['deprecated', 4, false], ['changed', 5, true], ['removed', 6, false],
    ]);
  });

  it('reads an approval-confirmed regeneration as changed on a legacy Dok and added on a never-shipped one', () => {
    const legacy = classifyDokHistory(dok('C', 'active', [
      { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
      { version: 2, date: '2026-08-16', change: 'Export now includes archived rows', kind: 'regenerated', from: 'draft', to: 'active' },
    ]));
    expect(legacy.map((i) => [i.category, i.entry.change])).toEqual([
      ['changed', 'Export now includes archived rows'],
    ]);

    const fresh = classifyDokHistory(dok('D', 'active', [
      { version: 2, date: '2026-08-16', change: 'Export now includes archived rows', kind: 'regenerated', from: 'draft', to: 'active' },
    ]));
    expect(fresh.map((i) => i.category)).toEqual(['added']);
  });

  it('treats legacy hand-written entries (no kind) as edited on an active Dok and hides workflow-only transitions', () => {
    const items = classifyDokHistory(dok('E', 'review', [
      { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
      { version: 2, date: '2026-08-16', change: 'Old note' },
      { version: 3, date: '2026-08-16', change: 'Sent to review', kind: 'status', from: 'active', to: 'review' },
      { version: 4, date: '2026-08-16', change: 'Note while in review' },
    ]));
    expect(items.map((i) => [i.category, i.entry.version])).toEqual([['changed', 2]]);
  });

  it('renders nothing for a Dok with no recorded history', () => {
    expect(classifyDokHistory(dok('F', 'active', []))).toEqual([]);
  });
});

describe('buildChangelog', () => {
  it('groups by date descending with deterministic ordering inside sections', () => {
    const cl = buildChangelog([
      dok('B', 'active', [{ version: 2, date: '2026-08-10', change: 'Activated', kind: 'status', from: 'draft', to: 'active' }]),
      dok('A', 'active', [
        { version: 2, date: '2026-08-10', change: 'Activated', kind: 'status', from: 'draft', to: 'active' },
        { version: 3, date: '2026-08-12', change: 'Fix typo', kind: 'edited', category: 'fixed' },
      ]),
    ]);
    expect(cl.total).toBe(3);
    expect(cl.groups.map((g) => g.date)).toEqual(['2026-08-12', '2026-08-10']);
    expect(cl.groups[1]!.added.map((i) => i.dok_id)).toEqual(['A', 'B']);
    expect(cl.groups[0]!.fixed[0]!.entry.change).toBe('Fix typo');
    expect(cl.groups[0]!.added).toEqual([]);
  });

  it('orders same-Dok same-date items by version and keeps every section present', () => {
    const cl = buildChangelog([
      dok('Z', 'active', [
        { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
        { version: 3, date: '2026-08-16', change: 'Second note', kind: 'edited' },
      ]),
      dok('Y', 'active', [
        { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
        { version: 2, date: '2026-08-16', change: 'Patched a rounding bug', kind: 'edited', category: 'fixed' },
        { version: 4, date: '2026-08-16', change: 'Tightened the token check', kind: 'edited', category: 'security' },
      ]),
    ]);
    expect(cl.total).toBe(3);
    expect(cl.groups).toHaveLength(1);
    const group = cl.groups[0]!;
    expect(group.changed.map((i) => [i.dok_id, i.entry.version])).toEqual([['Z', 3]]);
    expect(group.fixed.map((i) => i.dok_id)).toEqual(['Y']);
    expect(group.security.map((i) => i.dok_id)).toEqual(['Y']);
    expect(group.deprecated).toEqual([]);
    expect(group.removed).toEqual([]);
  });

  it('returns an empty changelog when nothing was recorded', () => {
    const cl = buildChangelog([dok('A', 'active', []), dok('B', 'draft', [])]);
    expect(cl).toEqual({ groups: [], total: 0 });
  });
});
