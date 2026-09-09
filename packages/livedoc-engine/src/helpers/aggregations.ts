import type Handlebars from 'handlebars';
import type { AcceptanceCriterion, BusinessRule, Dok, Role, UserActionStep } from '@doklo-beta/core';

/**
 * Cross-Dok aggregation helpers — the deterministic joins behind the
 * "reverse query" Live Docs (file→obligations, role×feature, platform gaps).
 * All pure data transforms: no LLM, no I/O, stable ordering.
 */

export function rulesOf(d: Dok): BusinessRule[] {
  return d.business_rules?.rules ?? [];
}
export function acsOf(d: Dok): AcceptanceCriterion[] {
  return d.acceptance_criteria?.criteria ?? [];
}
export function stepsOf(d: Dok): UserActionStep[] {
  return d.user_actions?.steps ?? [];
}

/** Flat row per acceptance criterion with resolved rules + source anchors. */
export interface AcRow {
  dok: Dok;
  criterion: AcceptanceCriterion;
  rules: BusinessRule[];
  anchors: string[];
}

export function expandAcsRows(doks: Dok[]): AcRow[] {
  const rows: AcRow[] = [];
  for (const d of doks) {
    const byId = new Map(rulesOf(d).map((r) => [r.id, r]));
    const anchors = (d._meta?.source_anchors ?? []).map((a) => a.file).filter(Boolean);
    for (const c of acsOf(d)) {
      const rules = (c.related_rules ?? [])
        .map((id) => byId.get(id))
        .filter((r): r is BusinessRule => !!r);
      rows.push({ dok: d, criterion: c, rules, anchors });
    }
  }
  return rows;
}

/** Flat row per business rule with the ACs that verify it. */
export interface RuleRow {
  dok: Dok;
  rule: BusinessRule;
  acs: AcceptanceCriterion[];
  anchors: string[];
}

export function expandRuleRows(doks: Dok[]): RuleRow[] {
  const rows: RuleRow[] = [];
  for (const d of doks) {
    const anchors = (d._meta?.source_anchors ?? []).map((a) => a.file).filter(Boolean);
    for (const r of rulesOf(d)) {
      const acs = acsOf(d).filter((c) => (c.related_rules ?? []).includes(r.id));
      rows.push({ dok: d, rule: r, acs, anchors });
    }
  }
  return rows;
}

