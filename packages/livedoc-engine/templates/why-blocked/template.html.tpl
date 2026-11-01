{{!-- why-blocked v3 — internal support reference: one ordered conditions table per feature. --}}
{{#with this as |root|}}
<header class="wb-head">
  <p class="wb-eyebrow">{{t "internal"}}</p>
  <h1 class="wb-title">{{t "doc_title"}} — {{translate workspace.name}}</h1>
  <p class="wb-subtitle">{{t "subtitle"}}</p>
  <p class="wb-meta"><span><span class="wb-k">{{t "meta_asof"}}</span> {{format_date generated_at}}</span><span><span class="wb-k">{{t "meta_features"}}</span> {{len doks}}{{t "unit_features"}}</span></p>
</header>

<p class="wb-reading">{{t "reading"}}</p>

<nav class="wb-toc" aria-label="{{t "toc_title"}}">
  <h2 class="wb-toc-title">{{t "toc_title"}}</h2>
  <ol class="wb-toc-list">
    {{#each doks}}<li><a href="#wb-{{this.dok_id}}">{{translate this.name}}</a> <span class="wb-id">{{this.dok_id}}</span>{{#unless (has_blockers this)}} <span class="wb-clean">{{t "toc_clean"}}</span>{{/unless}}</li>
    {{/each}}
  </ol>
</nav>

{{#each doks}}
<section class="wb-feature" id="wb-{{this.dok_id}}">
  <h2 class="wb-h2">{{translate this.name}} <span class="wb-id">{{this.dok_id}}</span></h2>
  <p class="wb-desc">{{translate this.description}}</p>
  <dl class="wb-facts">
    {{#if (len (unique_actors this.user_actions.steps))}}<div><dt>{{t "roles_label"}}</dt><dd>{{#each (unique_actors this.user_actions.steps)}}{{#if @index}}, {{/if}}{{actor_label this}}{{/each}}</dd></div>{{/if}}
    {{#if this.surfaces.length}}<div><dt>{{t "surfaces_label"}}</dt><dd>{{#each this.surfaces}}{{#if @index}}, {{/if}}<code>{{this}}</code>{{/each}}</dd></div>{{/if}}
    {{#if this._meta.source_anchors.length}}<div><dt>{{t "source_label"}}</dt><dd>{{#each this._meta.source_anchors}}{{#if @index}}, {{/if}}<code>{{this.file}}</code>{{/each}}</dd></div>{{/if}}
  </dl>
  {{#if (has_blockers this)}}
  <table class="wb-table">
    <colgroup><col class="c-type"><col class="c-cond"><col class="c-roles"><col class="c-ref"></colgroup>
    <thead><tr><th>{{t "col_type"}}</th><th>{{t "col_condition"}}</th><th>{{t "col_roles"}}</th><th>{{t "col_ref"}}</th></tr></thead>
    <tbody>
    {{#with this as |dok|}}
    {{#each dok.business_rules.rules}}{{#if (eq this.type "permission")}}{{> reason-row type="permission" type_label=(t "type_permission") text=(translate this.description) roles=this.applies_to_roles any=(t "roles_any") ref=this.id na=(t "na")}}{{/if}}{{/each}}
    {{#each dok.user_actions.steps}}{{#each this.preconditions}}{{> reason-row type="precondition" type_label=(t "type_precondition") text=this ref=(concat (t "step_ref") " " ../order) na=(t "na")}}{{/each}}{{/each}}
    {{#each dok.business_rules.rules}}{{#if (eq this.type "validation")}}{{> reason-row type="validation" type_label=(t "type_validation") text=(translate this.description) ref=this.id na=(t "na")}}{{/if}}{{/each}}
    {{#each dok.business_rules.rules}}{{#if (eq this.type "restriction")}}{{> reason-row type="restriction" type_label=(t "type_restriction") text=(translate this.description) ref=this.id na=(t "na")}}{{/if}}{{/each}}
    {{#each dok.business_rules.rules}}{{#if (eq this.type "policy")}}{{> reason-row type="policy" type_label=(t "type_policy") text=(translate this.description) ref=this.id na=(t "na")}}{{/if}}{{/each}}
    {{#each dok.business_rules.rules}}{{#if (eq this.type "calculation")}}{{> reason-row type="calculation" type_label=(t "type_calculation") text=(translate this.description) ref=this.id na=(t "na")}}{{/if}}{{/each}}
    {{/with}}
    </tbody>
  </table>
  {{else}}
  <p class="wb-none">{{t "no_blockers"}}</p>
  {{/if}}
</section>
{{/each}}

<section class="wb-escalate">
  <h2 class="wb-h2">{{t "escalate_title"}}</h2>
  {{#if variables.escalation_contact}}<p><strong>{{t "escalate_to"}}:</strong> {{variables.escalation_contact}}</p>{{/if}}
  <p>{{t "escalate_bring"}}</p>
</section>
{{/with}}
