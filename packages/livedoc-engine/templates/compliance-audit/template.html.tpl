<header class="aud-hero">
  <div class="aud-hero-mark" aria-hidden="true">🛡️</div>
  <div class="aud-hero-text">
    <p class="aud-eyebrow">{{translate workspace.name}}</p>
    <h1 class="aud-title">{{t "doc_title"}}</h1>
    <p class="aud-subtitle">{{t "subtitle"}}</p>
    <p class="aud-generated">{{t "generated"}}: {{format_date workspace.updated_at}}</p>
  </div>
</header>

<section class="aud-section" id="summary">
<h2 class="aud-h2">{{t "section_summary"}}</h2>
<p class="aud-lead">{{t "summary_lead"}}</p>

<div class="aud-stats">
  <div class="aud-stat"><span class="aud-stat-num">{{len doks}}</span><span class="aud-stat-label">{{t "stat_doks"}}</span></div>
  <div class="aud-stat aud-stat--perm"><span class="aud-stat-num">{{len (rules_by_type doks "permission")}}</span><span class="aud-stat-label">{{t "stat_permission"}}</span></div>
  <div class="aud-stat aud-stat--restrict"><span class="aud-stat-num">{{len (rules_by_type doks "restriction")}}</span><span class="aud-stat-label">{{t "stat_restriction"}}</span></div>
</div>
</section>

<section class="aud-section" id="access">
<h2 class="aud-h2 aud-h2--perm">{{t "section_access"}}</h2>
<p class="aud-lead">{{t "access_lead"}}</p>

{{#if (len (rules_by_type doks "permission"))}}
<table class="aud-table aud-table--perm">
<thead><tr><th>{{t "col_id"}}</th><th>{{t "col_dok"}}</th><th>{{t "col_desc"}}</th></tr></thead>
<tbody>
{{#each (rules_by_type doks "permission")}}
<tr>
<td class="aud-rule-id">{{this.rule.id}}</td>
<td class="aud-rule-dok">{{translate this.dok_name}}<br><span class="aud-rule-dokid">{{this.dok_id}}</span></td>
<td>{{translate this.rule.description}}</td>
</tr>
{{/each}}
</tbody>
</table>
{{else}}
<p class="aud-empty">{{t "no_rules"}}</p>
{{/if}}
</section>

<section class="aud-section" id="constraints">
<h2 class="aud-h2 aud-h2--restrict">{{t "section_constraints"}}</h2>
<p class="aud-lead">{{t "constraints_lead"}}</p>

{{#if (len (rules_by_type doks "restriction"))}}
<table class="aud-table aud-table--restrict">
<thead><tr><th>{{t "col_id"}}</th><th>{{t "col_dok"}}</th><th>{{t "col_desc"}}</th></tr></thead>
<tbody>
{{#each (rules_by_type doks "restriction")}}
<tr>
<td class="aud-rule-id">{{this.rule.id}}</td>
<td class="aud-rule-dok">{{translate this.dok_name}}<br><span class="aud-rule-dokid">{{this.dok_id}}</span></td>
<td>{{translate this.rule.description}}</td>
</tr>
{{/each}}
</tbody>
</table>
{{else}}
<p class="aud-empty">{{t "no_rules"}}</p>
{{/if}}
</section>

<section class="aud-section" id="other">
<h2 class="aud-h2">{{t "section_other"}}</h2>
<p class="aud-lead">{{t "other_lead"}}</p>

<details class="aud-details">
<summary>{{t "type_policy"}} · {{len (rules_by_type doks "policy")}}</summary>
<table class="aud-table">
<tbody>
{{#each (rules_by_type doks "policy")}}
<tr><td class="aud-rule-id">{{this.rule.id}}</td><td>{{translate this.rule.description}}</td></tr>
{{/each}}
</tbody>
</table>
</details>

<details class="aud-details">
<summary>{{t "type_validation"}} · {{len (rules_by_type doks "validation")}}</summary>
<table class="aud-table">
<tbody>
{{#each (rules_by_type doks "validation")}}
<tr><td class="aud-rule-id">{{this.rule.id}}</td><td>{{translate this.rule.description}}</td></tr>
{{/each}}
</tbody>
</table>
</details>
</section>

<footer class="aud-footer">
<p>{{t "disclaimer"}}</p>
</footer>
