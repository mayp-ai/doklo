# {{t "title"}}{{#if variables.release_label}} — {{variables.release_label}}{{/if}}

{{#if changes.baseline_found}}
{{t "intro"}}

{{#unless changes.has_customer_changes}}
{{t "no_changes"}}

{{/unless}}
{{#if changes.has_customer_changes}}
**{{t "glance_title"}}**

{{#if changes.added.length}}- **{{t "glance_added"}} {{len changes.added}}** — {{#each changes.added}}{{#if @index}} · {{/if}}{{translate this.name}}{{/each}}
{{/if}}{{#if changes.changed.length}}- **{{t "glance_changed"}} {{len changes.changed}}** — {{#each changes.changed}}{{#if @index}} · {{/if}}{{translate this.name}}{{/each}}
{{/if}}{{#if changes.removed.length}}- **{{t "glance_removed"}} {{len changes.removed}}** — {{#each changes.removed}}{{#if @index}} · {{/if}}{{this.name}}{{/each}}
{{/if}}

{{/if}}
{{#if changes.added.length}}
## {{t "section_added"}}

{{#each changes.added}}
{{#if (lt @index 2)}}
### {{translate this.name}}

{{audience_text (translate this.description)}}

{{#if ../variables.help_base_url}}[{{t "learn_more"}}]({{../variables.help_base_url}}/{{this.dok_id}}.html)

{{/if}}{{/if}}
{{/each}}
{{#each changes.added}}
{{#if (gte @index 2)}}
- **{{translate this.name}}** — {{audience_text (translate this.description)}}
{{/if}}
{{/each}}

{{/if}}
{{#if changes.changed.length}}
## {{t "section_changed"}}

{{#each changes.changed}}
- **{{translate this.name}}** — {{#if (lookup ../changes.notes_text this.dok_id)}}{{lookup ../changes.notes_text this.dok_id}}{{else}}{{t "changed_item_suffix"}}{{/if}}
{{/each}}

{{/if}}
{{#if changes.removed.length}}
## {{t "section_removed"}}

{{#each changes.removed}}
- **{{this.name}}** {{t "removed_item_suffix"}}
{{/each}}

{{/if}}
{{else}}
{{t "first_edition_intro"}}

{{#each doks}}
### {{translate this.name}}

{{audience_text (translate this.description)}}

{{#if ../variables.help_base_url}}[{{t "learn_more"}}]({{../variables.help_base_url}}/{{this.dok_id}}.html)

{{/if}}{{/each}}
{{/if}}
---

{{#if variables.support_url}}{{t "support_question"}} [{{t "support"}}]({{variables.support_url}})

{{/if}}{{t "colophon"}}
