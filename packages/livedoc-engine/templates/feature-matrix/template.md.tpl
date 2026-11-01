{{#with this as |root|}}
# {{t "title"}} — {{md_text (translate workspace.name)}}

{{t "subtitle"}}

**{{t "meta_asof"}}** {{format_date generated_at}} · **{{t "meta_features"}}** {{len doks}}{{t "unit_features"}} · **{{t "meta_services"}}** {{len (surface_columns root.doks root.workspace.services)}}{{#if hub.roles.roles.length}} · **{{t "meta_roles"}}** {{len hub.roles.roles}}{{/if}}

{{t "note"}}

{{#with (surface_columns root.doks root.workspace.services) as |cols|}}
{{#with (help_categories root.hub.services root.doks ".md") as |ia|}}
{{#each ia.categories as |category|}}
### {{md_text (translate category.label)}}

| {{t "col_feature"}} |{{#each cols}} {{md_cell this.service_id}}{{#if this.type}} ({{> service-type-label type=this.type}}){{/if}} |{{/each}}{{#each root.hub.roles.roles}} {{md_cell (translate this.name)}} |{{/each}}
| --- |{{#each cols}} :---: |{{/each}}{{#each root.hub.roles.roles}} :---: |{{/each}}
{{#each category.articles as |article|}}| {{md_cell (translate article.dok.name)}} |{{#each cols as |col|}} {{#if (includes article.dok.surfaces col.service_id)}}●{{else}}–{{/if}} |{{/each}}{{#each root.hub.roles.roles as |role|}} {{#if (includes (step_roles article.dok.user_actions.steps) role.role_id)}}●{{else}}–{{/if}} |{{/each}}
{{/each}}

{{/each}}
{{#if ia.unplaced.length}}
{{#if ia.categories.length}}
### {{t "group_other"}}

{{/if}}
| {{t "col_feature"}} |{{#each cols}} {{md_cell this.service_id}}{{#if this.type}} ({{> service-type-label type=this.type}}){{/if}} |{{/each}}{{#each root.hub.roles.roles}} {{md_cell (translate this.name)}} |{{/each}}
| --- |{{#each cols}} :---: |{{/each}}{{#each root.hub.roles.roles}} :---: |{{/each}}
{{#each ia.unplaced as |article|}}| {{md_cell (translate article.dok.name)}} |{{#each cols as |col|}} {{#if (includes article.dok.surfaces col.service_id)}}●{{else}}–{{/if}} |{{/each}}{{#each root.hub.roles.roles as |role|}} {{#if (includes (step_roles article.dok.user_actions.steps) role.role_id)}}●{{else}}–{{/if}} |{{/each}}
{{/each}}

{{/if}}
{{/with}}
{{/with}}
{{t "legend_title"}}: ● {{t "legend_offered"}} · – {{t "legend_none"}}
{{/with}}
