{{#with this as |root|}}
# {{t "title"}} — {{md_text (translate workspace.name)}}

{{t "intro"}}

**{{t "meta_asof"}}** {{format_date generated_at}} · **{{t "meta_features"}}** {{len doks}}{{t "unit_features"}} · **{{t "meta_services"}}** {{len workspace.services}}

{{t "s_services"}}

| {{t "col_service"}} | {{t "col_service_type"}} | {{t "col_desc"}} |
| --- | --- | --- |
{{#each workspace.services}}| {{md_cell this.service_id}} | {{> service-type-label type=this.type}} | {{#if this.description}}{{md_cell this.description}}{{else}}{{t "na"}}{{/if}} |
{{/each}}

{{t "s_map"}}

{{#with (ia_index root.hub.services root.doks ".md") as |ia|}}
{{#if ia.sections.length}}
{{t "map_lead"}}

{{#each ia.sections}}
**{{md_text this.service_id}}**

| {{t "col_menu"}} | {{t "col_feature"}} | {{t "col_roles"}} |
| --- | --- | --- |
{{> ia-rows-md nodes=this.nodes depth=0}}

{{/each}}
{{#if ia.unplaced.length}}
**{{t "map_unplaced"}}**

| {{t "col_feature"}} | {{t "col_roles"}} |
| --- | --- |
{{#each ia.unplaced}}| {{md_cell (translate this.dok.name)}} | {{#each (step_roles this.dok.user_actions.steps)}}{{#if @index}}, {{/if}}{{md_cell (role_label this)}}{{else}}{{t "na"}}{{/each}} |
{{/each}}

{{/if}}
{{else}}
{{t "map_none_lead"}}

| {{t "col_feature"}} | {{t "col_roles"}} |
| --- | --- |
{{#each root.doks}}| {{md_cell (translate this.name)}} | {{#each (step_roles this.user_actions.steps)}}{{#if @index}}, {{/if}}{{md_cell (role_label this)}}{{else}}{{t "na"}}{{/each}} |
{{/each}}

{{/if}}
{{/with}}
{{#if hub.roles.roles.length}}
{{t "s_roles"}}

{{#each hub.roles.roles}}
- **{{md_text (translate this.name)}}** — {{#if (eq this.kind "actor_type")}}{{t "kind_actor_type"}}{{else}}{{t "kind_access"}}{{/if}} · {{#if (eq this.scope "tenant")}}{{t "scope_tenant"}}{{else}}{{#if (eq this.scope "resource")}}{{t "scope_resource"}}{{else}}{{t "scope_global"}}{{/if}}{{/if}} · {{t "col_role_feats"}}: {{#each (doks_for_role root.doks this.role_id)}}{{#if @index}}, {{/if}}{{md_text (translate this.name)}}{{else}}{{t "na"}}{{/each}}
{{/each}}

{{/if}}
{{#if hub.lexicon.terms.length}}
{{t "s_terms"}}

| {{t "col_term"}} | {{t "col_term_alt"}} |
| --- | --- |
{{#each hub.lexicon.terms}}{{#if (len this.locales)}}| {{md_cell (default (lookup this.locales root.locale) (lookup this.locales root.primaryLocale))}} | {{#each this.locales}}{{#unless (eq @key root.locale)}}{{md_cell this}} ({{@key}}) {{/unless}}{{/each}} |
{{/if}}{{/each}}

{{/if}}
{{t "s_setup"}}

{{t "setup_intro"}}

{{#if variables.setup_commands}}
```bash
{{variables.setup_commands}}
```

{{t "setup_pm_note"}}

{{/if}}
{{#if variables.contact}}
{{t "s_contact"}}

{{t "contact_lead"}} {{md_text variables.contact}}
{{/if}}
{{/with}}
