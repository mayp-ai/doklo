# {{t "title"}}

{{t "intro"}}

{{#with (help_categories hub.services doks variables.link_extension variables.link_prefix)}}
{{#each this.categories}}
## {{translate this.label}}

_{{t "count_before"}}{{this.count}}{{#if (eq this.count 1)}}{{t "count_after_one"}}{{else}}{{t "count_after_many"}}{{/if}}_

{{#each this.articles}}
- [{{translate this.dok.name}}]({{this.href}})
{{/each}}

{{/each}}
{{#if this.unplaced.length}}
## {{t "section_other"}}

{{#each this.unplaced}}
- [{{translate this.dok.name}}]({{this.href}})
{{/each}}

{{/if}}
{{#unless this.categories.length}}{{#unless this.unplaced.length}}
{{t "empty"}}

{{/unless}}{{/unless}}
{{/with}}
---

{{#if variables.support_url}}{{t "support_question"}} [{{t "support"}}]({{variables.support_url}})

{{/if}}{{t "colophon"}}
