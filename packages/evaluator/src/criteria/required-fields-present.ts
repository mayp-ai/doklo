// Criterion: required-fields-present (Tier 1, structural)
//
// Required content fields (name, description) must not be empty or be a
// known placeholder marker. The Zod schema enforces non-empty strings
// for the inline-string branch of TranslatableSchema, but a TermRef can
// still point at a Lexicon entry that itself has no locales — that
// scenario is out of scope here (covered by a future lexicon-level
// criterion).
//
// Empty user_actions / business_rules / acceptance_criteria objects are
// also flagged: the schema makes them optional, but a golden Dok should
// have all three populated.

import type { Criterion, Violation } from '../types.js';

export interface RequiredFieldsViolationData {
  field: 'name' | 'description' | 'user_actions' | 'business_rules' | 'acceptance_criteria';
  reason: 'missing' | 'empty' | 'placeholder';
}

const PLACEHOLDER_RES = [
  /^TODO$/i,
  /^\(자동\)/,
  /^lorem ipsum/i,
  /^placeholder/i,
  /^xxx+$/i,
];

function isInlineString(t: unknown): t is string {
  return typeof t === 'string';
}

function looksLikePlaceholder(s: string): boolean {
  return PLACEHOLDER_RES.some((re) => re.test(s.trim()));
}

export const requiredFieldsPresent: Criterion<RequiredFieldsViolationData> = {
  id: 'required-fields-present',
  description: 'name / description / user_actions / business_rules / acceptance_criteria가 비어있지 않아야 함',
  category: 'structural',
  tier: 1,
  manualOnly: true,

  evaluate(input) {
    const violations: Violation<RequiredFieldsViolationData>[] = [];
    for (const dok of input.doks) {
      // name
      if (isInlineString(dok.name)) {
        if (dok.name.trim().length === 0) {
          violations.push({
            dokId: dok.dok_id,
            message: 'name is empty',
            severity: 'error',
            data: { field: 'name', reason: 'empty' },
          });
        } else if (looksLikePlaceholder(dok.name)) {
          violations.push({
            dokId: dok.dok_id,
            message: `name looks like a placeholder: '${dok.name}'`,
            severity: 'warning',
            data: { field: 'name', reason: 'placeholder' },
          });
        }
      }
      // description
      if (isInlineString(dok.description)) {
        if (dok.description.trim().length === 0) {
          violations.push({
            dokId: dok.dok_id,
            message: 'description is empty',
            severity: 'error',
            data: { field: 'description', reason: 'empty' },
          });
        } else if (looksLikePlaceholder(dok.description)) {
          violations.push({
            dokId: dok.dok_id,
            message: `description looks like a placeholder: '${dok.description}'`,
            severity: 'warning',
            data: { field: 'description', reason: 'placeholder' },
          });
        }
      }
      // section presence
      if (!dok.user_actions || dok.user_actions.steps.length === 0) {
        violations.push({
          dokId: dok.dok_id,
          message: 'user_actions section missing or empty',
          severity: 'warning',
          data: { field: 'user_actions', reason: 'missing' },
        });
      }
      if (!dok.business_rules || dok.business_rules.rules.length === 0) {
        violations.push({
          dokId: dok.dok_id,
          message: 'business_rules section missing or empty',
          severity: 'warning',
          data: { field: 'business_rules', reason: 'missing' },
        });
      }
      if (
        !dok.acceptance_criteria ||
        dok.acceptance_criteria.criteria.length === 0
      ) {
        violations.push({
          dokId: dok.dok_id,
          message: 'acceptance_criteria section missing or empty',
          severity: 'warning',
          data: { field: 'acceptance_criteria', reason: 'missing' },
        });
      }
    }
    return violations;
  },
};
