import type Handlebars from 'handlebars';
import type { Dok, BusinessRule } from '@doklo-beta/core';

interface RuleWithContext {
  dok_id: string;
  dok_name: Dok['name'];
  rule: BusinessRule;
}

export function registerRulesByType(hb: typeof Handlebars): void {
  /**
   * {{#each (rules_by_type doks "permission")}} ... {{/each}}
   *
   * Flatten every business rule of a given type across all (non-archived)
   * Doks, carrying the owning Dok's id + name. Used by the compliance-audit
   * template to render an access-control / constraints matrix grouped by
   * rule semantics rather than by Dok.
   *
   * Each entry: { dok_id, dok_name, rule } — rule.description is still a
   * Translatable, so templates call {{translate this.rule.description}}.
   */
  hb.registerHelper('rules_by_type', function (doks: unknown, type: unknown): RuleWithContext[] {
    if (!Array.isArray(doks)) return [];
    const want = String(type);
    const out: RuleWithContext[] = [];
    for (const d of doks as Dok[]) {
      if (!d || d.status === 'archived') continue;
      const rules = d.business_rules?.rules ?? [];
      for (const rule of rules) {
        if (rule.type === want) {
          out.push({ dok_id: d.dok_id, dok_name: d.name, rule });
        }
      }
    }
    return out;
  });
}
