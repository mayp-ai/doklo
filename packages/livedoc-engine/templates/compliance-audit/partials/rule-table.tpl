{{#if (len (rules_by_type doks type))}}
<table class="ca-table ca-table--rules">
<colgroup><col class="c-id"><col class="c-feature"><col class="c-roles"><col class="c-rule"><col class="c-status"></colgroup>
<thead><tr>
<th>{{t "col_id"}}</th><th>{{t "col_feature"}}</th><th>{{t "col_roles"}}</th><th>{{t "col_rule"}}</th><th>{{t "col_status"}}</th>
</tr></thead>
<tbody>
{{#each (expand_rules doks)}}{{#if (eq this.rule.type ../type)}}
<tr>
<td class="t-id"><code>{{this.rule.id}}</code></td>
<td class="t-feature">{{translate this.dok.name}}<span class="t-sub">{{this.dok.dok_id}}</span></td>
<td class="t-roles">{{#if this.rule.applies_to_roles.length}}{{#each this.rule.applies_to_roles}}{{#if @index}}, {{/if}}{{role_label this}}{{/each}}{{else}}<span class="t-muted">{{t "roles_unspecified"}}</span>{{/if}}</td>
<td class="t-rule">{{translate this.rule.description}}{{#if this.rule.code_anchor}}<span class="t-evidence"><span class="ca-k">{{t "col_evidence"}}</span>{{> code-anchor anchor=this.rule.code_anchor}}</span>{{/if}}</td>
<td class="t-status"><span class="status status--{{this.dok.status}}">{{> status-label status=this.dok.status}}</span></td>
</tr>
{{/if}}{{/each}}
</tbody>
</table>
{{else}}
<p class="ca-none-note">{{t "no_rules"}}</p>
{{/if}}
