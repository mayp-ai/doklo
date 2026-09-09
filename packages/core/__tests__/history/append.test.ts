import { describe, expect, it } from 'vitest';
import {
  BASELINE_CHANGE,
  appendHistoryEntry,
  bumpVersion,
  canonicalStatusChange,
  formatHistoryDate,
  needsBaseline,
  parseHistoryDate,
  type DokMeta,
} from '../../src/index.js';

const NOW = () => new Date(2026, 7, 16, 12, 0, 0); // 2026-08-16 local
const meta = (over: Partial<DokMeta> = {}): DokMeta => ({ version: 1, history: [], ...over });

describe('formatHistoryDate / parseHistoryDate', () => {
  it('formats the local calendar date and round-trips', () => {
    expect(formatHistoryDate(NOW())).toBe('2026-08-16');
    expect(formatHistoryDate(parseHistoryDate('2026-02-03'))).toBe('2026-02-03');
    expect(() => parseHistoryDate('2026/02/03')).toThrow(/YYYY-MM-DD/);
    expect(() => parseHistoryDate('2026-13-40')).toThrow();
  });
});

describe('appendHistoryEntry — Studio bump policy', () => {
  it('appends an edited entry with a bumped version and no from/to when status is unchanged', () => {
    const r = appendHistoryEntry({
      meta: meta({ version: 4, history: [] }),
      persisted: { status: 'draft', version: 4 },
      nextStatus: 'draft',
      entry: { kind: 'edited', change: '  Clarified scope  ', author: 'pumpa' },
      versionPolicy: 'bump',
      now: NOW,
    });
    expect(r.version).toBe(5);
    expect(r.meta.version).toBe(5);
    expect(r.appended).toEqual([
      { version: 5, date: '2026-08-16', change: 'Clarified scope', author: 'pumpa', kind: 'edited' },
    ]);
    expect(r.meta.history).toEqual(r.appended);
  });

  it('inserts a baseline first for a legacy active Dok with empty history', () => {
    const r = appendHistoryEntry({
      meta: meta({ version: 1, history: [] }),
      persisted: { status: 'active', version: 1 },
      nextStatus: 'draft',
      entry: { kind: 'edited', change: 'Reworded banner rules' },
      versionPolicy: 'bump',
      now: NOW,
    });
    expect(r.meta.history).toEqual([
      { version: 1, date: '2026-08-16', change: BASELINE_CHANGE, kind: 'baseline' },
      { version: 2, date: '2026-08-16', change: 'Reworded banner rules', kind: 'edited', from: 'active', to: 'draft' },
    ]);
    expect(needsBaseline(meta(), 'active')).toBe(true);
    expect(needsBaseline(meta(), 'draft')).toBe(false);
    expect(needsBaseline(meta(), 'draft', 'active')).toBe(true);
    expect(needsBaseline(meta({ history: [{ version: 1, date: 'd', change: 'c' }] }), 'active')).toBe(false);
  });

  it('uses baselineFrom for a legacy Dok a regeneration already demoted to draft', () => {
    const r = appendHistoryEntry({
      meta: meta({ version: 2, history: [] }),
      persisted: { status: 'draft', version: 2 },
      nextStatus: 'active',
      entry: { kind: 'regenerated', change: 'Updated the description.', category: 'changed' },
      versionPolicy: 'bump',
      now: NOW,
      baselineFrom: { status: 'active', version: 1 },
    });
    expect(r.meta.history).toEqual([
      { version: 1, date: '2026-08-16', change: BASELINE_CHANGE, kind: 'baseline' },
      {
        version: 3, date: '2026-08-16', change: 'Updated the description.',
        kind: 'regenerated', from: 'draft', to: 'active', category: 'changed',
      },
    ]);
  });

  it('records a status entry with canonical text and always from/to', () => {
    const r = appendHistoryEntry({
      meta: meta({ version: 2, history: [] }),
      persisted: { status: 'draft', version: 2 },
      nextStatus: 'active',
      entry: { kind: 'status', change: canonicalStatusChange('active') },
      versionPolicy: 'bump',
      now: NOW,
    });
    expect(r.appended).toEqual([
      { version: 3, date: '2026-08-16', change: 'Activated', kind: 'status', from: 'draft', to: 'active' },
    ]);
    expect(() => appendHistoryEntry({
      meta: meta(),
      persisted: { status: 'draft', version: 1 },
      nextStatus: 'draft',
      entry: { kind: 'status', change: 'x' },
      versionPolicy: 'bump',
      now: NOW,
    })).toThrow(/status change/);
  });

  it('keeps versions strictly increasing over hand-written entries and forbids empty change', () => {
    const legacy = meta({
      version: 3,
      history: [{ version: 9, date: '2026-01-01', change: 'hand-written future' }],
    });
    expect(bumpVersion(legacy)).toBe(10);
    const r = appendHistoryEntry({
      meta: legacy,
      persisted: { status: 'active', version: 3 },
      nextStatus: 'active',
      entry: { kind: 'edited', change: 'note', category: 'fixed' },
      versionPolicy: 'bump',
      now: NOW,
    });
    expect(r.version).toBe(10);
    expect(r.appended[0]).toMatchObject({ version: 10, category: 'fixed' });
    expect(() => appendHistoryEntry({
      meta: meta(),
      persisted: { status: 'draft', version: 1 },
      nextStatus: 'draft',
      entry: { kind: 'edited', change: '   ' },
      versionPolicy: 'bump',
      now: NOW,
    })).toThrow(/empty/);
  });
});

describe('appendHistoryEntry — generate assigned policy', () => {
  it('uses the already-bumped meta.version as the entry version (single bump)', () => {
    const r = appendHistoryEntry({
      meta: meta({ version: 2, history: [] }),
      persisted: { status: 'active', version: 1 },
      nextStatus: 'draft',
      entry: { kind: 'regenerated', change: 'Payment refactor (PR #123)', category: 'changed' },
      versionPolicy: 'assigned',
      now: NOW,
    });
    expect(r.meta.version).toBe(2);
    expect(r.meta.history).toEqual([
      { version: 1, date: '2026-08-16', change: BASELINE_CHANGE, kind: 'baseline' },
      {
        version: 2, date: '2026-08-16', change: 'Payment refactor (PR #123)',
        kind: 'regenerated', from: 'active', to: 'draft', category: 'changed',
      },
    ]);
  });

  it('corrects an assigned version that does not exceed the last entry', () => {
    const r = appendHistoryEntry({
      meta: meta({ version: 2, history: [{ version: 5, date: 'd', change: 'legacy' }] }),
      persisted: { status: 'draft', version: 1 },
      nextStatus: 'draft',
      entry: { kind: 'regenerated', change: 'n' },
      versionPolicy: 'assigned',
      now: NOW,
    });
    expect(r.version).toBe(6);
    expect(r.meta.version).toBe(6);
  });

  it('does not mutate the input meta', () => {
    const input = meta({ version: 1, history: [] });
    appendHistoryEntry({
      meta: input,
      persisted: { status: 'draft', version: 1 },
      nextStatus: 'draft',
      entry: { kind: 'edited', change: 'x' },
      versionPolicy: 'bump',
      now: NOW,
    });
    expect(input).toEqual({ version: 1, history: [] });
  });
});
