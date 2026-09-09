// Evaluator core types — Criterion, EvalInput, EvalPatch, EvalReport.
//
// Faithful to PLAN_dok-evaluator §3-1, but the inner shapes are v5 (per-Dok
// schema, no `linked_doks`, discriminated `actor`). The legacy EvalInput
// carried v4-specific FeatureConfig/ConsolidatedFeatureConfig/ScanResult
// references — in v5 those upstream artifacts live in different packages
// and may not exist when evaluating a finished golden, so we model them as
// optional hint maps the caller can build externally.

import type { Dok } from '@doklo-beta/core';

export type Severity = 'error' | 'warning';

export type CriterionCategory = 'structural' | 'content' | 'semantic';

/** Tier 1 — mechanical structural checks (must pass for golden status). */
/** Tier 2 — quantitative content checks (signals, partial autoFix). */
/** Tier 3 — semantic checks (LLM-judged; lives in src/semantic/ as runSemanticScore, intentionally outside ALL_CRITERIA and the 500-point runScore). */
export type CriterionTier = 1 | 2 | 3;

/**
 * Optional hints the runner can pass alongside doks. Keep this narrow on
 * purpose — the evaluator should never reach into generator internals.
 *
 * Currently unconsumed by any criterion in ALL_CRITERIA: this existed to
 * feed prefix-uniformity's "doks in the same consolidated feature must
 * share a dok_id prefix" check, which was retired once semantic dok_ids
 * replaced the -NNN serial (the id itself is the prefix now). Left in
 * place — still a valid shape for a future consolidation-grounded check —
 * but nothing currently reads it.
 */
export interface ConsolidationHints {
  /** Authoritative prefix per consolidated feature (canonical_id → prefix). */
  prefixesByCanonicalId: Map<string, string>;
  /**
   * dok_id → canonical_id mapping. Built by reading per-feature dok files
   * (each feature-{id}.json carries the source feature_id) and matching
   * against consolidated.groups[].features[].members[].
   */
  dokIdToCanonicalId: Map<string, string>;
}

export interface EvalInput {
  doks: Dok[];
  /** Optional consolidation hints — see ConsolidationHints doc comment. */
  consolidated?: ConsolidationHints | null;
  /**
   * Project root — reserved for Tier 3 file-anchor existence checks.
   * Currently unused; declared so the interface stays stable.
   */
  projectRoot?: string;
}

/**
 * Generic violation. Concrete criteria narrow `data` with a typed payload
 * the criterion's autoFix consumes.
 */
export interface Violation<TData = unknown> {
  /** dok_id whose presence triggered the violation, or null for cross-dok issues. */
  dokId: string | null;
  message: string;
  severity: Severity;
  /** Criterion-specific structured payload — used by autoFix. */
  data?: TData;
}

export interface EvalPatch {
  /** Updated doks (whole list — diff computed by caller). */
  doks: Dok[];
  /** Human-readable change log entries. */
  changes: string[];
}

export interface CriterionResultBase {
  id: string;
  description: string;
  category: CriterionCategory;
  tier: CriterionTier;
  autoFixable: boolean;
  passed: number;
  failed: number;
}

export interface CriterionResult<TData = unknown> extends CriterionResultBase {
  violations: Violation<TData>[];
}

export interface EvalReport {
  generatedAt: string;
  totalDoks: number;
  /** Doks that triggered at least one violation (any criterion). */
  doksWithIssues: number;
  criteria: CriterionResult[];
  /** dok_id → counts, built by aggregating across criteria. */
  perDokSummary: Record<string, { errors: number; warnings: number }>;
}

export interface Criterion<TData = unknown> {
  /** Stable kebab-case identifier (e.g., "dok-id-format"). */
  id: string;
  /** Human-readable description (Korean OK — surfaces in CLI/Studio reports). */
  description: string;
  category: CriterionCategory;
  tier: CriterionTier;

  /** Returns the violations found. Empty array = all passed. */
  evaluate(input: EvalInput): Violation<TData>[] | Promise<Violation<TData>[]>;

  /**
   * Apply automated fixes for the violations this criterion produced.
   * Receives back its own violations to avoid re-evaluation. The patch's
   * doks array replaces the input's doks.
   */
  autoFix?(violations: Violation<TData>[], input: EvalInput): EvalPatch;

  /** Marks criteria where autoFix is intentionally not provided. */
  manualOnly?: boolean;
}
