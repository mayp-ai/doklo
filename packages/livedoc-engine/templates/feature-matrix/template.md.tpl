# {{t "title"}} — {{md_text (translate workspace.name)}}

{{t "subtitle"}}

{{t "stat_features"}} {{len doks}} · {{t "stat_domains"}} {{len (group_doks_by_primary_tag doks)}} · {{t "stat_services"}} {{len workspace.services}}

{{#each (group_doks_by_primary_tag doks)}}
## {{md_text this.tag}} ({{len this.doks}}{{t "domain_count_suffix"}})

| {{t "col_feature"}} | {{t "col_status"}} | {{t "col_surfaces"}} | {{t "col_depth"}} |
| --- | --- | --- | ---: |
{{#each this.doks}}
| {{md_cell (translate this.name)}} | {{md_cell this.status}} | {{#each this.surfaces}}{{md_cell this}}{{#unless @last}}, {{/unless}}{{else}}—{{/each}} | {{#if this.user_actions.steps.length}}{{len this.user_actions.steps}}{{else}}0{{/if}} · {{#if this.business_rules.rules.length}}{{len this.business_rules.rules}}{{else}}0{{/if}} · {{#if this.acceptance_criteria.criteria.length}}{{len this.acceptance_criteria.criteria}}{{else}}0{{/if}} |
{{/each}}

{{/each}}
