**{{t "console_tag"}}**

# {{t "doc_title"}}

{{md_text (translate workspace.name)}} · {{t "subtitle"}}

**{{t "updated"}}:** {{format_date workspace.updated_at}} · {{t "scope_workspace"}}

| {{t "kpi_features"}} | {{t "kpi_permission"}} | {{t "kpi_validation"}} | {{t "kpi_restriction"}} | {{t "kpi_policy"}} |
| ---: | ---: | ---: | ---: | ---: |
| {{len doks}} | {{len (rules_by_type doks "permission")}} | {{len (rules_by_type doks "validation")}} | {{len (rules_by_type doks "restriction")}} | {{len (rules_by_type doks "policy")}} |

> **{{t "agent_note_title"}}**
>
> {{t "agent_note_body"}}

{{#each doks}}
## {{md_text (translate this.name)}} · {{md_code this.dok_id}}

{{md_text (translate this.description)}}

{{#if (len (unique_actors this.user_actions.steps))}}
- **{{t "card_roles_label"}}:** {{#each (unique_actors this.user_actions.steps)}}{{md_text (actor_label this)}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{#if this.surfaces.length}}
- **{{t "card_surface_label"}}:** {{#each this.surfaces}}{{md_text this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}

### {{t "card_when"}}

{{#each this.business_rules.rules}}
{{#if (eq this.type "permission")}}
{{#if this.applies_to_roles.length}}
- **{{t "label_permission"}} — {{t "check_permission"}}:** {{md_text (translate this.description)}} ({{#each this.applies_to_roles}}{{md_text (role_label this)}}{{#unless @last}}, {{/unless}}{{/each}}) — {{md_code this.id}}
{{else}}
- **{{t "label_permission"}} — {{t "perm_anyone"}}:** {{md_text (translate this.description)}} — {{md_code this.id}}
{{/if}}
{{/if}}
{{/each}}
{{#each this.user_actions.steps}}
{{#each this.preconditions}}
- **{{t "label_precondition"}} — {{t "check_precondition"}}:** {{md_text this}} — {{t "precond_in"}} {{../order}} · {{md_text (translate ../intent)}}
{{/each}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "validation")}}
- **{{t "label_validation"}} — {{t "check_validation"}}:** {{md_text (translate this.description)}} — {{md_code this.id}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "restriction")}}
- **{{t "label_restriction"}} — {{t "check_restriction"}}:** {{md_text (translate this.description)}} — {{md_code this.id}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "policy")}}
- **{{t "label_policy"}} — {{t "check_policy"}}:** {{md_text (translate this.description)}} — {{md_code this.id}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "calculation")}}
- **{{t "label_calculation"}}:** {{md_text (translate this.description)}} — {{md_code this.id}}
{{/if}}
{{/each}}

{{#unless (has_blockers this)}}
**{{t "card_no_blockers"}}.** {{t "card_no_blockers_hint"}}
{{/unless}}

{{#if this._meta.source_anchors.length}}
**{{t "source_label"}}:** {{#each this._meta.source_anchors}}{{md_code this.file}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}

{{/each}}
---

_{{t "footer_live"}}_
