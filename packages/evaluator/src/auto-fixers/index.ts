// Auto-fixers entrypoint
//
// Each criterion's fix lives next to its evaluate() function so the two
// stay in sync. This module is the single place callers hit when they
// say "apply every safe fix" — it walks the criterion catalogue in order,
// pulls the report's violations for each fixable criterion, and chains
// the patches.
//
// Chaining: a fix produces a new doks[] which becomes the input for the
// next fix. Re-evaluating between steps is intentionally NOT done here —
// fixers were ordered (see criteria/index.ts) so each one's output is a
// valid input for the next. Callers that want a clean re-evaluation
// should call runViolations() again on the result.

import type { Dok } from '@doklo-beta/core';
import type { Criterion, EvalInput, EvalReport } from '../types.js';
import { ALL_CRITERIA } from '../criteria/index.js';

export interface AutoFixOptions {
  /** Override the criterion catalogue (default: ALL_CRITERIA). */
  criteria?: Criterion[];
  /**
   * Restrict to specific criterion ids. If omitted, every fixable
   * criterion runs.
   */
  criterionIds?: string[];
}

export interface AutoFixResult {
  /** New doks after all fixes were applied. */
  doks: Dok[];
  /** Per-criterion change log entries. */
  changes: { criterionId: string; entries: string[] }[];
  /** Ids of criteria whose autoFix actually ran (had violations + was fixable). */
  appliedCriteria: string[];
  /** Total count of individual changes across all criteria. */
  totalChanges: number;
}

export function applyAutoFixes(
  input: EvalInput,
  report: EvalReport,
  options: AutoFixOptions = {},
): AutoFixResult {
  const criteria = options.criteria ?? ALL_CRITERIA;
  const filter = options.criterionIds
    ? new Set(options.criterionIds)
    : null;

  let currentDoks = input.doks;
  const changes: AutoFixResult['changes'] = [];
  const appliedCriteria: string[] = [];

  for (const criterion of criteria) {
    if (filter && !filter.has(criterion.id)) continue;
    if (criterion.manualOnly) continue;
    if (typeof criterion.autoFix !== 'function') continue;

    const result = report.criteria.find((c) => c.id === criterion.id);
    if (!result || result.violations.length === 0) continue;

    const patch = criterion.autoFix(result.violations, {
      ...input,
      doks: currentDoks,
    });
    if (patch.changes.length === 0) continue;

    currentDoks = patch.doks;
    changes.push({ criterionId: criterion.id, entries: patch.changes });
    appliedCriteria.push(criterion.id);
  }

  return {
    doks: currentDoks,
    changes,
    appliedCriteria,
    totalChanges: changes.reduce((acc, c) => acc + c.entries.length, 0),
  };
}
