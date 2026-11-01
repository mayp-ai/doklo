{{#with this as |root|}}
# {{md_text (translate workspace.name)}} — {{t "title_suffix"}}

{{t "intro"}}

**{{t "meta_asof"}}** {{format_date generated_at}} · **{{t "meta_features"}}** {{len doks}} · **{{t "meta_services"}}** {{len workspace.services}}

{{t "s1"}}

{{#if hub.roles.roles.length}}
{{t "s1_roles"}}

| {{t "col_role"}} | {{t "col_role_kind"}} | {{t "col_role_scope"}} |
| --- | --- | --- |
{{#each hub.roles.roles}}| {{md_cell (translate this.name)}} ({{md_code this.role_id}}) | {{#if (eq this.kind "actor_type")}}{{t "kind_actor_type"}}{{else}}{{t "kind_access"}}{{/if}} | {{#if (eq this.scope "tenant")}}{{t "scope_tenant"}}{{else}}{{#if (eq this.scope "resource")}}{{t "scope_resource"}}{{else}}{{t "scope_global"}}{{/if}}{{/if}} |
{{/each}}

{{/if}}
{{#if (len (external_parties doks))}}
{{t "s1_external"}}

{{t "external_lead"}}

| {{t "col_external"}} | {{t "col_feature"}} | {{t "col_step"}} |
| --- | --- | --- |
{{#each (external_parties doks)}}| {{md_cell this.label}} | {{md_cell (translate this.dok.name)}} ({{md_code this.dok.dok_id}}) | {{this.step.order}}. {{md_cell (translate this.step.intent)}} |
{{/each}}

{{/if}}
{{t "s1_diagram"}}

```mermaid
graph LR
{{#each hub.roles.roles}}
  r{{@index}}["{{translate this.name}}"]
  r{{@index}} --> sys
{{/each}}
  sys["{{translate workspace.name}}"]
{{#each workspace.services}}
  s{{@index}}["{{this.service_id}}{{#if this.framework}} ({{this.framework}}){{/if}}"]
  sys --- s{{@index}}
{{/each}}
```

{{t "s2"}}

| {{t "col_service"}} | {{t "col_type"}} | {{t "col_framework"}} | {{t "col_root"}} |
| --- | --- | --- | --- |
{{#each workspace.services}}| {{md_code this.service_id}} | {{md_cell this.type}} | {{#if this.framework}}{{md_cell this.framework}}{{else}}{{t "na"}}{{/if}} | {{#if this.code_root}}{{md_code this.code_root}}{{else}}{{t "na"}}{{/if}} |
{{/each}}

{{t "s3"}}

{{#with (ia_index root.hub.services root.doks ".md") as |ia|}}
{{#if ia.sections.length}}
{{t "map_lead"}}

{{#each ia.sections}}
**{{md_code this.service_id}}**

| {{t "col_menu"}} | {{t "col_feature"}} |
| --- | --- |
{{> ia-rows-md nodes=this.nodes depth=0}}

{{/each}}
{{#if ia.unplaced.length}}
**{{t "map_unplaced"}}**: {{#each ia.unplaced}}{{#if @index}}, {{/if}}{{md_text (translate this.dok.name)}} ({{md_code this.dok.dok_id}}){{/each}}

{{/if}}
{{else}}
{{t "map_none_lead"}}

| {{t "col_service"}} | {{t "col_feature"}} |
| --- | --- |
{{#each root.doks}}| {{#each this.surfaces}}{{#if @index}}, {{/if}}{{md_code this}}{{else}}{{t "na"}}{{/each}} | {{md_cell (translate this.name)}} ({{md_code this.dok_id}}) |
{{/each}}

{{/if}}
{{/with}}
{{#if (add (len (rules_by_type doks "restriction")) (len (rules_by_type doks "policy")))}}
{{t "s4"}}

{{t "rules_lead"}}

| {{t "col_rule_id"}} | {{t "col_feature"}} | {{t "col_rule_type"}} | {{t "col_rule"}} |
| --- | --- | --- | --- |
{{#each (rules_by_type doks "restriction")}}| {{md_code this.rule.id}} | {{md_cell (translate this.dok_name)}} | {{t "type_restriction"}} | {{md_cell (translate this.rule.description)}} |
{{/each}}{{#each (rules_by_type doks "policy")}}| {{md_code this.rule.id}} | {{md_cell (translate this.dok_name)}} | {{t "type_policy"}} | {{md_cell (translate this.rule.description)}} |
{{/each}}

{{/if}}
{{#if (len (invert_anchors doks))}}
{{t "s5"}}

{{t "code_lead"}}

| {{t "col_feature"}} | {{t "col_files"}} |
| --- | --- |
{{#each doks}}{{#if this._meta.source_anchors.length}}| {{md_cell (translate this.name)}} ({{md_code this.dok_id}}) | {{#each this._meta.source_anchors}}{{#if @index}}, {{/if}}{{md_code this.file}}{{/each}} |
{{/if}}{{/each}}

{{/if}}
{{#if hub.lexicon.terms.length}}
{{t "s6"}}

| {{t "col_term"}} | {{t "col_term_feats"}} |
| --- | --- |
{{#each hub.lexicon.terms}}{{#if (len this.locales)}}| {{md_cell (default (lookup this.locales root.locale) (lookup this.locales root.primaryLocale))}} | {{#each this.related_doks}}{{#if @index}}, {{/if}}{{md_code this}}{{else}}{{t "na"}}{{/each}} |
{{/if}}{{/each}}
{{/if}}
{{/with}}
