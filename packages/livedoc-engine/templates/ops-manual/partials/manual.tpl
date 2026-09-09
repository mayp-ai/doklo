# {{translate workspace.name}} {{t "title_suffix"}}

**{{t "meta_audience"}}**: {{#if variables.role}}{{t "meta_audience_role"}} ({{role_label variables.role}}){{else}}{{t "meta_audience_all"}}{{/if}} · **{{t "meta_date"}}**: {{render_date}} · **{{t "meta_features"}}**: {{len doks}}{{t "unit_features"}}

{{t "intro"}}

## {{t "toc_title"}}

| {{t "toc_col_no"}} | {{t "toc_col_name"}} | {{t "toc_col_id"}} |
| --- | --- | --- |
{{#each doks}}
| {{add @index 1}} | {{translate this.name}} | `{{this.dok_id}}` |
{{/each}}

{{#each doks}}
## {{add @index 1}}. {{translate this.name}}

{{translate this.description}}

### {{t "sec_steps"}}

{{#if this.user_actions.steps.length}}
| {{t "steps_col_no"}} | {{t "steps_col_actor"}} | {{t "steps_col_action"}} | {{t "steps_col_result"}} |
| --- | --- | --- | --- |
{{#each this.user_actions.steps}}
| {{add @index 1}} | {{#if (eq this.actor.kind "system")}}{{t "auto_actor"}}{{else}}{{actor_label this.actor}}{{/if}} | {{translate this.intent}} | {{translate this.outcome}} |
{{/each}}
{{else}}
{{t "no_steps"}}
{{/if}}

### {{t "sec_rules"}}

{{#if this.business_rules.rules.length}}
| {{t "rules_col_type"}} | {{t "rules_col_desc"}} |
| --- | --- |
{{#each this.business_rules.rules}}
| {{#if (eq this.type "permission")}}{{t "rule_permission"}}{{else}}{{#if (eq this.type "validation")}}{{t "rule_validation"}}{{else}}{{#if (eq this.type "policy")}}{{t "rule_policy"}}{{else}}{{#if (eq this.type "calculation")}}{{t "rule_calculation"}}{{else}}{{t "rule_restriction"}}{{/if}}{{/if}}{{/if}}{{/if}} | {{translate this.description}} |
{{/each}}
{{else}}
{{t "no_rules"}}
{{/if}}

### {{t "sec_checks"}}

{{#if this.acceptance_criteria.criteria.length}}
| {{t "checks_col_no"}} | {{t "checks_col_statement"}} |
| --- | --- |
{{#each this.acceptance_criteria.criteria}}
| {{add @index 1}} | {{translate this.statement}} |
{{/each}}
{{else}}
{{t "no_checks"}}
{{/if}}

{{/each}}
---

{{t "footer"}}
