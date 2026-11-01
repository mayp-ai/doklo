{{#if (len (rules_by_type doks type))}}
| {{t "col_id"}} | {{t "col_feature"}} | {{t "col_roles"}} | {{t "col_rule"}} | {{t "col_evidence"}} | {{t "col_status"}} |
| --- | --- | --- | --- | --- | --- |
{{#each (expand_rules doks)}}{{#if (eq this.rule.type ../type)}}| {{md_code this.rule.id}} | {{md_cell (translate this.dok.name)}} ({{md_code this.dok.dok_id}}) | {{#if this.rule.applies_to_roles.length}}{{#each this.rule.applies_to_roles}}{{#if @index}}, {{/if}}{{md_cell (role_label this)}}{{/each}}{{else}}{{t "roles_unspecified"}}{{/if}} | {{md_cell (translate this.rule.description)}} | {{#if this.rule.code_anchor}}{{#if this.rule.code_anchor.file}}{{md_code this.rule.code_anchor.file}} {{/if}}{{#if this.rule.code_anchor.function}}{{md_code this.rule.code_anchor.function}} {{/if}}{{#if this.rule.code_anchor.api}}{{md_code this.rule.code_anchor.api}} {{/if}}{{#if this.rule.code_anchor.db_constraint}}{{md_code this.rule.code_anchor.db_constraint}} {{/if}}{{#if this.rule.code_anchor.component}}{{md_code this.rule.code_anchor.component}} {{/if}}{{#if this.rule.code_anchor.db_field}}{{md_code this.rule.code_anchor.db_field}} {{/if}}{{#if this.rule.code_anchor.validation}}{{md_code this.rule.code_anchor.validation}} {{/if}}{{#if this.rule.code_anchor.constant}}{{md_code this.rule.code_anchor.constant}}{{/if}}{{else}}{{t "evidence_none"}}{{/if}} | {{> status-label status=this.dok.status}} |
{{/if}}{{/each}}
{{else}}
{{t "no_rules"}}
{{/if}}
