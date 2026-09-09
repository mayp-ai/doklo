<div class="wb-shell">

<header class="wb-top">
<div class="wb-top-bar">
<span class="wb-console-tag">{{t "console_tag"}}</span>
<span class="wb-top-meta">{{t "updated"}} {{format_date workspace.updated_at}} · {{t "scope_workspace"}}</span>
</div>
<h1 class="wb-title">{{t "doc_title"}}</h1>
<p class="wb-subtitle">{{translate workspace.name}} · {{t "subtitle"}}</p>
<div class="wb-kpis">
<div class="wb-kpi"><span class="wb-kpi-num">{{len doks}}</span><span class="wb-kpi-label">{{t "kpi_features"}}</span></div>
<div class="wb-kpi wb-kpi--permission"><span class="wb-kpi-num">{{len (rules_by_type doks "permission")}}</span><span class="wb-kpi-label">{{t "kpi_permission"}}</span></div>
<div class="wb-kpi wb-kpi--validation"><span class="wb-kpi-num">{{len (rules_by_type doks "validation")}}</span><span class="wb-kpi-label">{{t "kpi_validation"}}</span></div>
<div class="wb-kpi wb-kpi--restriction"><span class="wb-kpi-num">{{len (rules_by_type doks "restriction")}}</span><span class="wb-kpi-label">{{t "kpi_restriction"}}</span></div>
<div class="wb-kpi wb-kpi--policy"><span class="wb-kpi-num">{{len (rules_by_type doks "policy")}}</span><span class="wb-kpi-label">{{t "kpi_policy"}}</span></div>
</div>
</header>

<div class="wb-cols">

<nav class="wb-index" aria-label="{{t "index_title"}}">
<p class="wb-index-title">{{t "index_title"}}</p>
<p class="wb-index-hint">{{t "index_hint"}}</p>
<ul class="wb-index-list">
{{#each doks}}
<li class="wb-index-item{{#unless this.business_rules.rules.length}} is-clean{{/unless}}"><a href="#wb-{{this.dok_id}}"><span class="wb-index-name">{{translate this.name}}</span><span class="wb-index-id">{{this.dok_id}}</span>{{#if this.business_rules.rules.length}}<span class="wb-index-count" title="{{len this.business_rules.rules}}">{{len this.business_rules.rules}}</span>{{else}}<span class="wb-index-clean">{{t "index_clean"}}</span>{{/if}}</a></li>
{{/each}}
</ul>
</nav>

<div class="wb-main">

<aside class="wb-agent-note">
<span class="wb-agent-note-mark" aria-hidden="true">i</span>
<div class="wb-agent-note-body">
<p class="wb-agent-note-title">{{t "agent_note_title"}}</p>
<p class="wb-agent-note-text">{{t "agent_note_body"}}</p>
</div>
</aside>

{{#each doks}}
<section class="wb-card" id="wb-{{this.dok_id}}">
<div class="wb-card-head">
<div class="wb-card-headline">
<h2 class="wb-card-name">{{translate this.name}}</h2>
<span class="wb-card-id">{{this.dok_id}}</span>
</div>
<p class="wb-card-desc">{{translate this.description}}</p>
<div class="wb-card-tags">
{{#if (len (unique_actors this.user_actions.steps))}}
<span class="wb-card-tagrow"><span class="wb-card-taglabel">{{t "card_roles_label"}}</span>{{#each (unique_actors this.user_actions.steps)}}<span class="wb-chip wb-chip--{{this.kind}}">{{actor_label this}}</span>{{/each}}</span>
{{/if}}
{{#if this.surfaces.length}}
<span class="wb-card-tagrow"><span class="wb-card-taglabel">{{t "card_surface_label"}}</span>{{#each this.surfaces}}<span class="wb-surface">{{this}}</span>{{/each}}</span>
{{/if}}
</div>
</div>

<div class="wb-card-body">
<p class="wb-when">{{t "card_when"}}</p>
<ul class="wb-reasons">
{{#each this.business_rules.rules}}
{{#if (eq this.type "permission")}}
{{> reason-row type="permission" type_label=(t "label_permission") lead=(t "check_permission") text=(translate this.description) roles=this.applies_to_roles rule_id=this.id rid_label=(t "rule_id_label")}}
{{/if}}
{{/each}}
{{#each this.user_actions.steps}}
{{#if this.preconditions.length}}
{{#each this.preconditions}}
<li class="wb-reason wb-reason--precondition"><span class="wb-reason-badge" aria-hidden="true"></span><span class="wb-reason-type">{{t "label_precondition"}}</span><span class="wb-reason-main"><span class="wb-reason-lead">{{t "check_precondition"}}</span><span class="wb-reason-text">{{this}}</span><span class="wb-reason-step">{{t "precond_in"}} {{../order}} · {{translate ../intent}}</span></span></li>
{{/each}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "validation")}}
{{> reason-row type="validation" type_label=(t "label_validation") lead=(t "check_validation") text=(translate this.description) rule_id=this.id rid_label=(t "rule_id_label")}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "restriction")}}
{{> reason-row type="restriction" type_label=(t "label_restriction") lead=(t "check_restriction") text=(translate this.description) rule_id=this.id rid_label=(t "rule_id_label")}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "policy")}}
{{> reason-row type="policy" type_label=(t "label_policy") lead=(t "check_policy") text=(translate this.description) rule_id=this.id rid_label=(t "rule_id_label")}}
{{/if}}
{{/each}}
{{#each this.business_rules.rules}}
{{#if (eq this.type "calculation")}}
{{> reason-row type="calculation" type_label=(t "label_calculation") lead="" text=(translate this.description) rule_id=this.id rid_label=(t "rule_id_label")}}
{{/if}}
{{/each}}
</ul>

{{#unless this.business_rules.rules.length}}
<div class="wb-clean">
<span class="wb-clean-mark" aria-hidden="true"></span>
<div class="wb-clean-text">
<p class="wb-clean-title">{{t "card_no_blockers"}}</p>
<p class="wb-clean-hint">{{t "card_no_blockers_hint"}}</p>
</div>
</div>
{{/unless}}

{{#if this._meta.source_anchors.length}}
<p class="wb-source">{{t "source_label"}}: {{#each this._meta.source_anchors}}<code>{{this.file}}</code>{{#unless @last}} · {{/unless}}{{/each}}</p>
{{/if}}
</div>
</section>
{{/each}}

</div>
</div>

<footer class="wb-footer">
<div class="wb-legend">
<span class="wb-legend-title">{{t "footer_legend"}}</span>
<span class="wb-legend-item wb-legend-item--permission">{{t "label_permission"}}</span>
<span class="wb-legend-item wb-legend-item--precondition">{{t "label_precondition"}}</span>
<span class="wb-legend-item wb-legend-item--validation">{{t "label_validation"}}</span>
<span class="wb-legend-item wb-legend-item--restriction">{{t "label_restriction"}}</span>
<span class="wb-legend-item wb-legend-item--policy">{{t "label_policy"}}</span>
</div>
<p class="wb-footer-live">{{t "footer_live"}}</p>
</footer>

</div>
