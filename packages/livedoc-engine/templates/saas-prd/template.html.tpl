<header class="prd-hero">
  <div class="prd-hero-eyebrow">
    <span class="prd-status prd-status--{{dok.status}}">{{dok.status}}</span>
    <span class="prd-id">{{dok.dok_id}}</span>
    <span class="prd-version">v{{dok._meta.version}}</span>
  </div>
  <h1 class="prd-title">{{translate dok.name}}</h1>
  <div class="prd-hero-stats">
    <div class="prd-stat"><span class="prd-stat-num">{{len dok.user_actions.steps}}</span><span class="prd-stat-label">{{t "stat_steps"}}</span></div>
    <div class="prd-stat"><span class="prd-stat-num">{{len dok.business_rules.rules}}</span><span class="prd-stat-label">{{t "stat_rules"}}</span></div>
    <div class="prd-stat"><span class="prd-stat-num">{{len dok.acceptance_criteria.criteria}}</span><span class="prd-stat-label">{{t "stat_acs"}}</span></div>
    <div class="prd-stat"><span class="prd-stat-num">{{len dok.surfaces}}</span><span class="prd-stat-label">{{t "stat_surfaces"}}</span></div>
  </div>
  {{#if dok.tags.length}}
  <div class="prd-tags">
    {{#each dok.tags}}<span class="prd-tag">#{{this}}</span>{{/each}}
  </div>
  {{/if}}
</header>

<article class="prd-body">

<section class="prd-section" data-num="01">
<h2 class="prd-section-title">{{t "section_background"}}</h2>
<p class="prd-lead">{{translate dok.description}}</p>
</section>

<section class="prd-section" data-num="02">
<h2 class="prd-section-title">{{t "section_goal"}}</h2>
{{#if dok.user_actions.steps.length}}
<aside class="prd-callout prd-callout--info">
  <div class="prd-callout-label">PM action required</div>
  <div class="prd-callout-body">{{t "goal_placeholder"}}</div>
</aside>
<div class="prd-inferred">
  <span class="prd-inferred-label">{{t "goal_inferred_label"}}</span>
  <span class="prd-inferred-value">{{translate (lookup (lookup dok.user_actions.steps (sub (len dok.user_actions.steps) 1)) "outcome")}}</span>
</div>
{{else}}
<p class="prd-empty">{{t "no_value"}}</p>
{{/if}}
</section>

<section class="prd-section" data-num="03">
<h2 class="prd-section-title">{{t "section_users"}}</h2>
{{#if dok.user_actions.steps.length}}
<div class="prd-actors">
  {{#each (unique_actors dok.user_actions.steps)}}
  {{#unless (eq this.kind "system")}}
  <div class="prd-actor">
    <div class="prd-actor-avatar" aria-hidden="true">{{#if (eq this.kind "role")}}👤{{else}}🌐{{/if}}</div>
    <div class="prd-actor-meta">
      <div class="prd-actor-name">{{actor_label this}}</div>
      <div class="prd-actor-kind">{{this.kind}}{{#if this.role_ref}} · {{this.role_ref}}{{/if}}</div>
    </div>
  </div>
  {{/unless}}
  {{/each}}
</div>
{{else}}
<p class="prd-empty">{{t "no_value"}}</p>
{{/if}}
</section>

<section class="prd-section" data-num="04">
<h2 class="prd-section-title">{{t "section_scenario"}}</h2>
{{#if dok.user_actions.steps.length}}
<ol class="prd-timeline">
  {{#each dok.user_actions.steps}}
  <li class="prd-step">
    <div class="prd-step-num">{{add @index 1}}</div>
    <div class="prd-step-body">
      <div class="prd-step-actor">{{actor_label this.actor}}</div>
      <div class="prd-step-intent">{{translate this.intent}}</div>
      <div class="prd-step-arrow" aria-hidden="true">→</div>
      <div class="prd-step-outcome">{{translate this.outcome}}</div>
    </div>
  </li>
  {{/each}}
</ol>
{{else}}
<p class="prd-empty">{{t "no_value"}}</p>
{{/if}}
</section>

<section class="prd-section" data-num="05">
<h2 class="prd-section-title">{{t "section_fr"}}</h2>
{{#if dok.business_rules.rules.length}}
<div class="prd-rules">
  {{#each dok.business_rules.rules}}
  <div class="prd-rule" data-type="{{this.type}}">
    <div class="prd-rule-head">
      <span class="prd-rule-id">{{this.id}}</span>
      <span class="prd-rule-type prd-rule-type--{{this.type}}">{{this.type}}</span>
    </div>
    <div class="prd-rule-desc">{{translate this.description}}</div>
  </div>
  {{/each}}
</div>
{{else}}
<p class="prd-empty">{{t "no_value"}}</p>
{{/if}}
</section>

<section class="prd-section prd-section--empty" data-num="06">
<h2 class="prd-section-title">{{t "section_nfr"}}</h2>
<p class="prd-empty-state">{{t "empty_pm"}}</p>
</section>

<section class="prd-section prd-section--empty" data-num="07">
<h2 class="prd-section-title">{{t "section_exception"}}</h2>
<p class="prd-empty-state">{{t "empty_pm"}}</p>
</section>

<section class="prd-section" data-num="08">
<h2 class="prd-section-title">{{t "section_metrics"}}</h2>
{{#if dok.acceptance_criteria.criteria.length}}
<div class="prd-acs">
  {{#each dok.acceptance_criteria.criteria}}
  <div class="prd-ac">
    <div class="prd-ac-id">{{this.id}}</div>
    <div class="prd-ac-statement">{{translate this.statement}}</div>
    {{#if this.related_rules.length}}
    <div class="prd-ac-rules">
      <span class="prd-ac-rules-label">{{t "rule_label"}}</span>
      {{#each this.related_rules}}<span class="prd-chip-rule">{{this}}</span>{{/each}}
    </div>
    {{/if}}
  </div>
  {{/each}}
</div>
{{else}}
<p class="prd-empty">{{t "no_value"}}</p>
{{/if}}
</section>

<section class="prd-section prd-section--empty" data-num="09">
<h2 class="prd-section-title">{{t "section_open_questions"}}</h2>
<p class="prd-empty-state">{{t "empty_pm"}}</p>
</section>

</article>

<footer class="prd-footer">
  <div class="prd-footer-meta">Generated by <code>doklo live-docs render saas-prd</code> · {{t "footer_note"}}</div>
</footer>
