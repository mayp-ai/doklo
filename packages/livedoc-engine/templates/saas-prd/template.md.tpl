**{{md_text dok.status}} · {{md_code dok.dok_id}} · v{{dok._meta.version}}**

# {{md_text (translate dok.name)}}

{{#if dok.tags.length}}
{{#each dok.tags}}\#{{md_text this}}{{#unless @last}} · {{/unless}}{{/each}}

{{/if}}
| {{t "stat_steps"}} | {{t "stat_rules"}} | {{t "stat_acs"}} | {{t "stat_surfaces"}} |
| ---: | ---: | ---: | ---: |
| {{len dok.user_actions.steps}} | {{len dok.business_rules.rules}} | {{len dok.acceptance_criteria.criteria}} | {{len dok.surfaces}} |

## {{t "section_background"}}

{{md_text (translate dok.description)}}

{{#if dok.user_actions.steps.length}}
## {{t "section_goal"}}

**{{t "goal_inferred_label"}}:** {{md_text (translate (lookup (lookup dok.user_actions.steps (sub (len dok.user_actions.steps) 1)) "outcome"))}}

## {{t "section_scenario"}}

{{#each dok.user_actions.steps}}
{{add @index 1}}. **{{md_text (actor_label this.actor)}} — {{md_text (translate this.intent)}}**
   - **{{t "step_outcome"}}:** {{md_text (translate this.outcome)}}
{{/each}}

{{/if}}
{{#if dok.business_rules.rules.length}}
## {{t "section_fr"}}

{{#each dok.business_rules.rules}}
- **{{md_code this.id}} · {{md_text this.type}}:** {{md_text (translate this.description)}}
{{/each}}

{{/if}}
{{#if dok.acceptance_criteria.criteria.length}}
## {{t "ac_label"}}

{{#each dok.acceptance_criteria.criteria}}
- [ ] **{{md_code this.id}}** — {{md_text (translate this.statement)}}
{{#if this.related_rules.length}}
  - **{{t "rule_label"}}:** {{#each this.related_rules}}{{md_code this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{/each}}

{{/if}}
{{#if dok.surfaces.length}}
## {{t "stat_surfaces"}}

{{#each dok.surfaces}}
- {{md_text this}}
{{/each}}

{{/if}}
---

_{{t "footer_note"}}_
