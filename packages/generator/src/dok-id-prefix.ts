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
  const groupTokens = groupId.toLowerCase().split('-').filter(Boolean);
  const featureTokens = featureId.toLowerCase().split('-').filter(Boolean);

  const groupHead = groupTokens[0] ?? groupId;
  const groupSegment = abbrev(groupHead, {
    length: MAX_SEGMENT_LENGTH,
    consonantsOnly: opts.consonantsOnly,
  });

  // Drop tokens that duplicate the group, plus the generic "detail".
  const meaningful = featureTokens.filter((t) => {
    if (groupTokens.includes(t)) return false;
    if (t === 'detail') return false;
    return true;
  });

  if (meaningful.length === 0) return groupSegment;

  // Up to 2 more segments (3 total) — the last 2 meaningful tokens, which are
  // the most specific/differentiating ones for a multi-word feature id.
  const subSegments = meaningful.slice(-2).map((token) => abbrev(token, {
    length: MAX_SEGMENT_LENGTH,
    consonantsOnly: opts.consonantsOnly,
  }));

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

/** Neither the LLM-suggested prefix nor the auto-suggestion is available. */
export class DokIdPrefixCollisionError extends Error {
  constructor(readonly candidate: string, readonly canonicalId: string) {
    super(`Cannot assign a unique dok_id_prefix for feature "${canonicalId}" — ` +
      `candidate "${candidate}" is already taken. Rename one of the colliding features' ` +
      'dok_id_prefix in Studio\'s consolidation screen, or edit it directly in the consolidated ' +
      'cache (`.doklo/cache/<service>.consolidated.json`), or re-run `doklo consolidate`.');
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
  if (DokIdSchema.safeParse(normalized).success && !used.has(normalized)) return normalized;

  const suggested = suggestDokIdPrefix(canonicalId, groupId);
  if (DokIdSchema.safeParse(suggested).success && !used.has(suggested)) return suggested;

  throw new DokIdPrefixCollisionError(normalized || suggested, canonicalId);
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
