{{md_text (translate workspace.name)}}

# {{t "doc_title"}}

{{t "doc_kind"}}

| | |
| --- | --- |
| **{{t "cover_system"}}** | {{md_cell (translate workspace.name)}} |
| **{{t "cover_asof"}}** | {{format_date generated_at}} |
{{#if variables.reference_no}}| **{{t "cover_ref"}}** | {{md_cell variables.reference_no}} |
{{/if}}{{#if variables.classification}}| **{{t "cover_classification"}}** | {{md_cell variables.classification}} |
{{/if}}{{#if variables.prepared_for}}| **{{t "cover_prepared_for"}}** | {{md_cell variables.prepared_for}} |
{{/if}}{{#if variables.prepared_by}}| **{{t "cover_prepared_by"}}** | {{md_cell variables.prepared_by}} |
{{/if}}| **{{t "cover_scope"}}** | {{t "cover_scope_pre"}}{{len doks}}{{t "cover_scope_mid"}}{{len (expand_rules doks)}}{{t "cover_scope_post"}} |
| **{{t "cover_basis"}}** | {{t "cover_basis_value"}} |

**{{t "signoff_title"}}**

| {{t "signoff_role"}} | {{t "signoff_name"}} | {{t "signoff_date"}} | {{t "signoff_sign"}} |
| --- | --- | --- | --- |
| {{t "signoff_author"}} | | | |
| {{t "signoff_reviewer"}} | | | |
| {{t "signoff_approver"}} | | | |

**{{t "history_title"}}**

| {{t "col_version"}} | {{t "col_date"}} | {{t "col_change"}} | {{t "col_author"}} |
| --- | --- | --- | --- |
| {{md_cell (default variables.document_version "1.0")}} | {{format_date generated_at}} | {{t "history_change_pre"}}{{format_date generated_at}}{{t "history_change_post"}} | {{#if variables.prepared_by}}{{md_cell variables.prepared_by}}{{else}}{{t "na"}}{{/if}} |

## {{t "s1"}}

### {{t "s1_1"}}

{{t "s1_1_body"}}

### {{t "s1_2"}}

{{t "s1_2_body"}}

| {{t "scope_total"}} | {{t "scope_active"}} | {{t "scope_pending"}} | {{t "scope_rules"}} |
| ---: | ---: | ---: | ---: |
| {{len doks}} | {{len (where_status doks "active")}} | {{add (len (where_status doks "draft")) (len (where_status doks "review"))}} | {{len (expand_rules doks)}} |

### {{t "s1_3"}}

{{t "s1_3_body_1"}}

{{t "s1_3_body_2"}}

- **{{t "type_permission"}}** — {{t "def_permission"}}
- **{{t "type_restriction"}}** — {{t "def_restriction"}}
- **{{t "type_policy"}}** — {{t "def_policy"}}
- **{{t "type_validation"}}** — {{t "def_validation"}}
- **{{t "type_calculation"}}** — {{t "def_calculation"}}

### {{t "s1_4"}}

1. {{t "s1_4_body_1"}}
2. {{t "s1_4_body_2"}}
3. {{t "s1_4_body_3"}}

## {{t "s2"}}

{{t "concl_1"}}**{{len doks}}**{{t "concl_2"}}**{{len (expand_rules doks)}}**{{t "concl_3"}}**{{len (rules_by_type doks "permission")}}**{{t "concl_4"}}**{{len (rules_by_type doks "restriction")}}**{{t "concl_5"}}

### {{t "s2_1"}}

| {{t "col_type"}} | {{t "col_definition"}} | {{t "col_count"}} | {{t "col_section"}} |
| --- | --- | ---: | --- |
| {{t "type_permission"}} | {{t "def_permission"}} | {{len (rules_by_type doks "permission")}} | 4 |
| {{t "type_restriction"}} | {{t "def_restriction"}} | {{len (rules_by_type doks "restriction")}} | 5 |
| {{t "type_policy"}} | {{t "def_policy"}} | {{len (rules_by_type doks "policy")}} | 6.1 |
| {{t "type_validation"}} | {{t "def_validation"}} | {{len (rules_by_type doks "validation")}} | 6.2 |
| {{t "type_calculation"}} | {{t "def_calculation"}} | {{len (rules_by_type doks "calculation")}} | 6.3 |
| **{{t "scope_rules"}}** | | **{{len (expand_rules doks)}}** | |

### {{t "s2_2"}}

{{#unless (len (rules_by_type doks "permission"))~}}
- {{t "obs_none_perm"}}
{{/unless~}}
{{#if (len (rules_by_type doks "permission"))}}{{#if (len (doks_without_rule_type doks "permission"))~}}
- {{t "obs_no_perm_pre"}}{{len (doks_without_rule_type doks "permission")}}{{t "obs_no_perm_post"}}
{{/if}}{{/if~}}
{{#if (add (add (len (where_status doks "draft")) (len (where_status doks "review"))) (len (where_status doks "planned")))}}
- {{t "obs_pending_pre"}}{{add (len (where_status doks "draft")) (len (where_status doks "review"))}}{{t "obs_pending_post"}}
{{else}}
- {{t "obs_all_reviewed"}}
{{/if}}
{{#if hub.roles.roles.length}}
- {{t "obs_roles_pre"}}{{len hub.roles.roles}}{{t "obs_roles_post"}}
{{else}}
- {{t "obs_no_roles"}}
{{/if}}

## {{t "s3"}}

### {{t "s3_1"}}

{{#if hub.roles.roles.length}}
| {{t "col_role_id"}} | {{t "col_role_name"}} | {{t "col_role_kind"}} | {{t "col_role_scope"}} | {{t "col_role_desc"}} |
| --- | --- | --- | --- | --- |
{{#each hub.roles.roles}}| {{md_code this.role_id}} | {{md_cell (translate this.name)}} | {{> role-kind-label kind=this.kind}} | {{> role-scope-label scope=this.scope}} | {{#if this.description}}{{md_cell this.description}}{{else}}{{t "na"}}{{/if}} |
{{/each}}

### {{t "s3_2"}}

{{t "s3_2_body"}}

| {{t "matrix_feature"}} |{{#each hub.roles.roles}} {{md_cell (translate this.name)}} |{{/each}}
| --- |{{#each hub.roles.roles}} :---: |{{/each}}
{{#each (role_matrix doks hub.roles.roles)}}| {{md_cell (translate this.dok.name)}} ({{md_code this.dok.dok_id}}) |{{#each this.cells}} {{#if this.step_count}}{{#if this.rule_count}}●{{else}}○{{/if}}{{else}}{{#if this.rule_count}}△{{else}}–{{/if}}{{/if}} |{{/each}}
{{/each}}

{{t "legend_title"}}: ● {{t "legend_both"}} · ○ {{t "legend_steps"}} · △ {{t "legend_rules"}} · – {{t "legend_none"}}
{{else}}
{{t "obs_no_roles"}}
{{/if}}

## {{t "s4"}}

{{t "s4_lead"}}

{{> rule-table-md doks=doks type="permission"}}

## {{t "s5"}}

{{t "s5_lead"}}

{{> rule-table-md doks=doks type="restriction"}}

## {{t "s6"}}

{{t "s6_lead"}}

### {{t "s6_1"}}

{{> rule-table-md doks=doks type="policy"}}

### {{t "s6_2"}}

{{> rule-table-md doks=doks type="validation"}}

### {{t "s6_3"}}

{{> rule-table-md doks=doks type="calculation"}}

## {{t "s7"}}

{{t "s7_lead"}}

### {{t "s7_1"}}

{{#if (len (doks_without_rule_type doks "permission"))}}
{{t "s7_1_body"}}

| {{t "col_no"}} | {{t "col_feature"}} | {{t "col_other_rules"}} |
| ---: | --- | --- |
{{#each (doks_without_rule_type doks "permission")}}| {{add @index 1}} | {{md_cell (translate this.name)}} ({{md_code this.dok_id}}) | {{#if this.business_rules.rules.length}}{{#each (rule_types this.business_rules.rules)}}{{#if @index}}, {{/if}}{{> rule-type-label type=this}}{{/each}}{{else}}{{t "na"}}{{/if}} |
{{/each}}
{{else}}
{{t "s7_1_none"}}
{{/if}}

### {{t "s7_2"}}

{{#if (add (add (len (where_status doks "draft")) (len (where_status doks "review"))) (len (where_status doks "planned")))}}
{{t "s7_2_body"}}

| {{t "col_feature"}} | {{t "col_status"}} | {{t "col_other_rules"}} |
| --- | --- | ---: |
{{#each (where_status doks "draft")}}| {{md_cell (translate this.name)}} ({{md_code this.dok_id}}) | {{t "status_draft"}} | {{len this.business_rules.rules}} |
{{/each}}{{#each (where_status doks "review")}}| {{md_cell (translate this.name)}} ({{md_code this.dok_id}}) | {{t "status_review"}} | {{len this.business_rules.rules}} |
{{/each}}{{#each (where_status doks "planned")}}| {{md_cell (translate this.name)}} ({{md_code this.dok_id}}) | {{t "status_planned"}} | {{len this.business_rules.rules}} |
{{/each}}
{{else}}
{{t "s7_2_none"}}
{{/if}}

### {{t "s7_3"}}

{{t "s7_3_body"}}

| {{t "col_id"}} | {{t "col_feature"}} | {{t "col_rule"}} |
| --- | --- | --- |
{{#each (expand_rules doks)}}{{#unless this.rule.applies_to_roles.length}}| {{md_code this.rule.id}} | {{md_cell (translate this.dok.name)}} ({{md_code this.dok.dok_id}}) | {{md_cell (translate this.rule.description)}} |
{{/unless}}{{/each}}

## {{t "appendix_a"}}

| {{t "col_no"}} | {{t "col_feature_id"}} | {{t "col_feature"}} | {{t "col_status"}} | {{t "col_impact"}} | {{t "col_blast"}} | {{t "col_rule_count"}} | {{t "col_ac_count"}} | {{t "col_file_count"}} |
| ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: |
{{#each doks}}| {{add @index 1}} | {{md_code this.dok_id}} | {{md_cell (translate this.name)}} | {{> status-label status=this.status}} | {{> impact-label impact=this.priority.impact}} | {{> blast-label blast=this.priority.blast_radius}} | {{len this.business_rules.rules}} | {{len this.acceptance_criteria.criteria}} | {{len this._meta.source_anchors}} |
{{/each}}

## {{t "appendix_b"}}

- **{{t "term_dok"}}** — {{t "term_dok_def"}}
- **{{t "term_status"}}** — {{t "term_status_def"}}
- **{{t "term_rule_id"}}** — {{t "term_rule_id_def"}}
- **{{t "term_anchor"}}** — {{t "term_anchor_def"}}

## {{t "appendix_c"}}

| | |
| --- | --- |
| {{t "gen_template"}} | {{t "gen_template_value"}} |
| {{t "gen_asof"}} | {{format_date generated_at}} |
| {{t "gen_features"}} | {{len doks}} |
| {{t "gen_rules"}} | {{len (expand_rules doks)}} |

_{{t "disclaimer"}}_
