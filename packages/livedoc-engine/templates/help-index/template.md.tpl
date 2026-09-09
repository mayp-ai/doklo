# {{t "title"}}

{{t "intro"}}

{{#with (ia_index hub.services doks variables.link_extension variables.link_prefix)}}
{{#each this.sections}}
{{#if (gt (len ../this.sections) 1)}}
## {{service_label this.service_id}}
{{/if}}
{{#each this.nodes}}
{{> index-node}}
{{/each}}
{{/each}}
{{#if this.unplaced.length}}
## {{t "section_other"}}

{{#each this.unplaced}}
- [{{translate this.dok.name}}]({{this.href}})
{{/each}}
{{/if}}
{{/with}}
