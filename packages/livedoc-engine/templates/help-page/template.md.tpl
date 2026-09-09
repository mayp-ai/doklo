# {{help.title}}

{{#if variables.index_url}}[{{#if help.workspace_name}}{{help.workspace_name}} · {{/if}}{{t "eyebrow_suffix"}}]({{variables.index_url}}){{else}}{{#if help.workspace_name}}**{{help.workspace_name}} · {{t "eyebrow_suffix"}}**{{else}}**{{t "eyebrow_suffix"}}**{{/if}}{{/if}}

{{#if help.description}}
{{help.description}}

{{/if}}
{{#if help.steps.length}}
## {{t "section_how"}}

{{#each help.steps}}
{{#if (eq this.actor.kind "system")}}
### {{t "auto_step_label"}}

{{#if this.preconditions.length}}
- **{{t "auto_condition_label"}}:** {{join this.preconditions " · "}}
{{/if}}
{{#if this.outcome}}
{{this.outcome}}
{{/if}}

{{else}}
### {{this.display_number}}. {{this.actor_label}} — {{this.intent}}

{{#if this.preconditions.length}}
- **{{t "step_pre_label"}}:** {{join this.preconditions " · "}}
{{/if}}
{{#if this.outcome}}
- **{{t "step_result_label"}}:** {{this.outcome}}
{{/if}}

{{#unless ../variables.hide_screenshots}}
{{#if ../platforms.length}}
{{#each ../platforms}}
{{#if (lookup (lookup ../../step_screenshots_by_platform this) ../source_index)}}
![{{../intent}} — {{t (concat "platform_" this)}}]({{lookup (lookup ../../step_screenshots_by_platform this) ../source_index}})
*{{t (concat "platform_" this)}} — {{../intent}}*
{{/if}}
{{/each}}
{{else}}
{{#if (lookup ../step_screenshots this.source_index)}}
![{{this.intent}}]({{lookup ../step_screenshots this.source_index}})
{{/if}}
{{/if}}
{{/unless}}

{{/if}}
{{/each}}
{{/if}}
{{#if help.rules.length}}
## {{t "section_tips"}}

{{#each help.rules}}
- **{{> rule-type-label rule=this}}:** {{this.description}}
{{/each}}

{{/if}}
{{#if help.criteria.length}}
## {{t "section_done"}}

{{#each help.criteria}}
- [ ] {{this.statement}}
{{#if this.related_rules.length}}
  - **{{t "check_related_rule"}}:** {{#each (rules_for this.related_rules ../help.rules)}}{{> rule-type-label rule=this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{/each}}

{{/if}}
{{#if variables.support_url}}
### {{t "feedback_title"}}

{{t "feedback_body"}}

[{{t "feedback_cta"}} →]({{variables.support_url}})

{{/if}}
