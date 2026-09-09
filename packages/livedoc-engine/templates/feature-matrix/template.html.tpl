<header class="fm-hero">
  <h1 class="fm-title">{{t "title"}} — {{translate workspace.name}}</h1>
  <p class="fm-subtitle">{{t "subtitle"}}</p>
  <p class="fm-summary">{{t "stat_features"}} {{len doks}} · {{t "stat_domains"}} {{len (group_doks_by_primary_tag doks)}} · {{t "stat_services"}} {{len workspace.services}}</p>
</header>

<div class="fm-domains">
{{#each (group_doks_by_primary_tag doks)}}
<section class="fm-domain">
  <h2 class="fm-domain-title">{{this.tag}}<span class="fm-domain-count">{{len this.doks}}{{t "domain_count_suffix"}}</span></h2>
  <table class="fm-table">
    <thead>
      <tr>
        <th>{{t "col_feature"}}</th>
        <th>{{t "col_status"}}</th>
        <th>{{t "col_surfaces"}}</th>
        <th class="fm-depth-col">{{t "col_depth"}}</th>
      </tr>
    </thead>
    <tbody>
    {{#each this.doks}}
      <tr>
        <td class="fm-feat"><span class="fm-feat-name">{{translate this.name}}</span></td>
        <td><span class="fm-status fm-status--{{this.status}}">{{this.status}}</span></td>
        <td class="fm-surfaces">{{#each this.surfaces}}<span class="fm-surface">{{this}}</span>{{else}}<span class="fm-dash">—</span>{{/each}}</td>
        <td class="fm-depth"><span class="fm-depth-cell" title="steps">{{#if this.user_actions.steps.length}}{{len this.user_actions.steps}}{{else}}0{{/if}}</span><span class="fm-depth-sep">·</span><span class="fm-depth-cell" title="rules">{{#if this.business_rules.rules.length}}{{len this.business_rules.rules}}{{else}}0{{/if}}</span><span class="fm-depth-sep">·</span><span class="fm-depth-cell" title="acceptance">{{#if this.acceptance_criteria.criteria.length}}{{len this.acceptance_criteria.criteria}}{{else}}0{{/if}}</span></td>
      </tr>
    {{/each}}
    </tbody>
  </table>
</section>
{{/each}}
</div>
