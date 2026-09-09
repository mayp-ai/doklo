import type Handlebars from 'handlebars';
import type { BusinessRule } from '@doklo-beta/core';

export function registerRulesFor(hb: typeof Handlebars): void {
  /**
   * {{rules_for criterion.related_rules dok.business_rules.rules}}
   *
   * Resolve a list of business-rule ids to their rule objects so templates
   * can surface AC ↔ rule traceability (e.g. a "related rule: validation"
   * chip on each acceptance check). Unknown ids are dropped silently —
   * traceability rendering must never break a page over a dangling ref.
   */
  hb.registerHelper('rules_for', function (ids: unknown, rules: unknown) {
    if (!Array.isArray(ids) || !Array.isArray(rules)) return [];
    const byId = new Map(
      (rules as BusinessRule[]).filter((r) => r?.id).map((r) => [r.id, r]),
    );
    return (ids as string[]).map((id) => byId.get(id)).filter(Boolean);
  });
}
