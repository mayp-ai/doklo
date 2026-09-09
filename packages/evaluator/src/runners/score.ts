// Runner: score
//
// 5-category, 500-point quality score for a single doks set. The category
// names match the Python evaluator (research worktree) so legacy reports
// stay comparable, but each category's sub-metrics were re-derived for v5
// — `linked_doks` is gone, `actor` is a discriminated union, and the
// per-Dok file model means we score absolute quality rather than
// candidate-vs-golden delta.
//
// The runner consumes an EvalReport produced by runViolations() and
// supplements it with content metrics that are too lightweight to
// warrant their own Criterion (description length, surfaces coverage,
// related_rules validity).

import type { Criterion, EvalInput, EvalReport } from '../types.js';
import type { Translatable } from '@doklo-beta/core';
import { ALL_CRITERIA } from '../criteria/index.js';
import { runViolations } from './violations.js';

export type CategoryName =
  | 'schemaCompliance'
  | 'groupingAccuracy'
  | 'businessExpression'
  | 'structuralCompleteness'
  | 'connectivity';

export interface CategoryScore {
  score: number;
  max: number;
  details: string[];
}

export interface ScoreReport {
  generatedAt: string;
  total: number;
  maxTotal: 500;
  categories: Record<CategoryName, CategoryScore>;
  /** dok count the score was computed against — useful for context. */
  totalDoks: number;
}

const MAX_PER_CATEGORY = 100 as const;
/** Description length below which a Dok feels under-described. */
const MIN_DESCRIPTION_LENGTH = 30;

export async function runScore(
  input: EvalInput,
  options: { criteria?: Criterion[]; report?: EvalReport } = {},
): Promise<ScoreReport> {
  const criteria = options.criteria ?? ALL_CRITERIA;
  const report = options.report ?? (await runViolations(input, criteria));
  const totalDoks = input.doks.length;

  const categories: Record<CategoryName, CategoryScore> = {
    schemaCompliance: scoreSchemaCompliance(report, totalDoks),
    groupingAccuracy: scoreGroupingAccuracy(report, totalDoks),
    businessExpression: scoreBusinessExpression(input, totalDoks),
    structuralCompleteness: scoreStructuralCompleteness(input, totalDoks),
    connectivity: scoreConnectivity(input, totalDoks),
  };

  const total = round1(
    categories.schemaCompliance.score +
      categories.groupingAccuracy.score +
      categories.businessExpression.score +
      categories.structuralCompleteness.score +
      categories.connectivity.score,
  );

  return {
    generatedAt: new Date().toISOString(),
    total,
    maxTotal: 500,
    categories,
    totalDoks,
  };
}

// ─── Category implementations ──────────────────────────────────────────

function scoreSchemaCompliance(
  report: EvalReport,
  totalDoks: number,
): CategoryScore {
  // dok-id-format (40) + business-rule-id-format (30) + enum-validity (30)
  const details: string[] = [];
  const a = passRate(report, 'dok-id-format', totalDoks);
  const b = passRate(report, 'business-rule-id-format', totalDoks);
  const c = passRate(report, 'enum-validity', totalDoks);
  const sub = a * 40 + b * 30 + c * 30;
  details.push(`dok-id format pass: ${formatRate(a)} (×40)`);
  details.push(`BR/AC id format pass: ${formatRate(b)} (×30)`);
  details.push(`enum validity pass: ${formatRate(c)} (×30)`);
  return { score: round1(sub), max: MAX_PER_CATEGORY, details };
}

function scoreGroupingAccuracy(
  report: EvalReport,
  totalDoks: number,
): CategoryScore {
  // unique-dok-id (100). prefix-uniformity used to share this category
  // (50/50) but was retired once semantic dok_ids replaced the -NNN
  // serial — the id itself is the prefix now, so "uniformity within a
  // prefix" no longer means anything, and there is nothing left to
  // relocate doks to. unique-dok-id alone carries the category.
  const details: string[] = [];
  const u = passRate(report, 'unique-dok-id', totalDoks);
  const sub = u * 100;
  details.push(`unique dok_id pass: ${formatRate(u)} (×100)`);
  return { score: round1(sub), max: MAX_PER_CATEGORY, details };
}

function scoreBusinessExpression(
  input: EvalInput,
  totalDoks: number,
): CategoryScore {
  if (totalDoks === 0)
    return { score: 0, max: MAX_PER_CATEGORY, details: ['no doks'] };

  let nameOk = 0;
  let descOk = 0;
  let descLongEnough = 0;
  let rulesRich = 0;
  for (const dok of input.doks) {
    if (translatableContent(dok.name).usable) nameOk += 1;
    const desc = translatableContent(dok.description);
    if (desc.usable) descOk += 1;
    if (desc.usable && (desc.length === null || desc.length >= MIN_DESCRIPTION_LENGTH))
      descLongEnough += 1;
    const rules = dok.business_rules?.rules ?? [];
    const richRules = rules.filter(
      (r) => translatableContent(r.description).usable,
    ).length;
    if (richRules >= 2) rulesRich += 1;
  }

  const a = nameOk / totalDoks;
  const b = descOk / totalDoks;
  const c = descLongEnough / totalDoks;
  const d = rulesRich / totalDoks;
  const sub = a * 25 + b * 25 + c * 25 + d * 25;
  return {
    score: round1(sub),
    max: MAX_PER_CATEGORY,
    details: [
      `name usable: ${formatRate(a)} (×25)`,
      `description usable: ${formatRate(b)} (×25)`,
      `description ≥${MIN_DESCRIPTION_LENGTH} chars: ${formatRate(c)} (×25)`,
      `≥2 rules with description: ${formatRate(d)} (×25)`,
    ],
  };
}