export function registerAggregations(hb: typeof Handlebars): void {
  /**
   * {{invert_anchors doks}} — file → Doks reverse index.
   *
   * Inverts every Dok's `_meta.source_anchors` into
   *   [{ file, doks: Dok[], rule_count, ac_count, roles: string[] }]
   * sorted by file path. rule_count/ac_count aggregate across the file's
   * Doks; roles is the deduped set of role-actor refs touching the file.
   */
  hb.registerHelper('invert_anchors', function (doks: unknown) {
    if (!Array.isArray(doks)) return [];
    const byFile = new Map<string, Dok[]>();
    for (const d of doks as Dok[]) {
      for (const anchor of d._meta?.source_anchors ?? []) {
        if (!anchor?.file) continue;
        const list = byFile.get(anchor.file) ?? [];
        if (!list.includes(d)) list.push(d);
        byFile.set(anchor.file, list);
      }
    }
    return [...byFile.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, ds]) => {
        const roles = new Set<string>();
        let ruleCount = 0;
        let acCount = 0;
        for (const d of ds) {
          ruleCount += rulesOf(d).length;
          acCount += acsOf(d).length;
          for (const s of stepsOf(d)) {
            if (s.actor.kind === 'role') roles.add(s.actor.role_ref);
          }
        }
        return { file, doks: ds, rule_count: ruleCount, ac_count: acCount, roles: [...roles] };
      });
  });

  /**
   * {{expand_acs doks}} — one row per acceptance criterion.
   *
   * [{ dok, criterion, rules, anchors }] in dok order, with
   * `related_rules` ids resolved against the owning Dok's rules.
   * The flat shape RTM-style traceability tables iterate over.
   */
  hb.registerHelper('expand_acs', function (doks: unknown) {
    if (!Array.isArray(doks)) return [];
    return expandAcsRows(doks as Dok[]);
  });

  /**
   * {{expand_rules doks}} — one row per business rule, with the ACs
   * that verify it (related_rules reverse lookup). Rules with zero
   * verifying ACs are the "uncovered rule" signal QA reports surface.
   */
  hb.registerHelper('expand_rules', function (doks: unknown) {
    if (!Array.isArray(doks)) return [];
    return expandRuleRows(doks as Dok[]);
  });

  /**
   * {{role_matrix doks roles}} — dok × role capability grid.
   *
   * [{ dok, cells: [{ role_id, role, step_count, rule_count, rule_types }] }]
   * step_count: steps where the role is the actor; rule_count/rule_types:
   * rules whose applies_to_roles includes the role. Rendering verdicts
   * (uses / restricted / n.a.) stay in the template.
   */
  hb.registerHelper('role_matrix', function (doks: unknown, roles: unknown) {
    if (!Array.isArray(doks) || !Array.isArray(roles)) return [];
    return (doks as Dok[]).map((d) => ({
      dok: d,
      cells: (roles as Role[]).map((role) => {
        const stepCount = stepsOf(d).filter(
          (s) => s.actor.kind === 'role' && s.actor.role_ref === role.role_id,
        ).length;
        const rules = rulesOf(d).filter((r) => (r.applies_to_roles ?? []).includes(role.role_id));
        const types = [...new Set(rules.map((r) => r.type))];
        return {
          role_id: role.role_id,
          role,
          step_count: stepCount,
          rule_count: rules.length,
          rule_types: types,
        };
      }),
    }));
  });

  /**
   * {{doks_without_rule_type doks "permission"}} — exception extractor.
   *
   * Active Doks that declare zero business rules of the given type — the
   * gap list audit-style reports lead with. Non-active Doks are excluded:
   * a planned feature can't fail a point-in-time inspection.
   */
  hb.registerHelper('doks_without_rule_type', function (doks: unknown, type: unknown) {
    if (!Array.isArray(doks)) return [];
    const t = String(type ?? '');
    return (doks as Dok[]).filter(
      (d) => d.status === 'active' && !rulesOf(d).some((r) => r.type === t),
    );
  });

  /**
   * {{where_status doks "active"}} — status filter (inspection scopes).
   */
  hb.registerHelper('where_status', function (doks: unknown, status: unknown) {
    if (!Array.isArray(doks)) return [];
    const s = String(status ?? '');
    return (doks as Dok[]).filter((d) => d.status === s);
  });

  /**
   * {{rule_types rules}} — unique rule types in first-appearance order.
   */
  hb.registerHelper('rule_types', function (rules: unknown) {
    if (!Array.isArray(rules)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rules as BusinessRule[]) {
      if (r?.type && !seen.has(r.type)) {
        seen.add(r.type);
        out.push(r.type);
      }
    }
    return out;
  });

  /**
   * {{doks_for_role doks "ROLE-ADMIN"}} — role-scoped curation.
   *
   * Doks where the role either performs a step (actor) or has rules
   * applied to it (applies_to_roles). The deterministic basis for
   * audience-curated packages (e.g. an operator manual).
   */
  hb.registerHelper('doks_for_role', function (doks: unknown, roleId: unknown) {
    if (!Array.isArray(doks)) return [];
    const id = String(roleId ?? '');
    return (doks as Dok[]).filter(
      (d) =>
        stepsOf(d).some((s) => s.actor.kind === 'role' && s.actor.role_ref === id) ||
        rulesOf(d).some((r) => (r.applies_to_roles ?? []).includes(id)),
    );
  });

  /**
   * {{variant_matrix doks}} — platform coverage per user step.
   *
   * { platforms: string[], rows: [{ dok, step, coverage, missing }] }
   * platforms = the deduped universe declared by role/external-actor steps
   * (system steps' 'all' is excluded — they have no UI surface).
   * coverage maps platform → interaction list; missing lists platforms in
   * the universe the step does not declare.
   */
  hb.registerHelper('variant_matrix', function (doks: unknown) {
    if (!Array.isArray(doks)) return { platforms: [], rows: [] };
    const universe = new Set<string>();
    const userSteps: Array<{ dok: Dok; step: UserActionStep }> = [];
    for (const d of doks as Dok[]) {
      for (const s of stepsOf(d)) {
        if (s.actor.kind === 'system') continue;
        userSteps.push({ dok: d, step: s });
        for (const v of s.variants ?? []) {
          if (v.platform && v.platform !== 'all') universe.add(v.platform);
        }
      }
    }
    const platforms = [...universe].sort();
    const rows = userSteps.map(({ dok, step }) => {
      const coverage: Record<string, string[]> = {};
      for (const v of step.variants ?? []) {
        if (!v.platform || v.platform === 'all') continue;
        (coverage[v.platform] ??= []).push(v.interaction);
      }
      const missing = platforms.filter((p) => !coverage[p]);
      return { dok, step, coverage, missing };
    });
    return { platforms, rows };
  });
}
