// Criterion: user-actions-min (Tier 2, content)
//
// A meaningful Dok has at least 3 user-action steps. Below this threshold
// the Dok rarely captures a complete user flow. autoFix is intentionally
// omitted — adding steps requires domain understanding.

import type { Criterion, Violation } from '../types.js';

export interface UserActionsMinViolationData {
  actual: number;
  threshold: number;
}

const MIN_STEPS = 3;

export const userActionsMin: Criterion<UserActionsMinViolationData> = {
  id: 'user-actions-min',
  description: `user_actions.steps는 최소 ${MIN_STEPS}개 이상이어야 함`,
  category: 'content',
  tier: 2,
  manualOnly: true,

  evaluate(input) {
    const violations: Violation<UserActionsMinViolationData>[] = [];
    for (const dok of input.doks) {
      const count = dok.user_actions?.steps.length ?? 0;
      if (count < MIN_STEPS) {
        violations.push({
          dokId: dok.dok_id,
          message: `user_actions has ${count} steps (min: ${MIN_STEPS})`,
          severity: 'warning',
          data: { actual: count, threshold: MIN_STEPS },
        });
      }
    }
    return violations;
  },
};
