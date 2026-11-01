{{#if variables.organization}}{{md_text variables.organization}}

{{/if}}# {{md_text (default variables.document_title (t "doc_title"))}}

{{md_text (default variables.system_name (translate workspace.name))}} — {{t "doc_kind"}}

| | |
| --- | --- |
{{#if variables.project_name}}| **{{t "cover_project"}}** | {{md_cell variables.project_name}} |
{{/if}}| **{{t "cover_system"}}** | {{md_cell (default variables.system_name (translate workspace.name))}} |
{{#if variables.organization}}| **{{t "cover_org"}}** | {{md_cell variables.organization}} |
{{/if}}| **{{t "cover_version"}}** | {{md_cell (default variables.document_version "1.0")}} |
| **{{t "cover_asof"}}** | {{format_date generated_at}} |
{{#if variables.classification}}| **{{t "cover_classification"}}** | {{md_cell variables.classification}} |
{{/if}}| **{{t "cover_scope"}}** | {{t "cover_scope_pre"}}{{len doks}}{{t "cover_scope_mid1"}}{{len (expand_rules doks)}}{{t "cover_scope_mid2"}}{{len (expand_acs doks)}}{{t "cover_scope_post"}} |

**{{t "signoff_title"}}**

| {{t "signoff_role"}} | {{t "signoff_name"}} | {{t "signoff_date"}} | {{t "signoff_sign"}} |
| --- | --- | --- | --- |
| {{t "signoff_author"}} | {{md_cell variables.prepared_by}} | | |
| {{t "signoff_reviewer"}} | {{md_cell variables.reviewed_by}} | | |
| {{t "signoff_approver"}} | {{md_cell variables.approved_by}} | | |

**{{t "history_title"}}**

| {{t "col_version"}} | {{t "col_date"}} | {{t "col_change"}} | {{t "col_author"}} |
| --- | --- | --- | --- |
| {{md_cell (default variables.document_version "1.0")}} | {{format_date generated_at}} | {{t "history_change_pre"}}{{format_date generated_at}}{{t "history_change_post"}} | {{#if variables.prepared_by}}{{md_cell variables.prepared_by}}{{else}}{{t "na"}}{{/if}} |

## {{t "s1"}}

### {{t "s1_1"}}

{{t "s1_1_body_pre"}}**{{md_text (default variables.system_name (translate workspace.name))}}**{{t "s1_1_body_post"}}

### {{t "s1_2"}}

{{t "s1_2_body"}}

| {{t "scope_total"}} | {{t "scope_active"}} | {{t "scope_pending"}} | {{t "scope_planned"}} | {{t "scope_rules"}} | {{t "scope_acs"}} | {{t "col_service"}} | {{t "col_role_name"}} |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| {{len doks}} | {{len (where_status doks "active")}} | {{add (len (where_status doks "draft")) (len (where_status doks "review"))}} | {{len (where_status doks "planned")}} | {{len (expand_rules doks)}} | {{len (expand_acs doks)}} | {{len workspace.services}} | {{len hub.roles.roles}} |

### {{t "s1_3"}}

{{t "s1_3_body"}}

### {{t "s1_4"}}

- **{{t "notation_feature_id"}}** — {{t "notation_feature_id_def"}}
- **{{t "notation_rule_id"}}** — {{t "notation_rule_id_def"}}
- **{{t "notation_ac_id"}}** — {{t "notation_ac_id_def"}}
- **{{t "notation_status"}}** — {{t "notation_status_def"}}
- **{{t "notation_rule_type"}}** — {{t "notation_rule_type_def"}}
{{#if variables.include_structure}}{{#if hub.roles.roles.length}}- **{{t "notation_matrix"}}** — {{t "notation_matrix_def"}}
{{/if}}{{/if}}
{{#if variables.include_structure}}

## {{t "s2"}}

### {{t "s2_1"}}

| {{t "col_service"}} | {{t "col_service_type"}} | {{t "col_desc"}} |
| --- | --- | --- |
{{#each workspace.services}}| {{md_code this.service_id}} | {{> service-type-label type=this.type}} | {{#if this.description}}{{md_cell this.description}}{{else}}{{t "na"}}{{/if}} |
{{/each}}

### {{t "s2_2"}}

{{#with (ia_index hub.services doks ".md")}}
{{#if this.sections.length}}
{{t "s2_2_body"}}

{{#each this.sections}}
**{{md_code this.service_id}}**

| {{t "col_menu"}} | {{t "col_path"}} | {{t "col_feature"}} |
| --- | --- | --- |
{{> ia-rows-md nodes=this.nodes depth=0}}

{{/each}}
{{#if this.unplaced.length}}
{{t "ia_unplaced"}}: {{#each this.unplaced}}{{#if @index}}, {{/if}}{{md_text (translate this.dok.name)}} ({{md_code this.dok.dok_id}}){{/each}}
{{/if}}
{{else}}
{{t "ia_none"}}
{{/if}}
{{/with}}

### {{t "s2_3"}}

{{#if hub.roles.roles.length}}
| {{t "col_role_id"}} | {{t "col_role_name"}} | {{t "col_role_kind"}} | {{t "col_role_scope"}} | {{t "col_desc"}} | {{t "col_role_feats"}} |
| --- | --- | --- | --- | --- | ---: |
{{#each hub.roles.roles}}| {{md_code this.role_id}} | {{md_cell (translate this.name)}} | {{> role-kind-label kind=this.kind}} | {{> role-scope-label scope=this.scope}} | {{#if this.description}}{{md_cell this.description}}{{else}}{{t "na"}}{{/if}} | {{len (doks_for_role ../doks this.role_id)}} |
{{/each}}

### {{t "s2_4"}}

{{t "s2_4_body"}}

| {{t "col_feature"}} |{{#each hub.roles.roles}} {{md_cell (translate this.name)}} |{{/each}}
| --- |{{#each hub.roles.roles}} :---: |{{/each}}
{{#each (role_matrix doks hub.roles.roles)}}| {{md_cell (translate this.dok.name)}} ({{md_code this.dok.dok_id}}) |{{#each this.cells}} {{#if this.step_count}}{{#if this.rule_count}}●{{else}}○{{/if}}{{else}}{{#if this.rule_count}}△{{else}}–{{/if}}{{/if}} |{{/each}}
{{/each}}

{{t "legend_title"}}: ● {{t "legend_both"}} · ○ {{t "legend_steps"}} · △ {{t "legend_rules"}} · – {{t "legend_none"}}
{{else}}
{{t "roles_none"}}
{{/if}}
{{/if}}
{{#if variables.include_catalog}}

## {{t "s3"}}

{{t "s3_body"}}{{#if variables.include_details}}. {{t "s3_detail_ref"}}{{/if}}

| {{t "col_group"}} | {{t "col_feature_id"}} | {{t "col_feature_name"}} | {{t "col_actors"}} | {{t "col_status"}} | {{t "col_priority"}} | {{t "col_steps"}} | {{t "col_rules"}} | {{t "col_acs"}} |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |
{{#with (help_categories hub.services doks ".md")}}{{#each this.categories}}{{#each this.articles}}| {{md_cell (translate ../label)}} | {{md_code this.dok.dok_id}} | {{md_cell (translate this.dok.name)}} | {{> role-list steps=this.dok.user_actions.steps}} | {{> status-label status=this.dok.status}} | {{#if this.dok.priority.impact}}{{> impact-label impact=this.dok.priority.impact}}{{#if this.dok.priority.blast_radius}} · {{> blast-label blast=this.dok.priority.blast_radius}}{{/if}}{{else}}{{t "na"}}{{/if}} | {{len (user_steps this.dok.user_actions.steps)}} | {{len this.dok.business_rules.rules}} | {{len this.dok.acceptance_criteria.criteria}} |
{{/each}}{{/each}}{{#each this.unplaced}}| {{t "group_other"}} | {{md_code this.dok.dok_id}} | {{md_cell (translate this.dok.name)}} | {{> role-list steps=this.dok.user_actions.steps}} | {{> status-label status=this.dok.status}} | {{#if this.dok.priority.impact}}{{> impact-label impact=this.dok.priority.impact}}{{#if this.dok.priority.blast_radius}} · {{> blast-label blast=this.dok.priority.blast_radius}}{{/if}}{{else}}{{t "na"}}{{/if}} | {{len (user_steps this.dok.user_actions.steps)}} | {{len this.dok.business_rules.rules}} | {{len this.dok.acceptance_criteria.criteria}} |
{{/each}}{{/with}}
{{/if}}
{{#if variables.include_details}}

## {{t "s4"}}

{{t "s4_body"}}

{{#each doks}}
### 4.{{add @index 1}} {{md_text (translate this.name)}} ({{md_code this.dok_id}})

| | |
| --- | --- |
| **{{t "d_id"}}** | {{md_code this.dok_id}} |
| **{{t "d_status"}}** | {{> status-label status=this.status}} |
| **{{t "d_services"}}** | {{#each this.surfaces}}{{#if @index}}, {{/if}}{{md_code this}}{{else}}{{t "na"}}{{/each}} |
| **{{t "d_priority"}}** | {{#if this.priority.impact}}{{> impact-label impact=this.priority.impact}}{{#if this.priority.blast_radius}} · {{> blast-label blast=this.priority.blast_radius}}{{/if}}{{else}}{{t "na"}}{{/if}} |
| **{{t "d_actors"}}** | {{#each (unique_actors this.user_actions.steps)}}{{#if @index}}, {{/if}}{{md_cell (actor_label this)}}{{else}}{{t "na"}}{{/each}} |
| **{{t "d_version"}}** | {{this._meta.version}} |
{{#if this._meta.origins.length}}| **{{t "d_route"}}** | {{#each this._meta.origins}}{{#if this.primary_route}}{{md_code this.primary_route}} {{/if}}{{/each}} |
{{/if}}| **{{t "d_related"}}** | {{> related-features-md dok=this services=../hub.services doks=../doks}} |

**{{t "d_desc"}}**

{{md_text (translate this.description)}}

{{#if this.user_actions.steps.length}}
**{{t "d_steps"}}**

| {{t "col_no"}} | {{t "col_actor"}} | {{t "col_action"}} | {{t "col_result"}} | {{t "col_pre"}} |
| ---: | --- | --- | --- | --- |
{{#each this.user_actions.steps}}| {{this.order}} | {{md_cell (actor_label this.actor)}} | {{md_cell (translate this.intent)}} | {{md_cell (translate this.outcome)}} | {{#if this.preconditions.length}}{{md_cell (join this.preconditions " · ")}}{{else}}{{t "na"}}{{/if}} |
{{/each}}
{{/if}}
{{#if this.business_rules.rules.length}}
**{{t "d_rules"}}**

| {{t "col_rule_id"}} | {{t "col_rule_type"}} | {{t "col_rule"}} | {{t "col_roles"}} |{{#if ../variables.show_repo_info}} {{t "col_evidence"}} |{{/if}}
| --- | --- | --- | --- |{{#if ../variables.show_repo_info}} --- |{{/if}}
{{#each this.business_rules.rules}}| {{md_code this.id}} | {{> rule-type-label type=this.type}} | {{md_cell (translate this.description)}} | {{#if this.applies_to_roles.length}}{{#each this.applies_to_roles}}{{#if @index}}, {{/if}}{{md_cell (role_label this)}}{{/each}}{{else}}{{t "roles_unspecified"}}{{/if}} |{{#if ../../variables.show_repo_info}} {{> code-anchor-md anchor=this.code_anchor}} |{{/if}}
{{/each}}
{{/if}}
{{#if this.acceptance_criteria.criteria.length}}
**{{t "d_acs"}}**

| {{t "col_ac_id"}} | {{t "col_ac"}} | {{t "col_related_rules"}} |
| --- | --- | --- |
{{#each this.acceptance_criteria.criteria}}| {{md_code this.id}} | {{md_cell (translate this.statement)}}{{#if this.given}} *{{t "ac_given"}}:* {{md_cell this.given}}{{/if}}{{#if this.when}} *{{t "ac_when"}}:* {{md_cell this.when}}{{/if}}{{#if this.then}} *{{t "ac_then"}}:* {{md_cell this.then}}{{/if}} | {{#each this.related_rules}}{{#if @index}}, {{/if}}{{md_code this}}{{else}}{{t "na"}}{{/each}} |
{{/each}}
{{/if}}
{{#if this._meta.history.length}}
**{{t "d_history"}}**

| {{t "col_version"}} | {{t "col_date"}} | {{t "col_change"}} | {{t "col_author"}} |
| ---: | --- | --- | --- |
{{#each this._meta.history}}| {{this.version}} | {{format_date this.date}} | {{md_cell this.change}} | {{#if this.author}}{{md_cell this.author}}{{else}}{{t "na"}}{{/if}} |
{{/each}}
{{/if}}
{{/each}}
{{#if (add (len (rules_by_type doks "restriction")) (len (rules_by_type doks "policy")))}}

## {{t "s5"}}

{{t "s5_body"}}

{{#if (len (rules_by_type doks "restriction"))}}
### {{t "s5_1"}}

{{> rule-digest-md doks=doks type="restriction" vars=variables}}
{{/if}}
{{#if (len (rules_by_type doks "policy"))}}
### {{t "s5_2"}}

{{> rule-digest-md doks=doks type="policy" vars=variables}}
{{/if}}
{{/if}}
{{/if}}
{{#if variables.include_appendix}}

## {{t "appendix_a"}}

{{t "appendix_a_body"}}

| {{t "col_feature_id"}} | {{t "col_feature_name"}} | {{t "col_rule_id"}} | {{t "col_ac_id"}} | {{t "col_ac"}} |{{#if variables.show_repo_info}} {{t "col_program"}} |{{/if}}
| --- | --- | --- | --- | --- |{{#if variables.show_repo_info}} --- |{{/if}}
{{#each (expand_acs doks)}}| {{md_code this.dok.dok_id}} | {{md_cell (translate this.dok.name)}} | {{#each this.rules}}{{#if @index}}, {{/if}}{{md_code this.id}}{{else}}{{t "na"}}{{/each}} | {{md_code this.criterion.id}} | {{md_cell (translate this.criterion.statement)}} |{{#if ../variables.show_repo_info}} {{#each this.anchors}}{{#if @index}}, {{/if}}{{md_code this}}{{else}}{{t "na"}}{{/each}} |{{/if}}
{{/each}}
{{#if hub.lexicon.terms.length}}

## {{t "appendix_b"}}

| {{t "col_term"}} | {{t "col_term_kind"}} | {{t "col_term_alt"}} | {{t "col_term_doks"}} |
| --- | --- | --- | --- |
{{#each hub.lexicon.terms}}| {{#if this.locales}}{{md_cell (default (lookup this.locales ../locale) (lookup this.locales ../primaryLocale))}}{{else}}{{#if this.snapshot}}{{md_cell (default (lookup this.snapshot ../locale) (lookup this.snapshot ../primaryLocale))}}{{else}}{{#if this.binding.key}}{{md_code this.binding.key}}{{else}}{{md_code this.term_id}}{{/if}}{{/if}}{{/if}} | {{#if (eq this.category "role")}}{{t "term_role"}}{{else}}{{t "term_concept"}}{{/if}} | {{#each this.locales}}{{#unless (eq @key ../../locale)}}{{@key}} {{md_cell this}} {{/unless}}{{/each}}{{#each this.snapshot}}{{#unless (eq @key ../../locale)}}{{@key}} {{md_cell this}} {{/unless}}{{/each}} | {{#each this.related_doks}}{{#if @index}}, {{/if}}{{md_code this}}{{else}}{{t "na"}}{{/each}} |
{{/each}}
{{/if}}
{{/if}}
