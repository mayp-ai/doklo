// Pure tool logic for the MCP server — no SDK, no I/O, no stdout.
//
// Each function takes an already-loaded HubModel and returns a plain payload
// object. The server layer (server.ts) is the only thing that loads the Hub
// and wraps these payloads in MCP text content; unit tests call these directly.
//
// Agent-friendly output rules:
//  - Translatable fields (name/description/intent/outcome/...) are resolved to
//    plain strings via the Lexicon — TermRef objects never leak out.
//  - Operational meta (_meta.logic_hash/version/history/external_ids/
//    generation_confidence) is never exposed. Provenance (source_anchors) and
//    freshness (is_stale) always are — they are the trust signals.
//
// What `is_stale` claims (and does not) — it is about bytes, not correctness:
//    true      → the tracked source files changed after the Dok was generated,
//                so the Dok may be outdated; prefer the current code.
//    false     → those sources are byte-identical to generation time. This is
//                NOT a claim that the Dok is correct: a Dok that was wrong when
//                written stays `false` for as long as the code sits still.
//    'unknown' → no drift hash was recorded, so the check could not decide.
// Consumers (humans via `doklo show`, agents via these tools) must be told this
// boundary at the point of output — see the tool descriptions in server.ts.

import {
  resolveTranslatable,
  type Actor,
  type Dok,
  type HubModel,
  type Interaction,
  type LexiconTerm,
  type Platform,
  type PriorityTier,
  type SourceAnchor,
  type TranslateContext,
  type Translatable,
} from '@doklo-beta/core';
import {
  resolveDokStaleness,
  resolveDokTier,
  type Staleness,
} from './staleness.js';

// ───────── errors ───────────────────────────────────────────────────

/** Thrown by getDok when no Dok matches the requested id. The server maps
 *  this to an MCP tool error (isError: true) with an agent-actionable hint. */
export class DokNotFoundError extends Error {
  constructor(public readonly dokId: string) {
    super(`Dok not found: ${dokId}. Use list_doks to see available ids.`);
    this.name = 'DokNotFoundError';
  }
}

// ───────── shared helpers ────────────────────────────────────────────

/** Build the core TranslateContext once per tool call from a HubModel. */
function translateContext(hub: HubModel): TranslateContext {
  const primary = hub.workspace.default_locale;
  return {
    locale: primary,
    primaryLocale: primary,
    lexicon: hub.lexicon,
    roles: hub.roles,
  };
}

/** Resolve a Translatable to its display string (never returns a TermRef). */
function text(value: Translatable | undefined, ctx: TranslateContext): string {
  if (value == null) return '';
  return resolveTranslatable(value, ctx);
}

/** The display strings a Lexicon term carries — its authoritative `locales`
 *  (owned) or cached `snapshot` (constant/i18n). Used for search matching. */
function termDisplayStrings(term: LexiconTerm): string[] {
  const map = term.locales ?? term.snapshot ?? {};
  return Object.values(map);
}

/** True when a Translatable is a TermRef pointing at `termId`. */
function refersToTerm(value: Translatable | undefined, termId: string): boolean {
  return (
    value != null && typeof value !== 'string' && value.term_ref === termId
  );
}

/** True when any Translatable field of the Dok references `termId`. Covers the
 *  fields a term could realistically appear in: name/description, each step's
 *  intent/outcome and its variant targets/outcome overrides, business-rule
 *  descriptions, and acceptance-criteria statements. */
function dokReferencesTerm(dok: Dok, termId: string): boolean {
  if (refersToTerm(dok.name, termId)) return true;
  if (refersToTerm(dok.description, termId)) return true;
  for (const step of dok.user_actions?.steps ?? []) {
    if (refersToTerm(step.intent, termId)) return true;
    if (refersToTerm(step.outcome, termId)) return true;
    for (const v of step.variants) {
      if (refersToTerm(v.target, termId)) return true;
      if (refersToTerm(v.outcome_override, termId)) return true;
    }
  }
  for (const rule of dok.business_rules?.rules ?? []) {
    if (refersToTerm(rule.description, termId)) return true;
  }
  for (const c of dok.acceptance_criteria?.criteria ?? []) {
    if (refersToTerm(c.statement, termId)) return true;
  }
  return false;
}

