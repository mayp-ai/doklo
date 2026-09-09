// Runner: violations
//
// Drives the criterion catalogue against an EvalInput and aggregates the
// results into an EvalReport. Used by the interactive golden authoring
// flow — surface violations, optionally apply autoFix, repeat.
//
// Async-aware: a criterion may return a Promise (Tier 3 LLM-judged
// criteria, future). Tier 1-2 criteria are synchronous; Promise.resolve
// wraps them transparently.

import type {
  Criterion,
  CriterionResult,
  EvalInput,
  EvalReport,
  Severity,
  Violation,
} from '../types.js';
import { ALL_CRITERIA } from '../criteria/index.js';

export async function runViolations(
  input: EvalInput,
  criteria: Criterion[] = ALL_CRITERIA,
): Promise<EvalReport> {
  const totalDoks = input.doks.length;
  const perDokSummary: Record<string, { errors: number; warnings: number }> = {};
  const dokIds = new Set<string>(); // doks that have at least one violation
  const results: CriterionResult[] = [];

  for (const criterion of criteria) {
    const violations = await Promise.resolve(criterion.evaluate(input));
    const passed = totalDoks - new Set(violations.map((v) => v.dokId)).size;
    const failed = totalDoks - passed;
    results.push({
      id: criterion.id,
      description: criterion.description,
      category: criterion.category,
      tier: criterion.tier,
      autoFixable: typeof criterion.autoFix === 'function' && !criterion.manualOnly,
      passed,
      failed,
      violations,
    });
    accumulatePerDok(violations, perDokSummary, dokIds);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalDoks,
    doksWithIssues: dokIds.size,
    criteria: results,
    perDokSummary,
  };
}

function accumulatePerDok(
  violations: Violation[],
  acc: Record<string, { errors: number; warnings: number }>,
  dokIds: Set<string>,
): void {
  for (const v of violations) {
    if (!v.dokId) continue;
    dokIds.add(v.dokId);
    let entry = acc[v.dokId];
    if (!entry) {
      entry = { errors: 0, warnings: 0 };
      acc[v.dokId] = entry;
    }
    bumpSeverity(entry, v.severity);
  }
}

function bumpSeverity(
  entry: { errors: number; warnings: number },
  severity: Severity,
): void {
  if (severity === 'error') entry.errors += 1;
  else entry.warnings += 1;
}
