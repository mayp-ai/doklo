<table class="fs-table fs-table--digest">
<colgroup><col class="c-id"><col class="c-feature"><col class="c-rule"><col class="c-roles">{{#if vars.show_repo_info}}<col class="c-evidence">{{/if}}</colgroup>
<thead><tr><th>{{t "col_rule_id"}}</th><th>{{t "col_feature"}}</th><th>{{t "col_rule"}}</th><th>{{t "col_roles"}}</th>{{#if vars.show_repo_info}}<th>{{t "col_evidence"}}</th>{{/if}}</tr></thead>
<tbody>
{{#each (expand_rules doks)}}{{#if (eq this.rule.type ../type)}}
<tr>
<td class="t-id"><code>{{this.rule.id}}</code></td>
<td>{{translate this.dok.name}}<span class="t-sub">{{this.dok.dok_id}}</span></td>
<td>{{translate this.rule.description}}</td>
<td class="t-roles">{{#if this.rule.applies_to_roles.length}}{{#each this.rule.applies_to_roles}}{{#if @index}}, {{/if}}{{role_label this}}{{/each}}{{else}}<span class="t-muted">{{t "roles_unspecified"}}</span>{{/if}}</td>
{{#if ../vars.show_repo_info}}<td class="t-evidence">{{> code-anchor anchor=this.rule.code_anchor}}</td>{{/if}}
</tr>
{{/if}}{{/each}}
</tbody>
</table>