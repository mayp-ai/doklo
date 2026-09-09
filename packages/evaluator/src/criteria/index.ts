// Criterion registry — single source of truth for both runners
// (violations + score). Order is the report's display order.

import type { Criterion } from '../types.js';
import { uniqueDokId } from './unique-dok-id.js';
import { dokIdFormat } from './dok-id-format.js';
import { businessRuleIdFormat } from './business-rule-id-format.js';
import { enumValidity } from './enum-validity.js';
import { requiredFieldsPresent } from './required-fields-present.js';
import { userActionsMin } from './user-actions-min.js';

export {
  uniqueDokId,
  dokIdFormat,
  businessRuleIdFormat,
  enumValidity,
  requiredFieldsPresent,
  userActionsMin,
};

/**
 * Default registry — every criterion currently shipped.
 * Both runners default to this list; callers can pass a filtered subset
 * (e.g., `criteria.filter(c => c.tier === 1)`) for tier-specific runs.
 *
 * `prefix-uniformity` (same-prefix-shares-a-serial) was retired when
 * semantic dok_ids replaced the -NNN serial: with the id itself acting as
 * the prefix, "uniformity within a prefix" is no longer a coherent check,
 * and there is nothing left to relocate doks to. `unique-dok-id` no
 * longer autoFixes either — see its file for why — so no criterion in
 * this catalogue currently renames a dok_id. `business-rule-id-format`
 * remains the only id-shaped autoFix: it rebuilds BR / AC ids from each
 * dok's own (already-correct) dok_id.
 *
 * Cast to `Criterion[]` because each criterion narrows its TViolation
 * generic; callers consume them via the base Criterion contract.
 */
export const ALL_CRITERIA: Criterion[] = [
  uniqueDokId,
  businessRuleIdFormat,
  dokIdFormat,
  enumValidity,
  requiredFieldsPresent,
  userActionsMin,
] as Criterion[];
