// Dok ID prefix suggestion + collision avoidance.
//
// v5: the "prefix" IS the Dok ID — there is no serial suffix appended after
// consolidation (see derive-service-meta.ts's assignDokIds). Grammar is
// shared with @doklo-beta/core's DokIdSchema: 1-3 UPPERCASE segments, each
// 2-10 chars, starting with a letter, first segment not BR/AC (reserved for
// child rule/criterion ids).

import { DokIdSchema } from '@doklo-beta/core';

/** Max length of a single Dok ID segment (matches DOK_ID_RE: 1 + 1-9 chars). */
const MAX_SEGMENT_LENGTH = 10;

export interface SuggestPrefixOptions {
  /** Strip vowels (except first letter) per segment — collision fallback. */
  consonantsOnly?: boolean;
}

// Suggest a prefix from a feature id within its group. Up to 3 segments:
// the group's head token, plus up to 2 remaining (non-duplicate, non-generic)
// feature tokens. Each segment is the full token, only truncated past 10
// chars — no more proactive 4-char abbreviation.
//
// Examples:
//   suggestDokIdPrefix("auth",              "auth")    → "AUTH"
//   suggestDokIdPrefix("program-detail",    "program") → "PROGRAM"
//   suggestDokIdPrefix("program-milestone", "program") → "PROGRAM-MILESTONE"
//   suggestDokIdPrefix("admin-mentor-list", "admin")   → "ADMIN-MENTOR-LIST"
export function suggestDokIdPrefix(
  featureId: string,
  groupId: string,
  opts: SuggestPrefixOptions = {},
): string {
  const groupTokens = idTokens(groupId);
  const featureTokens = idTokens(featureId);

  const groupHead = groupTokens[0] ?? 'dok';
  const groupSegment = toDokIdSegment(groupHead, opts, true);

  // Drop tokens that duplicate the group, plus the generic "detail".
  const meaningful = featureTokens.filter((t) => {
    if (groupTokens.includes(t)) return false;
    if (t === 'detail') return false;
    return true;
  });

  if (meaningful.length === 0) return groupSegment;

  // Up to 2 more segments (3 total) — the last 2 meaningful tokens, which are
  // the most specific/differentiating ones for a multi-word feature id.
  const subSegments = meaningful.slice(-2).map((token) =>
    toDokIdSegment(token, opts, false));

  return [groupSegment, ...subSegments].join('-');
}

// Wrapper for callers that don't have an LLM-suggested prefix to verify.
export function suggestUniqueDokIdPrefix(
  canonicalId: string,
  groupId: string,
  used: Set<string>,
): string {
  return ensureUniquePrefix(undefined, canonicalId, groupId, used);
}

/** Every valid deterministic candidate is already owned by another feature. */
export class DokIdPrefixCollisionError extends Error {
  constructor(readonly candidate: string, readonly canonicalId: string) {
    super(`Cannot assign a unique dok_id_prefix for feature "${canonicalId}" — ` +
      `candidate "${candidate}" is already in use. No consolidated cache was written. ` +
      'Change the source candidate ids/grouping or the proposed dok_id_prefix to a distinct ' +
      'valid id, then consolidate the updated input.');
  }
}

/** No candidate satisfies the shared Dok ID grammar. */
export class DokIdPrefixInvalidError extends Error {
  constructor(
    readonly candidate: string,
    readonly canonicalId: string,
    readonly suggested: string,
  ) {
    super(`Cannot assign a valid dok_id_prefix for feature "${canonicalId}" — ` +
      `candidate "${candidate}" and deterministic suggestion "${suggested}" do not satisfy ` +
      'the Dok ID schema. No consolidated cache was written. Change the source candidate ' +
      'ids/grouping or the proposed dok_id_prefix, then consolidate the updated input.');
  }
}

// Verify an LLM-suggested prefix and fall back to auto-generation:
//   1. LLM prefix, if it satisfies the shared Dok ID grammar and is unused
//   2. Auto-generated suggestion, if valid and unused
//   3. Otherwise: fail closed — the caller must resolve the conflict manually
export function ensureUniquePrefix(
  llmPrefix: string | undefined,
  canonicalId: string,
  groupId: string,
  used: Set<string>,
): string {
  const normalized = String(llmPrefix ?? '').trim().toUpperCase().replace(/_/g, '-');
  const normalizedIsValid = DokIdSchema.safeParse(normalized).success;
  if (normalizedIsValid && !used.has(normalized)) return normalized;

  const suggested = suggestDokIdPrefix(canonicalId, groupId);
  const suggestedIsValid = DokIdSchema.safeParse(suggested).success;
  if (suggestedIsValid && !used.has(suggested)) return suggested;

  const colliding = [
    normalizedIsValid && used.has(normalized) ? normalized : null,
    suggestedIsValid && used.has(suggested) ? suggested : null,
  ].find((candidate): candidate is string => candidate !== null);
  if (colliding) throw new DokIdPrefixCollisionError(colliding, canonicalId);

  throw new DokIdPrefixInvalidError(normalized, canonicalId, suggested);
}

function idTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function toDokIdSegment(
  token: string,
  opts: SuggestPrefixOptions,
  first: boolean,
): string {
  let segment = token.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!segment) segment = 'ID';
  if (/^[0-9]/.test(segment)) segment = `X${segment}`;
  if (segment.length === 1) segment += 'X';
  if (first && (segment === 'BR' || segment === 'AC')) segment += 'X';
  return abbrev(segment, {
    length: MAX_SEGMENT_LENGTH,
    consonantsOnly: opts.consonantsOnly,
  });
}

// Word → abbreviation. First 4 chars by default (unless `length` is given
// explicitly — suggestDokIdPrefix passes MAX_SEGMENT_LENGTH so its segments
// are full words), with an optional consonants-only mode for
// collision-resolution variants (e.g. "mentor" → "mntr").
export function abbrev(
  word: string,
  opts: { length?: number; consonantsOnly?: boolean } = {},
): string {
  const upper = word.toUpperCase();
  const targetLen = opts.length ?? 4;
  if (upper.length <= targetLen) return upper;

  if (opts.consonantsOnly) {
    const head = upper[0]!;
    const rest = upper.slice(1).replace(/[AEIOU]/g, '');
    return (head + rest).slice(0, targetLen);
  }

  return upper.slice(0, targetLen);
}
