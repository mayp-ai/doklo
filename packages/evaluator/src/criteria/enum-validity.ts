// Criterion: enum-validity (Tier 1, structural)
//
// Validates enum-typed fields against the v5 schemas: status,
// business_rules.rules[].type, user_actions.steps[].actor.kind, plus
// nested platform/interaction inside variants.
//
// Why explicit when DokSchema.parse() also covers this? Two reasons:
// (1) the evaluator may run on already-parsed data that bypassed full
// validation (e.g., post-edit golden), and (2) the report should call
// out the specific dok + path rather than collapse everything into a
// single Zod error.
//
// autoFix is omitted — corrections require human judgment (which enum
// value did the LLM intend?).

import {
  DokStatusSchema,
  BusinessRuleTypeSchema,
  PlatformSchema,
  InteractionSchema,
  ActorSchema,
} from '@doklo-beta/core';
import type { Criterion, Violation } from '../types.js';

export interface EnumValidityViolationData {
  path: string;
  badValue: unknown;
  allowed: readonly string[];
}

const STATUS_VALUES = DokStatusSchema.options;
const RULE_TYPE_VALUES = BusinessRuleTypeSchema.options;
const PLATFORM_VALUES = PlatformSchema.options;
const INTERACTION_VALUES = InteractionSchema.options;
const ACTOR_KINDS = ['role', 'system', 'external'] as const;

export const enumValidity: Criterion<EnumValidityViolationData> = {
  id: 'enum-validity',
  description: 'status / actor.kind / rule.type / platform / interaction은 정의된 enum 값이어야 함',
  category: 'structural',
  tier: 1,
  manualOnly: true,

  evaluate(input) {
    const violations: Violation<EnumValidityViolationData>[] = [];
    for (const dok of input.doks) {
      // status
      if (!DokStatusSchema.safeParse(dok.status).success) {
        violations.push({
          dokId: dok.dok_id,
          message: `status '${dok.status}' is not a valid enum`,
          severity: 'error',
          data: { path: 'status', badValue: dok.status, allowed: STATUS_VALUES },
        });
      }

      // business_rules[].type
      const rules = dok.business_rules?.rules ?? [];
      rules.forEach((r, idx) => {
        if (!BusinessRuleTypeSchema.safeParse(r.type).success) {
          violations.push({
            dokId: dok.dok_id,
            message: `business_rules[${idx}].type '${String(r.type)}' is invalid`,
            severity: 'error',
            data: {
              path: `business_rules.rules[${idx}].type`,
              badValue: r.type,
              allowed: RULE_TYPE_VALUES,
            },
          });
        }
      });

      // user_actions[].actor + variants
      const steps = dok.user_actions?.steps ?? [];
      steps.forEach((s, sIdx) => {
        // actor must validate as a discriminated union
        if (!ActorSchema.safeParse(s.actor).success) {
          violations.push({
            dokId: dok.dok_id,
            message: `user_actions.steps[${sIdx}].actor is not a valid discriminated union`,
            severity: 'error',
            data: {
              path: `user_actions.steps[${sIdx}].actor`,
              badValue: s.actor,
              allowed: ACTOR_KINDS,
            },
          });
        }
        s.variants.forEach((v, vIdx) => {
          if (!PlatformSchema.safeParse(v.platform).success) {
            violations.push({
              dokId: dok.dok_id,
              message: `user_actions.steps[${sIdx}].variants[${vIdx}].platform '${String(v.platform)}' is invalid`,
              severity: 'error',
              data: {
                path: `user_actions.steps[${sIdx}].variants[${vIdx}].platform`,
                badValue: v.platform,
                allowed: PLATFORM_VALUES,
              },
            });
          }
          if (!InteractionSchema.safeParse(v.interaction).success) {
            violations.push({
              dokId: dok.dok_id,
              message: `user_actions.steps[${sIdx}].variants[${vIdx}].interaction '${String(v.interaction)}' is invalid`,
              severity: 'error',
              data: {
                path: `user_actions.steps[${sIdx}].variants[${vIdx}].interaction`,
                badValue: v.interaction,
                allowed: INTERACTION_VALUES,
              },
            });
          }
        });
      });
    }
    return violations;
  },
};
