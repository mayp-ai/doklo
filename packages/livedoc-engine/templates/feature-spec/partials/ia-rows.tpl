{{#each nodes}}
<tr class="fs-ia-row fs-ia-d{{../depth}}">
<td class="fs-ia-menu"><span class="fs-ia-label">{{translate this.label}}</span></td>
<td class="fs-ia-path">{{#if this.path}}<code>{{this.path}}</code>{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
<td class="fs-ia-feat">{{#each this.doks}}<span class="fs-ia-dok">{{translate this.dok.name}}<span class="t-sub">{{this.dok.dok_id}}</span></span>{{/each}}</td>
</tr>
{{#if this.children.length}}{{> ia-rows nodes=this.children depth=(add ../depth 1)}}{{/if}}
{{/each}}