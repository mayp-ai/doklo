{{#if this.doks.length}}
### {{translate this.label}}

{{#each this.doks}}
- [{{translate this.dok.name}}]({{this.href}})
{{/each}}

{{/if}}
{{#each this.children}}
{{> index-node}}
{{/each}}
