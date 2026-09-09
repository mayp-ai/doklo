// Criterion: business-rule-id-format (Tier 1, structural)
//
// Each BR id must (a) match BR-{DOK_ID}-NN and (b) embed *this* dok's id.
// The Zod schema only enforces (a) — we add (b) explicitly. Same check
// applies to acceptance_criteria ids and related_rules pointers.
//
// (b) needs an exact-tail check, not a bare startsWith: since dok_id is
// now a semantic name (1-3 segments) rather than a fixed DOMAIN-NNN
// shape, one dok_id can be a string-prefix of a sibling's (e.g. 'AUTH'
// vs 'AUTH-SIGNIN'), so `startsWith('BR-AUTH-')` alone would also match
// 'BR-AUTH-SIGNIN-01'. See brIdHasMatchingDok / acIdHasMatchingDok.
//
// autoFix rebuilds ids from the canonical dok_id while preserving order:
// rules become -01, -02, ... in their array order. Inter-references in
// related_rules are rewritten by index match.

import { BusinessRuleIdSchema, AcceptanceCriteriaIdSchema } from '@doklo-beta/core';
import type { Dok } from '@doklo-beta/core';
import type { Criterion, EvalPatch, Violation } from '../types.js';

export interface BusinessRuleIdViolationData {
  /** Which container the bad id was found in. */
  field: 'business_rule' | 'acceptance_criterion' | 'related_rule';
  badId: string;
  /** Index within its array (for autoFix to locate it). */
  index: number;
  reason: string;
}

// A bare `startsWith(prefix)` is not enough: dok_id 'AUTH' is itself a
// string-prefix of the sibling dok_id 'AUTH-SIGNIN', so
// 'BR-AUTH-SIGNIN-01'.startsWith('BR-AUTH-') is true even though that rule
// structurally belongs to 'AUTH-SIGNIN', not 'AUTH'. Require the tail
// after the prefix to be exactly the 2-digit serial — same exact-tail
// check DokSchema's superRefine uses in packages/core/src/schemas/dok.ts.
function brIdHasMatchingDok(brId: string, dokId: string): boolean {
  const prefix = `BR-${dokId}-`;
  if (!brId.startsWith(prefix)) return false;
  return /^\d{2}$/.test(brId.slice(prefix.length));
}

function acIdHasMatchingDok(acId: string, dokId: string): boolean {
  const prefix = `AC-${dokId}-`;
  if (!acId.startsWith(prefix)) return false;
  return /^\d{2}$/.test(acId.slice(prefix.length));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export const businessRuleIdFormat: Criterion<BusinessRuleIdViolationData> = {
  id: 'business-rule-id-format',
  description: 'BR/AC id는 BR-{DOK_ID}-NN / AC-{DOK_ID}-NN 형식이며 dok_id와 일치해야 함',
  category: 'structural',
  tier: 1,

  evaluate(input) {
    const violations: Violation<BusinessRuleIdViolationData>[] = [];
    for (const dok of input.doks) {
      // Business rules
      const rules = dok.business_rules?.rules ?? [];
      rules.forEach((r, idx) => {
        const formatOk = BusinessRuleIdSchema.safeParse(r.id).success;
        if (!formatOk) {
          violations.push({
            dokId: dok.dok_id,
            message: `business_rules[${idx}].id '${r.id}' fails BR-{DOK_ID}-NN regex`,
            severity: 'error',
            data: { field: 'business_rule', badId: r.id, index: idx, reason: 'regex' },
          });
        } else if (!brIdHasMatchingDok(r.id, dok.dok_id)) {
          violations.push({
            dokId: dok.dok_id,
            message: `business_rules[${idx}].id '${r.id}' does not embed dok_id '${dok.dok_id}'`,
            severity: 'error',
            data: { field: 'business_rule', badId: r.id, index: idx, reason: 'mismatch' },
          });
        }
      });

      // Acceptance criteria + related_rules
      const criteria = dok.acceptance_criteria?.criteria ?? [];
      criteria.forEach((c, idx) => {
        const formatOk = AcceptanceCriteriaIdSchema.safeParse(c.id).success;
        if (!formatOk) {
          violations.push({
            dokId: dok.dok_id,
            message: `acceptance_criteria[${idx}].id '${c.id}' fails AC-{DOK_ID}-NN regex`,
            severity: 'error',
            data: { field: 'acceptance_criterion', badId: c.id, index: idx, reason: 'regex' },
          });
        } else if (!acIdHasMatchingDok(c.id, dok.dok_id)) {
          violations.push({
            dokId: dok.dok_id,
            message: `acceptance_criteria[${idx}].id '${c.id}' does not embed dok_id '${dok.dok_id}'`,
            severity: 'error',
            data: { field: 'acceptance_criterion', badId: c.id, index: idx, reason: 'mismatch' },
          });
        }
        c.related_rules.forEach((rr, rIdx) => {
          const refOk = BusinessRuleIdSchema.safeParse(rr).success;
          if (!refOk) {
            violations.push({
              dokId: dok.dok_id,
              message: `acceptance_criteria[${idx}].related_rules[${rIdx}] '${rr}' fails BR-{DOK_ID}-NN regex`,
              severity: 'error',
              data: { field: 'related_rule', badId: rr, index: idx, reason: 'regex' },
            });
          }
        });
      });
    }
    return violations;
  },

  autoFix(violations, input): EvalPatch {
    // Strategy: for any dok touched by violations, rebuild BR ids and AC ids
    // from the dok_id, preserving array order. related_rules pointers are
    // rewritten by mapping old BR id → new BR id (built before the rebuild).
    const doks = input.doks.map((d) => structuredClone(d) as Dok);
    const touchedDokIds = new Set(
      violations.map((v) => v.dokId).filter((v): v is string => v !== null),
    );
    const changes: string[] = [];

    for (const d of doks) {
      if (!touchedDokIds.has(d.dok_id)) continue;

      const brRemap = new Map<string, string>();
      if (d.business_rules) {
        d.business_rules = {
          rules: d.business_rules.rules.map((r, i) => {
            const newId = `BR-${d.dok_id}-${pad2(i + 1)}`;
            if (newId !== r.id) {
              brRemap.set(r.id, newId);
              changes.push(`${d.dok_id}: ${r.id} → ${newId}`);
            }
            return { ...r, id: newId };
          }),
        };
      }
      if (d.acceptance_criteria) {
        d.acceptance_criteria = {
          criteria: d.acceptance_criteria.criteria.map((c, i) => {
            const newId = `AC-${d.dok_id}-${pad2(i + 1)}`;
            if (newId !== c.id) changes.push(`${d.dok_id}: ${c.id} → ${newId}`);
            return {
              ...c,
              id: newId,
              related_rules: c.related_rules.map((rr) => brRemap.get(rr) ?? rr),
            };
          }),
        };
      }
    }

    return { doks, changes };
  },
};
