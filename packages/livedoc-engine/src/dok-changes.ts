import { createHash } from 'node:crypto';
import {
  resolveTranslatable,
  type Dok,
  type DokHistoryEntry,
  type DokStatus,
  type LexiconFile,
  type RolesFile,
} from '@doklo-beta/core';

/** Per-Dok snapshot recorded in publication-evidence.json — the digest baseline. */
export type EvidenceDokSnapshot = {
  dok_id: string;
  /** Display name resolved to a plain string at snapshot time (survives Dok deletion). */
  name: string;
  logic_hash?: string;
  /** Canonical digest of the complete reviewed Dok content used for rendering. */
  content_sha256?: string;
  /**
   * `_meta.version` at snapshot time — lets the next render pick the notes
   * recorded since. Absent on pre-2026-08 evidence, which skips the join.
   */
  version?: number;
  status: DokStatus;
};

/** Notes a person approved after the baseline snapshot. Never the whole history. */
const NOTE_KINDS = new Set(['edited', 'regenerated']);

export interface DokChangeSet {
  baseline_found: boolean;
  has_customer_changes: boolean;
  added: Dok[];
  changed: Dok[];
  unchanged: Dok[];
  removed: EvidenceDokSnapshot[];
  /**
   * Per changed Dok, the history entries recorded since the baseline snapshot —
   * what a person said changed. Only changed Doks (code moved) get a key, and
   * only when they actually have notes.
   */
  notes: Record<string, DokHistoryEntry[]>;
  /** The same notes joined with '; ' — what a template renders directly. */
  notes_text: Record<string, string>;
}

function byDokId<T extends { dok_id: string }>(a: T, b: T): number {
  return a.dok_id < b.dok_id ? -1 : a.dok_id > b.dok_id ? 1 : 0;
}

/**
 * Deterministic classification of the current selection against the previous
 * render's snapshot. A Dok missing a logic hash on either side is never
 * claimed as changed because only provable changes are reported.
 */
export function classifyDokChanges(
  current: Dok[],
  baseline: EvidenceDokSnapshot[] | undefined,
): DokChangeSet {
  const sorted = [...current].sort(byDokId);
  if (!baseline) {
    return {
      baseline_found: false,
      has_customer_changes: false,
      added: [],
      changed: [],
      unchanged: sorted,
      removed: [],
      notes: {},
      notes_text: {},
    };
  }

  const baselineById = new Map(
    baseline.map((snapshot) => [snapshot.dok_id, snapshot]),
  );
  const currentIds = new Set(sorted.map((dok) => dok.dok_id));
  const added: Dok[] = [];
  const changed: Dok[] = [];
  const unchanged: Dok[] = [];
  const notes: Record<string, DokHistoryEntry[]> = {};
  const notes_text: Record<string, string> = {};

  for (const dok of sorted) {
    const snapshot = baselineById.get(dok.dok_id);
    if (!snapshot) {
      added.push(dok);
      continue;
    }
    const currentHash = dok._meta?.logic_hash;
    if (
      currentHash
      && snapshot.logic_hash
      && currentHash !== snapshot.logic_hash
    ) {
      changed.push(dok);
      const since = notesSince(dok, snapshot.version);
      if (since.length > 0) {
        notes[dok.dok_id] = since;
        notes_text[dok.dok_id] = since.map((entry) => entry.change).join('; ');
      }
    } else {
      unchanged.push(dok);
    }
  }

  const removed = baseline
    .filter((snapshot) => !currentIds.has(snapshot.dok_id))
    .sort(byDokId);

  return {
    baseline_found: true,
    has_customer_changes:
      added.length > 0 || changed.length > 0 || removed.length > 0,
    added,
    changed,
    unchanged,
    removed,
    notes,
    notes_text,
  };
}

/**
 * History entries a person approved after the baseline snapshot was taken —
 * what changed, in their words. Status transitions and the synthetic baseline
 * marker are not change statements, so they never reach a customer digest.
 * Pre-2026-08 evidence carries no version and joins nothing rather than
 * guessing which entries the last render already announced.
 */
function notesSince(dok: Dok, since: number | undefined): DokHistoryEntry[] {
  if (typeof since !== 'number') return [];
  return (dok._meta?.history ?? []).filter((entry) => (
    entry.version > since && NOTE_KINDS.has(entry.kind ?? 'edited')
  ));
}

export function buildDokSnapshots(args: {
  doks: Dok[];
  selectedDokIds: string[];
  locale: string;
  primaryLocale: string;
  lexicon: LexiconFile;
  roles: RolesFile;
}): EvidenceDokSnapshot[] {
  const dokById = new Map(args.doks.map((dok) => [dok.dok_id, dok]));
  const snapshots: EvidenceDokSnapshot[] = [];

  for (const dokId of args.selectedDokIds) {
    const dok = dokById.get(dokId);
    if (!dok) continue;
    const logicHash = dok._meta?.logic_hash;
    snapshots.push({
      dok_id: dok.dok_id,
      name: resolveTranslatable(dok.name, {
        locale: args.locale,
        primaryLocale: args.primaryLocale,
        lexicon: args.lexicon,
        roles: args.roles,
      }),
      content_sha256: dokContentDigest(dok),
      ...(logicHash ? { logic_hash: logicHash } : {}),
      version: dok._meta?.version ?? 1,
      status: dok.status,
    });
  }

  return snapshots.sort(byDokId);
}

export function dokContentDigest(dok: Dok): string {
  return createHash('sha256')
    .update(stableStringify(dok), 'utf8')
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Dok contains a non-JSON value');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}
