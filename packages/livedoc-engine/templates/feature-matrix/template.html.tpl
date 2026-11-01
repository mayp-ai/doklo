{{#with this as |root|}}
{{!-- feature-matrix v3 — one matrix: features by menu × services × roles. --}}
<header class="fm-head">
  <h1 class="fm-title">{{t "title"}} — {{translate workspace.name}}</h1>
  <p class="fm-subtitle">{{t "subtitle"}}</p>
  <p class="fm-meta"><span><span class="fm-k">{{t "meta_asof"}}</span> {{format_date generated_at}}</span><span><span class="fm-k">{{t "meta_features"}}</span> {{len doks}}{{t "unit_features"}}</span><span><span class="fm-k">{{t "meta_services"}}</span> {{len (surface_columns root.doks root.workspace.services)}}</span>{{#if hub.roles.roles.length}}<span><span class="fm-k">{{t "meta_roles"}}</span> {{len hub.roles.roles}}</span>{{/if}}</p>
</header>

<p class="fm-note">{{t "note"}}</p>

{{#with (surface_columns root.doks root.workspace.services) as |cols|}}
<table class="fm-table">
  <thead>
    <tr>
      <th rowspan="2" class="fm-th-group">{{t "col_group"}}</th>
      <th rowspan="2" class="fm-th-feature">{{t "col_feature"}}</th>
      {{#if cols.length}}<th colspan="{{len cols}}" class="fm-th-band">{{t "head_services"}}</th>{{/if}}
      {{#if root.hub.roles.roles.length}}<th colspan="{{len root.hub.roles.roles}}" class="fm-th-band">{{t "head_roles"}}</th>{{/if}}
    </tr>
    <tr>
      {{#each cols}}<th class="fm-th-col"><span class="fm-col-id">{{this.service_id}}</span>{{#if this.type}}<span class="fm-col-type">{{> service-type-label type=this.type}}</span>{{/if}}</th>{{/each}}
      {{#each root.hub.roles.roles}}<th class="fm-th-col"><span class="fm-col-role">{{translate this.name}}</span></th>{{/each}}
    </tr>
  </thead>
  <tbody>
  {{#with (help_categories root.hub.services root.doks ".html") as |ia|}}
    {{#each ia.categories as |category|}}
      {{#each category.articles as |article|}}
      <tr>
        {{#if @first}}<th scope="rowgroup" rowspan="{{category.count}}" class="fm-group">{{translate category.label}}</th>{{/if}}
        <td class="fm-feature">{{translate article.dok.name}}</td>
        {{#each cols as |col|}}<td class="fm-cell">{{#if (includes article.dok.surfaces col.service_id)}}<span class="fm-on">●</span>{{else}}<span class="fm-off">–</span>{{/if}}</td>{{/each}}
        {{#each root.hub.roles.roles as |role|}}<td class="fm-cell">{{#if (includes (step_roles article.dok.user_actions.steps) role.role_id)}}<span class="fm-on">●</span>{{else}}<span class="fm-off">–</span>{{/if}}</td>{{/each}}
      </tr>
      {{/each}}
    {{/each}}
    {{#each ia.unplaced as |article|}}
      <tr>
        {{#if @first}}<th scope="rowgroup" rowspan="{{len ia.unplaced}}" class="fm-group">{{#if ia.categories.length}}{{t "group_other"}}{{/if}}</th>{{/if}}
        <td class="fm-feature">{{translate article.dok.name}}</td>
        {{#each cols as |col|}}<td class="fm-cell">{{#if (includes article.dok.surfaces col.service_id)}}<span class="fm-on">●</span>{{else}}<span class="fm-off">–</span>{{/if}}</td>{{/each}}
        {{#each root.hub.roles.roles as |role|}}<td class="fm-cell">{{#if (includes (step_roles article.dok.user_actions.steps) role.role_id)}}<span class="fm-on">●</span>{{else}}<span class="fm-off">–</span>{{/if}}</td>{{/each}}
      </tr>
    {{/each}}
  {{/with}}
  </tbody>
</table>
{{/with}}

<p class="fm-legend"><span class="fm-legend-title">{{t "legend_title"}}</span> <span class="fm-on">●</span> {{t "legend_offered"}} · <span class="fm-off">–</span> {{t "legend_none"}}</p>
{{/with}}
