# {{md_text (translate dok.name)}}

{{md_text (translate dok.description)}}

| | |
| --- | --- |
| {{t "meta_id"}} | {{md_code dok.dok_id}} |
| {{t "meta_status"}} | {{> status-label status=dok.status}} |
{{#if dok.priority}}| {{t "meta_priority"}} | {{> impact-label impact=dok.priority.impact}} / {{> blast-label blast=dok.priority.blast_radius}} |
{{/if}}| {{t "meta_surfaces"}} | {{#if dok.surfaces.length}}{{#each dok.surfaces}}{{#if @index}} {{/if}}{{md_code this}}{{/each}}{{else}}{{t "none"}}{{/if}} |
| {{t "meta_version"}} | v{{default dok._meta.version 1}} |
{{#if dok.tags.length}}| {{t "meta_tags"}} | {{#each dok.tags}}{{#if @index}} {{/if}}{{md_code this}}{{/each}} |
{{/if}}{{#if dok._meta.history.length}}| {{t "meta_updated"}} | {{#each (limit dok._meta.history 1)}}{{this.date}}{{/each}} |
{{/if}}

{{#if dok.priority}}
> **{{t "impact_title"}}** — {{> impact-sentence impact=dok.priority.impact}}, {{> blast-sentence blast=dok.priority.blast_radius}}. {{t "impact_tail"}}

{{/if}}
## {{t "section_behavior"}}

{{#if dok.user_actions.steps.length}}
| {{t "col_step"}} | {{t "col_actor"}} | {{t "col_action"}} | {{t "col_outcome"}} | {{t "col_platforms"}} |
| ---: | --- | --- | --- | --- |
{{#each dok.user_actions.steps}}| {{add @index 1}} | {{#if (eq this.actor.kind "system")}}_{{t "system_actor"}}_{{else}}{{md_cell (actor_label this.actor)}}{{/if}} | {{md_cell (translate this.intent)}}{{#if this.preconditions.length}} _({{t "precondition"}}: {{#each this.preconditions}}{{#if @index}}; {{/if}}{{md_cell this}}{{/each}})_{{/if}} | {{md_cell (translate this.outcome)}} | {{#if this.variants.length}}{{#each this.variants}}{{#if @index}} · {{/if}}{{#unless (eq this.platform "all")}}{{this.platform}}{{else}}{{t "none"}}{{/unless}}{{/each}}{{else}}{{t "none"}}{{/if}} |
{{/each}}
{{else}}
{{t "none"}}
{{/if}}

## {{t "section_rules"}}

{{#if dok.business_rules.rules.length}}
| {{t "col_rule_id"}} | {{t "col_rule_type"}} | {{t "col_rule"}} | {{t "col_roles"}} | {{t "col_code"}} |
| --- | --- | --- | --- | --- |
{{#each dok.business_rules.rules}}| {{md_code this.id}} | {{> rule-type-label type=this.type}} | {{md_cell (translate this.description)}} | {{#if this.applies_to_roles.length}}{{#each this.applies_to_roles}}{{#if @index}}, {{/if}}{{md_cell (role_label this)}}{{/each}}{{else}}{{t "roles_all"}}{{/if}} | {{#if this.code_anchor.file}}{{> code-link file=this.code_anchor.file symbol=this.code_anchor.function vars=../variables}}{{else}}{{#if this.code_anchor.api}}{{md_code this.code_anchor.api}}{{else}}{{#if this.code_anchor.db_constraint}}{{md_code this.code_anchor.db_constraint}}{{else}}{{t "none"}}{{/if}}{{/if}}{{/if}} |
{{/each}}
{{else}}
{{t "none"}}
{{/if}}

## {{t "section_checks"}}

{{#if dok.acceptance_criteria.criteria.length}}
{{t "checks_lead"}}

{{#each dok.acceptance_criteria.criteria}}
- [ ] **{{md_code this.id}}** {{md_text (translate this.statement)}}{{#if this.related_rules.length}} ({{t "check_rules"}}: {{#each this.related_rules}}{{#if @index}}, {{/if}}{{md_code this}}{{/each}}){{/if}}
{{#if this.given}}  - **{{t "gwt_given"}}** {{md_text this.given}}
{{/if}}{{#if this.when}}  - **{{t "gwt_when"}}** {{md_text this.when}}
{{/if}}{{#if this.then}}  - **{{t "gwt_then"}}** {{md_text this.then}}
{{/if}}{{/each~}}
{{else}}
{{t "none"}}
{{/if}}

## {{t "section_code"}}

{{#if dok._meta.source_anchors.length}}
{{#each dok._meta.source_anchors}}
- {{> code-link file=this.file symbol=this.symbol start_line=this.start_line end_line=this.end_line vars=../variables}}
{{/each}}
{{else}}
{{t "code_none"}}
{{/if}}

## {{t "section_related"}}

{{#if dok.tags.length}}
{{#each hub.doks}}{{#unless (eq this.dok_id ../dok.dok_id)}}{{#if (eq (lookup this.tags 0) (lookup ../dok.tags 0))~}}
- [{{md_text (translate this.name)}}](./{{this.dok_id}}.md) — {{md_code this.dok_id}} · {{> status-label status=this.status}} · {{t "related_shared"}} {{md_code (lookup this.tags 0)}}
{{/if}}{{/unless}}{{/each~}}
{{else}}
{{t "related_none"}}
{{/if}}

## {{t "section_history"}}

{{#if dok._meta.history.length}}
_{{t "history_order"}}_

| {{t "col_date"}} | {{t "col_change"}} | {{t "col_author"}} |
| --- | --- | --- |
{{#each dok._meta.history}}| {{this.date}} | {{md_cell this.change}} | {{#if this.author}}{{md_cell this.author}}{{else}}{{t "none"}}{{/if}} |
{{/each}}
{{else}}
{{t "history_none"}}
{{/if}}

---

{{md_code dok.dok_id}} · {{t "footer"}}{{#if generated_at}} · {{t "footer_asof"}} {{format_date generated_at}}{{/if}}
