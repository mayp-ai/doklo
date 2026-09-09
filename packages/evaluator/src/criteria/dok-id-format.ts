// Criterion: dok-id-format (Tier 1, structural)
//
// Validates dok_id against DokIdSchema. v5 generator already runs id
// normalization upstream, so a violation here means the input bypassed
// that path (manual editing, foreign import). autoFix is intentionally
// omitted — no safe automatic transform exists for arbitrary malformed
// strings; surface the issue for manual review.

import { DokIdSchema } from '@doklo-beta/core';
import type { Criterion, Violation } from '../types.js';

export interface DokIdFormatViolationData {
  reason: string;
}

export const dokIdFormat: Criterion<DokIdFormatViolationData> = {
  id: 'dok-id-format',
  description: 'dok_id는 1~3 세그먼트 semantic name 형식이어야 함 (예: AUTH-SIGNIN)',
  category: 'structural',
  tier: 1,
  manualOnly: true,

  evaluate(input) {
    const violations: Violation<DokIdFormatViolationData>[] = [];
    for (const dok of input.doks) {
      const result = DokIdSchema.safeParse(dok.dok_id);
      if (!result.success) {
        violations.push({
          dokId: dok.dok_id,
          message: `dok_id format invalid: ${result.error.issues[0]?.message ?? 'unknown'}`,
          severity: 'error',
          data: { reason: result.error.issues[0]?.message ?? 'unknown' },
        });
      }
    }
    return violations;
  },
};
