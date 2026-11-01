{{#with this as |root|}}
# {{t "doc_title"}} — {{md_text (translate workspace.name)}}

{{t "subtitle"}} · {{t "internal"}}

**{{t "meta_asof"}}** {{format_date generated_at}} · **{{t "meta_features"}}** {{len doks}}{{t "unit_features"}}

{{t "reading"}}

## {{t "toc_title"}}

{{#each doks}}
- {{md_text (translate this.name)}} ({{md_code this.dok_id}}){{#unless (has_blockers this)}} — {{t "toc_clean"}}{{/unless}}
{{/each}}

{{#each doks}}
## {{md_text (translate this.name)}} ({{md_code this.dok_id}})

{{md_text (translate this.description)}}

{{#if (add (add (len (unique_actors this.user_actions.steps)) (len this.surfaces)) (len this._meta.source_anchors))}}
{{#if (len (unique_actors this.user_actions.steps))}}
- **{{t "roles_label"}}:** {{#each (unique_actors this.user_actions.steps)}}{{#if @index}}, {{/if}}{{md_text (actor_label this)}}{{/each}}
{{/if}}
{{#if this.surfaces.length}}
- **{{t "surfaces_label"}}:** {{#each this.surfaces}}{{#if @index}}, {{/if}}{{md_text this}}{{/each}}
{{/if}}
{{#if this._meta.source_anchors.length}}
- **{{t "source_label"}}:** {{#each this._meta.source_anchors}}{{#if @index}}, {{/if}}{{md_code this.file}}{{/each}}
{{/if}}

{{/if}}
{{#if (has_blockers this)}}
| {{t "col_type"}} | {{t "col_condition"}} | {{t "col_roles"}} | {{t "col_ref"}} |
| --- | --- | --- | --- |
{{#with this as |dok|}}
{{#each dok.business_rules.rules}}
{{#if (eq this.type "permission")}}
{{> reason-row-md type_label=(t "type_permission") text=(translate this.description) roles=this.applies_to_roles any=(t "roles_any") ref=(md_code this.id) na=(t "na")}}
{{/if}}
{{/each}}
{{#each dok.user_actions.steps}}
{{#each this.preconditions}}
{{> reason-row-md type_label=(t "type_precondition") text=this ref=(concat (t "step_ref") " " ../order) na=(t "na")}}
{{/each}}
{{/each}}
{{#each dok.business_rules.rules}}
{{#if (eq this.type "validation")}}
{{> reason-row-md type_label=(t "type_validation") text=(translate this.description) ref=(md_code this.id) na=(t "na")}}
{{/if}}
{{/each}}
{{#each dok.business_rules.rules}}
{{#if (eq this.type "restriction")}}
{{> reason-row-md type_label=(t "type_restriction") text=(translate this.description) ref=(md_code this.id) na=(t "na")}}
{{/if}}
{{/each}}
{{#each dok.business_rules.rules}}
{{#if (eq this.type "policy")}}
{{> reason-row-md type_label=(t "type_policy") text=(translate this.description) ref=(md_code this.id) na=(t "na")}}
{{/if}}
{{/each}}
{{#each dok.business_rules.rules}}
{{#if (eq this.type "calculation")}}
{{> reason-row-md type_label=(t "type_calculation") text=(translate this.description) ref=(md_code this.id) na=(t "na")}}
{{/if}}
{{/each}}
{{/with}}
{{else}}
{{t "no_blockers"}}
{{/if}}

{{/each}}
## {{t "escalate_title"}}

{{#if variables.escalation_contact}}**{{t "escalate_to"}}:** {{md_text variables.escalation_contact}}

{{/if}}{{t "escalate_bring"}}
{{/with}}
