import type {
  DokHistoryCategory,
  DokHistoryEntry,
  DokMeta,
  DokStatus,
} from '../schemas/dok.js';

/** Synthetic first entry for a Dok that was already active before tracking began. */
export const BASELINE_CHANGE = 'Active before history tracking began';

/**
 * Engine-authored marker text for status entries. Consumers localize by
 * `kind`/`to` — they never parse this text.
 */
export const CANONICAL_STATUS_CHANGE: Record<DokStatus, string> = {
  draft: 'Returned to draft',
  review: 'Sent to review',
  active: 'Activated',
  planned: 'Marked as planned',
  deprecated: 'Deprecated',
  archived: 'Archived',
};

export function canonicalStatusChange(to: DokStatus): string {
  return CANONICAL_STATUS_CHANGE[to];
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Local calendar date, YYYY-MM-DD — the schema's stated convention (PR-diff stable). */
export function formatHistoryDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parses 'YYYY-MM-DD' into a local-noon Date (DST edges never shift the day). */
export function parseHistoryDate(s: string): Date {
  const m = DATE_PATTERN.exec(s);
  if (!m) throw new Error(`history date must be YYYY-MM-DD, got "${s}"`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  if (formatHistoryDate(d) !== s) {
    throw new Error(`history date is not a real calendar day: "${s}"`);
  }
  return d;
}

export function lastHistoryVersion(meta: DokMeta): number {
  const history = meta.history ?? [];
  return history.length === 0 ? 0 : history[history.length - 1]!.version;
}

/** Studio write policy: one bump per authored write, staying above hand-written entries. */
export function bumpVersion(meta: DokMeta): number {
  return Math.max(meta.version ?? 1, lastHistoryVersion(meta)) + 1;
}

/**
 * A Dok that has never been recorded and is (or was, before a regeneration
 * demoted it — `previousStatus`) active gets a baseline marker first, so the
 * changelog never mistakes a pre-existing feature for a new one.
 */
export function needsBaseline(
  meta: DokMeta,
  persistedStatus: DokStatus,
  previousStatus?: DokStatus,
): boolean {
  return (
    (meta.history ?? []).length === 0
    && (persistedStatus === 'active' || previousStatus === 'active')
  );
}

export interface AppendHistoryInput {
  /** `_meta` right before the write — Studio: the file's; generate: the carryForwardMeta result (already bumped). */
  meta: DokMeta;
  /** What the file held before this write. */
  persisted: { status: DokStatus; version: number };
  nextStatus: DokStatus;
  entry: {
    kind: 'edited' | 'status' | 'regenerated';
    change: string;
    category?: DokHistoryCategory;
    author?: string;
  };
  /**
   * 'bump' (Studio) allocates a new version; 'assigned' (generate) reuses
   * meta.version — carryForwardMeta already bumped it, one regeneration must
   * bump exactly once.
   */
  versionPolicy: 'bump' | 'assigned';
  /** Injected clock — the deterministic pipeline never calls this because it never appends. */
  now: () => Date;
  /**
   * Overrides the baseline judgment when a regeneration already demoted the
   * file: pass `pending_change`'s previous_status/base_version so a legacy
   * active Dok still gets its baseline at approval time.
   */
  baselineFrom?: { status: DokStatus; version: number };
}

export interface AppendHistoryResult {
  meta: DokMeta;
  appended: DokHistoryEntry[];
  version: number;
}

/** Pure. Returns a new meta with the entry (and a baseline when needed) appended. */
export function appendHistoryEntry(input: AppendHistoryInput): AppendHistoryResult {
  const change = input.entry.change.trim();
  if (change.length === 0) throw new Error('history entry change must not be empty');
  const statusChanged = input.persisted.status !== input.nextStatus;
  if (input.entry.kind === 'status' && !statusChanged) {
    throw new Error('a status history entry requires a status change');
  }
  const date = formatHistoryDate(input.now());
  const history: DokHistoryEntry[] = [...(input.meta.history ?? [])];
  const appended: DokHistoryEntry[] = [];

  const baselineSource = input.baselineFrom ?? input.persisted;
  if (history.length === 0 && baselineSource.status === 'active') {
    const baseline: DokHistoryEntry = {
      version: baselineSource.version,
      date,
      change: BASELINE_CHANGE,
      kind: 'baseline',
    };
    history.push(baseline);
    appended.push(baseline);
  }

  const last = history.length === 0 ? 0 : history[history.length - 1]!.version;
  let version = input.versionPolicy === 'bump'
    ? Math.max(input.meta.version ?? 1, last) + 1
    : (input.meta.version ?? 1);
  if (version <= last) version = last + 1;

  const entry: DokHistoryEntry = {
    version,
    date,
    change,
    ...(input.entry.author ? { author: input.entry.author } : {}),
    kind: input.entry.kind,
    ...(input.entry.kind === 'status' || statusChanged
      ? { from: input.persisted.status, to: input.nextStatus }
      : {}),
    ...(input.entry.category ? { category: input.entry.category } : {}),
  };
  history.push(entry);
  appended.push(entry);

  const meta: DokMeta = { ...input.meta, version, history };
  return { meta, appended, version };
}
