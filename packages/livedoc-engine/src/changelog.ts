import type { Dok, DokHistoryCategory, DokHistoryEntry, Translatable } from '@doklo-beta/core';

export interface ChangelogItem {
  dok_id: string;
  name: Translatable;
  entry: DokHistoryEntry;
  category: DokHistoryCategory;
  /** A `status` entry back to active from deprecated/archived — rendered under Changed with the "restored" string. */
  restored: boolean;
}

export interface ChangelogGroup {
  date: string;
  added: ChangelogItem[];
  changed: ChangelogItem[];
  deprecated: ChangelogItem[];
  removed: ChangelogItem[];
  fixed: ChangelogItem[];
  security: ChangelogItem[];
}

export interface Changelog {
  /** Date descending — the Hub has no release versions, so dates group the entries. */
  groups: ChangelogGroup[];
  total: number;
}

/** Keep a Changelog 1.1.0 section order. */
const SECTIONS: DokHistoryCategory[] = [
  'added', 'changed', 'deprecated', 'removed', 'fixed', 'security',
];

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Walks one Dok's history in order, keeping `active` (the status at the start
 * of the entry) and `everActive` (whether the Dok has ever shipped). Baselines,
 * pre-activation drafting, workflow-only transitions and post-edit re-approvals
 * are recorded but never rendered, so a new Dok's `[edit → activate]` flow
 * yields one Added and a legacy Dok's `[baseline → edit → re-approve]` yields
 * one Changed. See spec §9.1.
 */
export function classifyDokHistory(dok: Dok): ChangelogItem[] {
  const items: ChangelogItem[] = [];
  let active = false;
  let everActive = false;

  for (const entry of dok._meta?.history ?? []) {
    const kind = entry.kind ?? 'edited';
    const item = (category: DokHistoryCategory, restored = false): ChangelogItem => ({
      dok_id: dok.dok_id,
      name: dok.name,
      entry,
      category,
      restored,
    });

    if (kind === 'baseline') {
      active = true;
      everActive = true;
      continue;
    }

    if (kind === 'status') {
      if (entry.to === 'active') {
        // First activation ships the feature; a return from retirement restores
        // it; anything else is the re-approval of an edit already reported.
        if (!everActive) items.push(item('added'));
        else if (entry.from === 'deprecated' || entry.from === 'archived') {
          items.push(item('changed', true));
        }
      } else if (entry.to === 'deprecated') {
        items.push(item('deprecated'));
      } else if (entry.to === 'archived') {
        items.push(item('removed'));
      }
      // draft / review / planned are internal workflow — nothing to announce.
    } else {
      // edited / regenerated, and legacy entries without a kind.
      const activatesFirstTime = entry.to === 'active' && !everActive;
      if (activatesFirstTime) {
        items.push(item('added'));
      } else if (entry.to === 'active' || active || entry.from === 'active') {
        items.push(item(entry.category ?? 'changed'));
      }
      // Otherwise the Dok has not shipped yet — drafting is not a change to announce.
    }

    if (entry.to !== undefined) {
      active = entry.to === 'active';
      if (active) everActive = true;
    }
  }

  return items;
}

/** Pure, deterministic aggregation of every Dok's recorded history. */
export function buildChangelog(doks: Dok[]): Changelog {
  const byDate = new Map<string, ChangelogGroup>();
  const sortedDoks = [...doks].sort((a, b) => compareIds(a.dok_id, b.dok_id));
  let total = 0;

  for (const dok of sortedDoks) {
    for (const item of classifyDokHistory(dok)) {
      let group = byDate.get(item.entry.date);
      if (!group) {
        group = {
          date: item.entry.date,
          added: [], changed: [], deprecated: [], removed: [], fixed: [], security: [],
        };
        byDate.set(item.entry.date, group);
      }
      group[item.category].push(item);
      total += 1;
    }
  }

  const groups = [...byDate.values()].sort((a, b) => -compareIds(a.date, b.date));
  for (const group of groups) {
    for (const section of SECTIONS) {
      group[section].sort((a, b) => (
        a.dok_id === b.dok_id
          ? a.entry.version - b.entry.version
          : compareIds(a.dok_id, b.dok_id)
      ));
    }
  }

  return { groups, total };
}
