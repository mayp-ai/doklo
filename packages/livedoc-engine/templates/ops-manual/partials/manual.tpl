{{#with this as |root|}}
# {{md_text (default vars.document_title (t "doc_title"))}}

{{md_text (default vars.system_name (translate workspace.name))}}

## {{t "doc_info"}}

| | |
| --- | --- |
| {{t "doc_name"}} | {{md_cell (default vars.document_title (t "doc_title"))}} |
{{#if vars.project_name}}| {{t "doc_project"}} | {{md_cell vars.project_name}} |
{{/if}}{{#if vars.organization}}| {{t "doc_org"}} | {{md_cell vars.organization}} |
{{/if}}| {{t "doc_system"}} | {{md_cell (default vars.system_name (translate workspace.name))}} |
| {{t "doc_version"}} | {{md_cell (default vars.document_version "1.0")}} |
| {{t "doc_as_of"}} | {{format_date generated_at}} |
{{#if vars.classification}}| {{t "doc_classification"}} | {{md_cell vars.classification}} |
{{/if}}| {{t "doc_readers"}} | {{#if vars.role}}{{t "readers_role"}} ({{md_cell (role_label vars.role)}}){{else}}{{t "readers_all"}}{{/if}} |
{{#if vars.prepared_by}}| {{t "doc_author"}} | {{md_cell vars.prepared_by}} |
{{/if}}

## {{t "revision_history"}}

| {{t "col_version"}} | {{t "col_date"}} | {{t "col_change"}} | {{t "col_author"}} |
| --- | --- | --- | --- |
| {{md_cell (default vars.document_version "1.0")}} | {{format_date generated_at}} | {{t "first_edition"}} | {{#if vars.prepared_by}}{{md_cell vars.prepared_by}}{{else}}{{t "na"}}{{/if}} |

## {{t "toc"}}

| {{t "col_section"}} | {{t "col_feature"}} |
| --- | --- |
| {{t "ch1"}} | |
| {{t "ch2"}} | |
| {{t "ch3"}} | |
| {{t "ch4"}} | |
{{#each doks}}| 4.{{add @index 1}} | {{md_cell (translate this.name)}} |
{{/each}}{{#if (add (len (rules_by_type doks "restriction")) (len (rules_by_type doks "policy")))}}| {{t "ch5"}} | |
{{/if}}{{#if vars.support_contact}}| {{t "ch6"}} | |
{{/if}}| {{t "appendix"}} | |

## {{t "ch1"}}

### {{t "purpose_title"}}

{{t "purpose_pre"}}{{md_text (default vars.system_name (translate workspace.name))}}{{t "purpose_post"}}

### {{t "scope_title"}}

{{t "scope_pre"}}{{len doks}}{{t "scope_post"}}

### {{t "legend_title"}}

| | |
| --- | --- |
| {{t "steps_col_no"}} | {{t "legend_step"}} |
| {{t "sec_rules"}} | {{t "legend_note"}} |
| {{t "sec_checks"}} | {{t "legend_check"}} |

## {{t "ch2"}}

{{#if vars.app_url}}
### {{t "access_title"}}

| {{t "app_url_label"}} | {{md_cell vars.app_url}} |
| --- | --- |

{{/if}}
{{#if hub.roles.roles.length}}
### {{t "roles_title"}}

| {{t "col_role"}} | {{t "col_role_kind"}} | {{t "col_role_features"}} |
| --- | --- | --- |
{{#each hub.roles.roles}}| {{md_cell (translate this.name)}} | {{#if (eq this.kind "actor_type")}}{{t "kind_actor_type"}}{{else}}{{t "kind_access"}}{{/if}} | {{#each (doks_for_role root.doks this.role_id)}}{{#if @index}}, {{/if}}{{md_cell (translate this.name)}}{{else}}{{t "na"}}{{/each}} |
{{/each}}

{{/if}}
## {{t "ch3"}}

{{#with (ia_index root.hub.services root.doks ".md") as |ia|}}
{{#if ia.sections.length}}
{{#each ia.sections}}
| {{t "col_menu"}} | {{t "col_feature"}} |
| --- | --- |
{{> ia-rows-md nodes=this.nodes depth=0}}

{{/each}}
{{#if ia.unplaced.length}}
{{t "menu_unplaced"}}: {{#each ia.unplaced}}{{#if @index}}, {{/if}}{{md_text (translate this.dok.name)}}{{/each}}

{{/if}}
{{else}}
| {{t "col_no"}} | {{t "col_feature"}} |
| --- | --- |
{{#each root.doks}}| {{add @index 1}} | {{md_cell (translate this.name)}} |
{{/each}}

{{/if}}
{{/with}}
## {{t "ch4"}}

{{#each doks}}
### 4.{{add @index 1}} {{md_text (translate this.name)}}

{{md_text (translate this.description)}}

| | |
| --- | --- |
{{#if this._meta.origins.length}}{{#each this._meta.origins}}{{#if this.primary_route}}| {{t "feature_route"}} | {{md_code this.primary_route}} |
{{/if}}{{/each}}{{/if}}| {{t "feature_roles"}} | {{#each (unique_actors this.user_actions.steps)}}{{#if @index}}, {{/if}}{{md_cell (actor_label this)}}{{else}}{{t "na"}}{{/each}} |
| {{t "feature_services"}} | {{#each this.surfaces}}{{#if @index}}, {{/if}}{{md_cell this}}{{else}}{{t "na"}}{{/each}} |

{{#if this.user_actions.steps.length}}
#### {{t "sec_steps"}}

| {{t "steps_col_no"}} | {{t "steps_col_actor"}} | {{t "steps_col_action"}} | {{t "steps_col_result"}} | {{t "steps_col_pre"}} |
| --- | --- | --- | --- | --- |
{{#each this.user_actions.steps}}| {{this.order}} | {{#if (eq this.actor.kind "system")}}{{t "auto_actor"}}{{else}}{{md_cell (actor_label this.actor)}}{{/if}} | {{md_cell (translate this.intent)}} | {{md_cell (translate this.outcome)}} | {{#if this.preconditions.length}}{{md_cell (join this.preconditions " · ")}}{{else}}{{t "na"}}{{/if}} |
{{/each}}

{{/if}}
{{#if this.business_rules.rules.length}}
#### {{t "sec_rules"}}

| {{t "rules_col_type"}} | {{t "rules_col_desc"}} |
| --- | --- |
{{#each this.business_rules.rules}}| {{#if (eq this.type "permission")}}{{t "rule_permission"}}{{else}}{{#if (eq this.type "validation")}}{{t "rule_validation"}}{{else}}{{#if (eq this.type "policy")}}{{t "rule_policy"}}{{else}}{{#if (eq this.type "calculation")}}{{t "rule_calculation"}}{{else}}{{t "rule_restriction"}}{{/if}}{{/if}}{{/if}}{{/if}} | {{md_cell (translate this.description)}} |
{{/each}}

{{/if}}
{{#if this.acceptance_criteria.criteria.length}}
#### {{t "sec_checks"}}

| {{t "checks_col_no"}} | {{t "checks_col_statement"}} |
| --- | --- |
{{#each this.acceptance_criteria.criteria}}| {{add @index 1}} | {{md_cell (translate this.statement)}} |
{{/each}}

{{/if}}
{{/each}}
{{#if (add (len (rules_by_type doks "restriction")) (len (rules_by_type doks "policy")))}}
## {{t "ch5"}}

{{t "cautions_lead"}}

| {{t "col_feature"}} | {{t "rules_col_type"}} | {{t "rules_col_desc"}} |
| --- | --- | --- |
{{#each (rules_by_type doks "restriction")}}| {{md_cell (translate this.dok_name)}} | {{t "rule_restriction"}} | {{md_cell (translate this.rule.description)}} |
{{/each}}{{#each (rules_by_type doks "policy")}}| {{md_cell (translate this.dok_name)}} | {{t "rule_policy"}} | {{md_cell (translate this.rule.description)}} |
{{/each}}

{{/if}}
{{#if vars.support_contact}}
## {{t "ch6"}}

{{t "contact_lead"}} {{md_text vars.support_contact}}

{{/if}}
## {{t "appendix"}}

| {{t "col_no"}} | {{t "col_feature"}} | {{t "col_id"}} | {{t "col_section"}} |
| --- | --- | --- | --- |
{{#each doks}}| {{add @index 1}} | {{md_cell (translate this.name)}} | {{md_code this.dok_id}} | 4.{{add @index 1}} |
{{/each}}
{{/with}}