function sourceAnchorsOf(dok: Dok): SourceAnchor[] {
  return dok._meta?.source_anchors ?? [];
}

function byDokId(a: { dok_id: string }, b: { dok_id: string }): number {
  return a.dok_id.localeCompare(b.dok_id);
}

// ───────── search_doks ───────────────────────────────────────────────

export type SearchMatchedOn =
  | 'dok_id'
  | 'name'
  | 'description'
  | 'intent'
  | 'tag'
  | 'lexicon';

export interface SearchResult {
  dok_id: string;
  name: string;
  description?: string;
  status: Dok['status'];
  is_stale: Staleness;
  /** How much it costs to be wrong about this Dok — see resolveDokTier. */
  priority_tier: PriorityTier;
  matched_on: SearchMatchedOn;
}

export interface SearchDoksResult {
  query: string;
  total: number;
  results: SearchResult[];
}

/** Deterministic lowercase substring search across a Dok's id, resolved
 *  name/description, step intents/outcomes and tags, plus Lexicon-term matches
 *  (a Dok referencing a term whose id or display text matches the query).
 *  Returns summaries only — no step/rule bodies — to keep the payload small. */
export function searchDoks(
  hub: HubModel,
  root: string,
  query: string,
): SearchDoksResult {
  const ctx = translateContext(hub);
  const needle = query.toLowerCase();

  // Lexicon term ids whose id or display text matches the query. A Dok that
  // references any of these via TermRef qualifies as a 'lexicon' match.
  const matchedTermIds = new Set<string>();
  for (const term of hub.lexicon.terms) {
    const haystacks = [term.term_id, ...termDisplayStrings(term)];
    if (haystacks.some((h) => h.toLowerCase().includes(needle))) {
      matchedTermIds.add(term.term_id);
    }
  }

  const results: SearchResult[] = [];
  for (const dok of hub.doks) {
    const name = text(dok.name, ctx);
    const description = text(dok.description, ctx);
    const matchedOn = firstMatch(dok, needle, name, description, ctx, matchedTermIds);
    if (!matchedOn) continue;
    results.push({
      dok_id: dok.dok_id,
      name,
      ...(description ? { description } : {}),
      status: dok.status,
      is_stale: resolveDokStaleness(dok, root),
      priority_tier: resolveDokTier(dok),
      matched_on: matchedOn,
    });
  }
  results.sort(byDokId);

  return { query, total: results.length, results };
}

/** First matching field in priority order, or null when nothing matches.
 *  Priority: dok_id → name → description → intent (steps) → tag → lexicon. */
function firstMatch(
  dok: Dok,
  needle: string,
  name: string,
  description: string,
  ctx: TranslateContext,
  matchedTermIds: Set<string>,
): SearchMatchedOn | null {
  if (dok.dok_id.toLowerCase().includes(needle)) return 'dok_id';
  if (name.toLowerCase().includes(needle)) return 'name';
  if (description.toLowerCase().includes(needle)) return 'description';
  for (const step of dok.user_actions?.steps ?? []) {
    const intent = text(step.intent, ctx).toLowerCase();
    const outcome = text(step.outcome, ctx).toLowerCase();
    if (intent.includes(needle) || outcome.includes(needle)) return 'intent';
  }
  if (dok.tags.some((t) => t.toLowerCase().includes(needle))) return 'tag';
  for (const termId of matchedTermIds) {
    if (dokReferencesTerm(dok, termId)) return 'lexicon';
  }
  return null;
}

// ───────── get_dok ───────────────────────────────────────────────────

export interface GetDokStepVariant {
  platform: Platform;
  interaction: Interaction;
  target?: string;
  outcome_override?: string;
}

export interface GetDokStep {
  order: number;
  actor: Actor; // discriminated union (role | system | external) — passed through
  intent: string;
  outcome: string;
  variants: GetDokStepVariant[];
}