function scoreStructuralCompleteness(
  input: EvalInput,
  totalDoks: number,
): CategoryScore {
  if (totalDoks === 0)
    return { score: 0, max: MAX_PER_CATEGORY, details: ['no doks'] };

  let hasUserActions = 0;
  let hasBusinessRules = 0;
  let hasAcceptanceCriteria = 0;
  for (const dok of input.doks) {
    if ((dok.user_actions?.steps.length ?? 0) > 0) hasUserActions += 1;
    if ((dok.business_rules?.rules.length ?? 0) > 0) hasBusinessRules += 1;
    if ((dok.acceptance_criteria?.criteria.length ?? 0) > 0)
      hasAcceptanceCriteria += 1;
  }
  const a = hasUserActions / totalDoks;
  const b = hasBusinessRules / totalDoks;
  const c = hasAcceptanceCriteria / totalDoks;
  const sub = a * 35 + b * 30 + c * 35;
  return {
    score: round1(sub),
    max: MAX_PER_CATEGORY,
    details: [
      `user_actions present: ${formatRate(a)} (×35)`,
      `business_rules present: ${formatRate(b)} (×30)`,
      `acceptance_criteria present: ${formatRate(c)} (×35)`,
    ],
  };
}

function scoreConnectivity(
  input: EvalInput,
  totalDoks: number,
): CategoryScore {
  // v5 has no `linked_doks`. The closest analogues for "is this dok wired
  // into the rest of the hub?":
  //   - surfaces[] non-empty (the dok is exposed by at least one service)
  //   - acceptance_criteria.related_rules pointers resolve to this dok's BRs
  //   - tags non-empty (lightweight signal of categorization)
  if (totalDoks === 0)
    return { score: 0, max: MAX_PER_CATEGORY, details: ['no doks'] };

  let hasSurfaces = 0;
  let hasTags = 0;
  let totalRelated = 0;
  let validRelated = 0;
  for (const dok of input.doks) {
    if (dok.surfaces.length > 0) hasSurfaces += 1;
    if (dok.tags.length > 0) hasTags += 1;
    const ownBrIds = new Set(
      (dok.business_rules?.rules ?? []).map((r) => r.id),
    );
    for (const c of dok.acceptance_criteria?.criteria ?? []) {
      for (const rr of c.related_rules) {
        totalRelated += 1;
        if (ownBrIds.has(rr)) validRelated += 1;
      }
    }
  }
  const a = hasSurfaces / totalDoks;
  // related-rule integrity is computed only when at least one pointer
  // exists; otherwise skip and award the full sub-weight (no signal to
  // penalize — same "nothing to check" default used throughout this file,
  // e.g. passRate()'s !result branch).
  const b = totalRelated > 0 ? validRelated / totalRelated : 1;
  const c = hasTags / totalDoks;
  const sub = a * 40 + b * 40 + c * 20;
  return {
    score: round1(sub),
    max: MAX_PER_CATEGORY,
    details: [
      `surfaces non-empty: ${formatRate(a)} (×40)`,
      totalRelated > 0
        ? `related_rules → own BR integrity: ${formatRate(b)} (×40)`
        : `related_rules: no pointers present (×40, awarded by default)`,
      `tags non-empty: ${formatRate(c)} (×20)`,
    ],
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface TranslatableInfo {
  /** True if the value is either a non-empty inline string or a TermRef. */
  usable: boolean;
  /** Length in characters when an inline string; null for TermRef. */
  length: number | null;
}

function translatableContent(t: Translatable | undefined): TranslatableInfo {
  if (t === undefined) return { usable: false, length: 0 };
  if (typeof t === 'string') {
    const trimmed = t.trim();
    return { usable: trimmed.length > 0, length: trimmed.length };
  }
  // TermRef — Lexicon-backed; treat as usable by default. A separate
  // criterion (future) can verify the ref resolves.
  return { usable: true, length: null };
}

function passRate(report: EvalReport, criterionId: string, total: number): number {
  if (total === 0) return 1;
  const result = report.criteria.find((c) => c.id === criterionId);
  if (!result) return 1;
  // Use distinct dokId count so multiple violations on one dok count once.
  const failedDoks = new Set(
    result.violations.map((v) => v.dokId).filter((v): v is string => v !== null),
  ).size;
  return Math.max(0, (total - failedDoks) / total);
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
