# {{t "title"}}

{{t "intro"}}

{{t "intro2"}}
{{#if changelog.total}}
{{#each changelog.groups}}

## [{{this.date}}]
{{#if this.added.length}}

### {{t "added"}}

{{#each this.added}}
- **{{translate this.name}}**
{{/each}}
{{/if}}
{{#if this.changed.length}}

### {{t "changed"}}

{{#each this.changed}}
- **{{translate this.name}}** — {{#if this.restored}}{{t "restored"}}{{else}}{{this.entry.change}}{{/if}}
{{/each}}
{{/if}}
{{#if this.deprecated.length}}

### {{t "deprecated"}}

{{#each this.deprecated}}
- **{{translate this.name}}**
{{/each}}
{{/if}}
{{#if this.removed.length}}

### {{t "removed"}}

{{#each this.removed}}
- **{{translate this.name}}**
{{/each}}
{{/if}}
{{#if this.fixed.length}}

### {{t "fixed"}}

{{#each this.fixed}}
- **{{translate this.name}}** — {{this.entry.change}}
{{/each}}
{{/if}}
{{#if this.security.length}}

### {{t "security"}}

{{#each this.security}}
- **{{translate this.name}}** — {{this.entry.change}}
{{/each}}
{{/if}}
{{/each}}
{{else}}

{{t "empty"}}
{{/if}}