export interface GetDokResult {
  dok_id: string;
  name: string;
  description: string;
  status: Dok['status'];
  tags: string[];
  surfaces: string[];
  user_actions: { steps: GetDokStep[] };
  business_rules: { rules: { id: string; type: string; description: string }[] };
  acceptance_criteria: {
    criteria: { id: string; statement: string; related_rules: string[] }[];
  };
  source_anchors: SourceAnchor[];
  is_stale: Staleness;
  /** How much it costs to be wrong about this Dok — see resolveDokTier. */
  priority_tier: PriorityTier;
}

/** Full body of a single Dok, id matched case-insensitively. Translatable
 *  fields are resolved; the actor discriminated union is passed through as-is.
 *  Throws DokNotFoundError when the id is unknown. */
export function getDok(hub: HubModel, root: string, dokId: string): GetDokResult {
  const wanted = dokId.toLowerCase();
  const dok = hub.doks.find((d) => d.dok_id.toLowerCase() === wanted);
  if (!dok) throw new DokNotFoundError(dokId);

  const ctx = translateContext(hub);
  const steps: GetDokStep[] = (dok.user_actions?.steps ?? []).map((s) => ({
    order: s.order,
    actor: s.actor, // discriminated union (role | system | external) — kept as-is
    intent: text(s.intent, ctx),
    outcome: text(s.outcome, ctx),
    variants: s.variants.map((v) => ({
      platform: v.platform,
      interaction: v.interaction,
      ...(v.target !== undefined ? { target: text(v.target, ctx) } : {}),
      ...(v.outcome_override !== undefined
        ? { outcome_override: text(v.outcome_override, ctx) }
        : {}),
    })),
  }));
  const rules = (dok.business_rules?.rules ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    description: text(r.description, ctx),
  }));
  const criteria = (dok.acceptance_criteria?.criteria ?? []).map((c) => ({
    id: c.id,
    statement: text(c.statement, ctx),
    related_rules: c.related_rules,
  }));

  return {
    dok_id: dok.dok_id,
    name: text(dok.name, ctx),
    description: text(dok.description, ctx),
    status: dok.status,
    tags: dok.tags,
    surfaces: dok.surfaces,
    user_actions: { steps },
    business_rules: { rules },
    acceptance_criteria: { criteria },
    source_anchors: sourceAnchorsOf(dok),
    is_stale: resolveDokStaleness(dok, root),
    priority_tier: resolveDokTier(dok),
  };
}

// ───────── list_doks ─────────────────────────────────────────────────

export interface ListDoksFilter {
  status?: string;
  service?: string;
  stale?: boolean;
}

export interface ListDoksResult {
  total: number;
  doks: {
    dok_id: string;
    name: string;
    status: Dok['status'];
    tags: string[];
    is_stale: Staleness;
    /** How much it costs to be wrong about this Dok — see resolveDokTier. */
    priority_tier: PriorityTier;
  }[];
}

/** Every Dok as a summary, optionally filtered by status, surfacing service,
 *  or staleness. Sorted by dok_id. (A Dok whose staleness is 'unknown' — e.g.
 *  one with no stored logic_hash to compare against — matches neither
 *  `stale: true` nor `stale: false`, so it is excluded from either filter.) */
export function listDoksTool(
  hub: HubModel,
  root: string,
  filter: ListDoksFilter = {},
): ListDoksResult {
  const ctx = translateContext(hub);
  const out: ListDoksResult['doks'] = [];
  for (const dok of hub.doks) {
    if (filter.status !== undefined && dok.status !== filter.status) continue;
    if (filter.service !== undefined && !dok.surfaces.includes(filter.service)) {
      continue;
    }
    const staleness = resolveDokStaleness(dok, root);
    if (filter.stale !== undefined && staleness !== filter.stale) continue;
    out.push({
      dok_id: dok.dok_id,
      name: text(dok.name, ctx),
      status: dok.status,
      tags: dok.tags,
      is_stale: staleness,
      priority_tier: resolveDokTier(dok),
    });
  }
  out.sort(byDokId);
  return { total: out.length, doks: out };
}
