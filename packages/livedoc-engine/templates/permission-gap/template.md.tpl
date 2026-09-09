# {{t "title"}}

**{{t "meta_target"}}**: {{translate workspace.name}} · **{{t "meta_date"}}**: {{render_date}} · **{{t "meta_criteria"}}**: {{t "criteria_text"}}

> {{t "honesty_note"}}

{{#if (len (doks_without_rule_type doks "permission"))}}
## {{t "section_action"}}

{{t "action_intro"}}

1. {{t "action_1"}}
2. {{t "action_2"}}
3. {{t "action_3"}}
{{/if}}

## {{t "section_gaps"}} — {{len (doks_without_rule_type doks "permission")}}{{t "unit_cases"}}

{{#if (len (doks_without_rule_type doks "permission"))}}
| {{t "col_name"}} | {{t "col_have"}} | {{t "col_verdict"}} |
| --- | --- | --- |
{{#each (doks_without_rule_type doks "permission")}}
| {{translate this.name}} | {{#if (len (rule_types this.business_rules.rules))}}{{join (rule_types this.business_rules.rules) ", "}}{{else}}{{t "none_label"}}{{/if}} | {{t "verdict_cell"}} |
{{/each}}
{{else}}
{{t "no_gaps"}}
{{/if}}

{{t "scope_prefix"}} {{len (where_status doks "active")}} {{t "scope_suffix"}}
