# {{t "welcome"}} — {{translate workspace.name}}

{{t "intro"}}

{{t "section_what"}}

{{translate workspace.name}} {{t "what_lead"}}. {{t "count_doks_prefix"}}{{len doks}}{{t "count_doks_suffix"}}{{t "meta_separator"}}{{t "count_services_prefix"}}{{len workspace.services}}{{t "count_services_suffix"}}

{{t "section_week_one"}}

{{t "week_one_intro"}}

{{#each (filter_active_with_steps doks)}}
- **{{translate this.name}}**
{{/each}}

{{t "section_domains"}}

{{t "domains_intro"}}

{{#each (group_doks_by_primary_tag doks)}}
### `{{this.tag}}` ({{len this.doks}})

{{#each this.doks}}
- **{{translate this.name}}**
{{/each}}

{{/each}}

{{t "section_setup"}}

{{t "setup_intro"}}

{{#if variables.setup_commands}}
```bash
{{variables.setup_commands}}
```

{{t "setup_pm_note"}}
{{/if}}
