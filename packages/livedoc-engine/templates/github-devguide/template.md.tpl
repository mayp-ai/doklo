# {{translate dok.name}}

## {{t "quick_reference"}}

| {{t "field_id"}} | {{dok.dok_id}} |
| --- | --- |
| {{t "field_status"}} | `{{dok.status}}` |
| {{t "field_version"}} | v{{dok._meta.version}} |
| {{t "field_tags"}} | {{#if dok.tags.length}}{{join dok.tags ", "}}{{else}}{{t "no_value"}}{{/if}} |
| {{t "field_surfaces"}} | {{#if dok.surfaces.length}}{{join dok.surfaces ", "}}{{else}}{{t "no_value"}}{{/if}} |

## {{t "section_change_impact"}}

{{t "change_impact_placeholder"}}

## {{t "section_intent"}}

{{translate dok.description}}

## {{t "section_actors"}}

{{#if dok.user_actions.steps.length}}
{{#each (unique_actors dok.user_actions.steps)}}
{{#unless (eq this.kind "system")}}
- {{actor_label this}}
{{/unless}}
{{/each}}
{{else}}
{{t "no_value"}}
{{/if}}

## {{t "section_flow"}}

{{#if dok.user_actions.steps.length}}
{{#each dok.user_actions.steps}}
{{add @index 1}}. **{{actor_label this.actor}}** — {{translate this.intent}}
   {{translate this.outcome}}
{{#if this.variants.length}}
{{#each this.variants}}
{{#if this.code_anchor}}
   _{{this.code_anchor.file}}{{#if this.code_anchor.function}}::{{this.code_anchor.function}}{{/if}}_
{{/if}}
{{/each}}
{{/if}}
{{/each}}
{{else}}
{{t "no_value"}}
{{/if}}

## {{t "section_rules"}}

{{#if dok.business_rules.rules.length}}
{{#each dok.business_rules.rules}}
- **{{this.id}}** (_{{this.type}}_) — {{translate this.description}}
{{/each}}
{{else}}
{{t "no_value"}}
{{/if}}

## {{t "section_acceptance"}}

{{#if dok.acceptance_criteria.criteria.length}}
{{#each dok.acceptance_criteria.criteria}}
- **{{this.id}}** — {{translate this.statement}}
{{/each}}
{{else}}
{{t "no_value"}}
{{/if}}
