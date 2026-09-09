**{{md_text (translate workspace.name)}}**

# {{t "doc_title"}}

{{t "subtitle"}}

**{{t "generated"}}:** {{format_date workspace.updated_at}}

## {{t "section_summary"}}

{{t "summary_lead"}}

| {{t "stat_doks"}} | {{t "stat_permission"}} | {{t "stat_restriction"}} |
| ---: | ---: | ---: |
| {{len doks}} | {{len (rules_by_type doks "permission")}} | {{len (rules_by_type doks "restriction")}} |

## {{t "section_access"}}

{{t "access_lead"}}

{{#if (len (rules_by_type doks "permission"))}}
| {{t "col_id"}} | {{t "col_dok"}} | {{t "col_desc"}} |
| --- | --- | --- |
{{#each (rules_by_type doks "permission")}}
| {{md_code this.rule.id}} | {{md_cell (translate this.dok_name)}} ({{md_code this.dok_id}}) | {{md_cell (translate this.rule.description)}} |
{{/each}}
{{else}}
{{t "no_rules"}}
{{/if}}

## {{t "section_constraints"}}

{{t "constraints_lead"}}

{{#if (len (rules_by_type doks "restriction"))}}
| {{t "col_id"}} | {{t "col_dok"}} | {{t "col_desc"}} |
| --- | --- | --- |
{{#each (rules_by_type doks "restriction")}}
| {{md_code this.rule.id}} | {{md_cell (translate this.dok_name)}} ({{md_code this.dok_id}}) | {{md_cell (translate this.rule.description)}} |
{{/each}}
{{else}}
{{t "no_rules"}}
{{/if}}

## {{t "section_other"}}

{{t "other_lead"}}

### {{t "type_policy"}}

{{#if (len (rules_by_type doks "policy"))}}
{{#each (rules_by_type doks "policy")}}
- **{{md_code this.rule.id}}** — {{md_text (translate this.rule.description)}}
{{/each}}
{{else}}
{{t "no_rules"}}
{{/if}}

### {{t "type_validation"}}

{{#if (len (rules_by_type doks "validation"))}}
{{#each (rules_by_type doks "validation")}}
- **{{md_code this.rule.id}}** — {{md_text (translate this.rule.description)}}
{{/each}}
{{else}}
{{t "no_rules"}}
{{/if}}

---

_{{t "disclaimer"}}_
