import type { Dok } from '../schemas/dok.js';

export interface ChangeProposal {
  summary: string;
}

type Jsonish = Record<string, unknown>;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Jsonish)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function same(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * The content a customer-facing change summary is allowed to talk about.
 * `_meta` (evidence/audit), `status` (review lifecycle) and `priority`
 * (triage, regenerated signals) are noise for "what changed in the feature".
 */
function contentView(dok: Dok): Jsonish {
  const { _meta, status, priority, ...content } = dok as unknown as Jsonish;
  void _meta;
  void status;
  void priority;
  return content;
}

interface IdCounts {
  added: number;
  removed: number;
  revised: number;
}

function diffById(
  prev: Array<Jsonish> | undefined,
  next: Array<Jsonish> | undefined,
  idKey: string,
): IdCounts {
  const prevById = new Map((prev ?? []).map((item) => [String(item[idKey]), item]));
  const nextById = new Map((next ?? []).map((item) => [String(item[idKey]), item]));
  let added = 0;
  let removed = 0;
  let revised = 0;
  for (const [id, item] of nextById) {
    const before = prevById.get(id);
    if (before === undefined) added += 1;
    else if (!same(before, item)) revised += 1;
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removed += 1;
  }
  return { added, removed, revised };
}

function diffByIndex(
  prev: Array<Jsonish> | undefined,
  next: Array<Jsonish> | undefined,
): IdCounts {
  const before = prev ?? [];
  const after = next ?? [];
  const added = Math.max(0, after.length - before.length);
  const removed = Math.max(0, before.length - after.length);
  let revised = 0;
  const overlap = Math.min(before.length, after.length);
  for (let i = 0; i < overlap; i += 1) {
    if (!same(before[i], after[i])) revised += 1;
  }
  return { added, removed, revised };
}

function count(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

function pushCounts(clauses: string[], counts: IdCounts, singular: string, plural: string): void {
  if (counts.added > 0) clauses.push(`added ${count(counts.added, singular, plural)}`);
  if (counts.revised > 0) clauses.push(`revised ${count(counts.revised, singular, plural)}`);
  if (counts.removed > 0) clauses.push(`removed ${count(counts.removed, singular, plural)}`);
}

/**
 * Deterministic change proposal between the previously stored Dok and its
 * regeneration — a pure function of the two documents: no clock, no I/O, no
 * model call, so the automatic pipeline that stages it stays deterministic
 * and the sentence can never claim something the documents don't show.
 *
 * Returns null when the compared content is identical (a regeneration that
 * changed nothing customer-visible proposes nothing).
 */
export function computeChangeProposal(previous: Dok, next: Dok): ChangeProposal | null {
  const prevContent = contentView(previous);
  const nextContent = contentView(next);
  if (same(prevContent, nextContent)) return null;

  const clauses: string[] = [];
  if (!same(previous.name, next.name)) clauses.push('renamed the feature');
  if (!same(previous.description, next.description)) clauses.push('updated the description');

  const prevSteps = (previous.user_actions?.steps ?? []) as unknown as Jsonish[];
  const nextSteps = (next.user_actions?.steps ?? []) as unknown as Jsonish[];
  pushCounts(clauses, diffByIndex(prevSteps, nextSteps), 'step', 'steps');

  const prevRules = (previous.business_rules?.rules ?? []) as unknown as Jsonish[];
  const nextRules = (next.business_rules?.rules ?? []) as unknown as Jsonish[];
  pushCounts(clauses, diffById(prevRules, nextRules, 'id'), 'rule', 'rules');

  const prevCriteria = (previous.acceptance_criteria?.criteria ?? []) as unknown as Jsonish[];
  const nextCriteria = (next.acceptance_criteria?.criteria ?? []) as unknown as Jsonish[];
  pushCounts(
    clauses,
    diffById(prevCriteria, nextCriteria, 'id'),
    'acceptance criterion',
    'acceptance criteria',
  );

  if (clauses.length === 0) return { summary: 'Updated feature details.' };
  const sentence = clauses.join('; ');
  return { summary: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.` };
}
