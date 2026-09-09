# {{t "title"}}{{#if variables.release_label}} — {{variables.release_label}}{{/if}}

{{#if changes.baseline_found}}
{{t "intro"}}

{{#unless changes.has_customer_changes}}
{{t "no_changes"}}
{{/unless}}
{{#if changes.added.length}}
## {{t "section_added"}}

{{#each changes.added}}
### {{translate this.name}}

{{translate this.description}}

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
- **{{this.name}}**
{{/each}}
{{/if}}
{{else}}
{{t "first_edition_intro"}}

{{#each doks}}
### {{translate this.name}}

{{translate this.description}}

{{/each}}
{{/if}}

{{#if variables.support_url}}
---

[{{t "support"}}]({{variables.support_url}})
{{/if}}
