{{~#each services~}}{{~#each this.ia.edges~}}
{{~#if (eq this.from ../../dok.dok_id)}}· {{> edge-type-label type=this.type}} → {{#each ../../doks}}{{#if (eq this.dok_id ../to)}}{{md_cell (translate this.name)}} ({{md_code this.dok_id}}){{/if}}{{/each}} {{/if~}}
{{~#if (eq this.to ../../dok.dok_id)}}· {{> edge-type-label type=this.type}} ← {{#each ../../doks}}{{#if (eq this.dok_id ../from)}}{{md_cell (translate this.name)}} ({{md_code this.dok_id}}){{/if}}{{/each}} {{/if~}}
{{~/each~}}{{~/each~}}