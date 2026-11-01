{{#with this as |root|}}
# {{t "title"}} — {{md_text (translate workspace.name)}}

**{{t "meta_asof"}}** {{format_date generated_at}} · **{{t "meta_scope"}}** {{t "scope_text"}} {{len doks}}{{t "unit_features"}}{{#if hub.roles.roles.length}} · **{{t "meta_roles"}}** {{len hub.roles.roles}}{{/if}}

{{t "honesty"}}

{{t "reading"}}

{{#if hub.roles.roles.length}}
## {{t "s_roles"}}

| {{t "col_role"}} | {{t "col_role_kind"}} | {{t "col_role_scope"}} |
| --- | --- | --- |
{{#each hub.roles.roles}}| {{md_cell (translate this.name)}} | {{#if (eq this.kind "actor_type")}}{{t "kind_actor_type"}}{{else}}{{t "kind_access"}}{{/if}} | {{#if (eq this.scope "tenant")}}{{t "scope_tenant"}}{{else}}{{#if (eq this.scope "resource")}}{{t "scope_resource"}}{{else}}{{t "scope_global"}}{{/if}}{{/if}} |
{{/each}}

## {{t "s_table"}}
{{else}}
## {{t "s_table_no_roles"}}
{{/if}}

{{#with (help_categories root.hub.services root.doks ".md") as |ia|}}
{{#each ia.categories as |category|}}
### {{md_text (translate category.label)}}

| {{t "col_feature"}} |{{#each root.hub.roles.roles}} {{md_cell (translate this.name)}} |{{/each}} {{t "col_review"}} |
| --- |{{#each root.hub.roles.roles}} :---: |{{/each}} --- |
{{#each category.articles as |article|}}| {{md_cell (translate article.dok.name)}} |{{#each root.hub.roles.roles as |role|}} {{#if (includes (rule_roles article.dok.business_rules.rules "permission") role.role_id)}}●{{else}}{{#if (includes (step_roles article.dok.user_actions.steps) role.role_id)}}○{{else}}–{{/if}}{{/if}} |{{/each}} {{#if (includes (rule_types article.dok.business_rules.rules) "permission")}}{{#if (len (rule_roles article.dok.business_rules.rules "permission"))}}{{t "na"}}{{else}}{{t "review_unassigned"}}{{/if}}{{else}}{{t "review_none"}}{{/if}} |
{{/each}}

{{/each}}
{{#if ia.unplaced.length}}
{{#if ia.categories.length}}
### {{t "group_other"}}

{{/if}}
| {{t "col_feature"}} |{{#each root.hub.roles.roles}} {{md_cell (translate this.name)}} |{{/each}} {{t "col_review"}} |
| --- |{{#each root.hub.roles.roles}} :---: |{{/each}} --- |
{{#each ia.unplaced as |article|}}| {{md_cell (translate article.dok.name)}} |{{#each root.hub.roles.roles as |role|}} {{#if (includes (rule_roles article.dok.business_rules.rules "permission") role.role_id)}}●{{else}}{{#if (includes (step_roles article.dok.user_actions.steps) role.role_id)}}○{{else}}–{{/if}}{{/if}} |{{/each}} {{#if (includes (rule_types article.dok.business_rules.rules) "permission")}}{{#if (len (rule_roles article.dok.business_rules.rules "permission"))}}{{t "na"}}{{else}}{{t "review_unassigned"}}{{/if}}{{else}}{{t "review_none"}}{{/if}} |
{{/each}}

{{/if}}
{{/with}}
## {{t "s_summary"}}

{{#if (len (doks_without_rule_type doks "permission"))}}
- **{{t "summary_none"}}** ({{len (doks_without_rule_type doks "permission")}}{{t "unit_features"}}): {{#each (doks_without_rule_type doks "permission")}}{{#if @index}}, {{/if}}{{md_text (translate this.name)}}{{/each}}
{{else}}
- {{t "summary_clear"}}
{{/if}}
{{#if (len (doks_with_unnamed_rule_type doks "permission"))}}
- **{{t "summary_unassigned"}}** ({{len (doks_with_unnamed_rule_type doks "permission")}}{{t "unit_features"}}): {{#each (doks_with_unnamed_rule_type doks "permission")}}{{#if @index}}, {{/if}}{{md_text (translate this.name)}}{{/each}}
{{/if}}
{{/with}}
