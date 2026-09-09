# {{translate workspace.name}} — Architecture

{{t "intro"}}

{{t "section_context"}}

{{t "context_lead"}}

```mermaid
graph LR
  user["End User"]
  system["{{translate workspace.name}}"]
  user --> system
{{#each workspace.services}}
  svc_{{@index}}["{{this.service_id}} ({{this.framework}})"]
  system --- svc_{{@index}}
{{/each}}
```

{{t "section_blocks"}}

{{t "blocks_lead"}}

| Service | Type | Framework | Code root |
| --- | --- | --- | --- |
{{#each workspace.services}}
| `{{this.service_id}}` | {{this.type}} | {{this.framework}} | `{{this.code_root}}` |
{{/each}}

{{t "section_runtime"}}

{{t "runtime_lead"}}

{{#each (group_doks_by_primary_tag doks)}}
### `{{this.tag}}` ({{len this.doks}})

{{#each (limit this.doks 5)}}
- **{{this.dok_id}}** — {{translate this.name}}
{{/each}}
{{#if (gt (len this.doks) 5)}}

<details>
<summary>{{t "more_prefix"}}{{sub (len this.doks) 5}}{{t "more_suffix"}}</summary>

{{#each this.doks}}
{{#if (gte @index 5)}}
- **{{this.dok_id}}** — {{translate this.name}}
{{/if}}
{{/each}}

</details>
{{/if}}

{{/each}}

{{t "section_decisions"}}

{{t "decisions_lead"}}

{{#each doks}}
{{#if this.business_rules.rules.length}}
<details>
<summary><strong>{{this.dok_id}}</strong> — {{translate this.name}} <em>({{len this.business_rules.rules}})</em></summary>

{{#each this.business_rules.rules}}
- **{{this.id}}** (_{{this.type}}_) — {{translate this.description}}
{{/each}}

</details>
{{/if}}
{{/each}}
