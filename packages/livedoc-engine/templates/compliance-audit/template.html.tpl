{{!-- compliance-audit v3 — HTML. Formal, print-first control inventory. --}}
<header class="ca-cover">
  <p class="ca-cover-eyebrow">{{translate workspace.name}}</p>
  <h1 class="ca-cover-title">{{t "doc_title"}}</h1>
  <p class="ca-cover-kind">{{t "doc_kind"}}</p>

  <table class="ca-kv">
    <tbody>
      <tr><th scope="row">{{t "cover_system"}}</th><td>{{translate workspace.name}}</td></tr>
      <tr><th scope="row">{{t "cover_asof"}}</th><td>{{format_date generated_at}}</td></tr>
      {{#if variables.reference_no}}<tr><th scope="row">{{t "cover_ref"}}</th><td>{{variables.reference_no}}</td></tr>{{/if}}
      {{#if variables.classification}}<tr><th scope="row">{{t "cover_classification"}}</th><td>{{variables.classification}}</td></tr>{{/if}}
      {{#if variables.prepared_for}}<tr><th scope="row">{{t "cover_prepared_for"}}</th><td>{{variables.prepared_for}}</td></tr>{{/if}}
      {{#if variables.prepared_by}}<tr><th scope="row">{{t "cover_prepared_by"}}</th><td>{{variables.prepared_by}}</td></tr>{{/if}}
      <tr><th scope="row">{{t "cover_scope"}}</th><td>{{t "cover_scope_pre"}}{{len doks}}{{t "cover_scope_mid"}}{{len (expand_rules doks)}}{{t "cover_scope_post"}}</td></tr>
      <tr><th scope="row">{{t "cover_basis"}}</th><td>{{t "cover_basis_value"}}</td></tr>
    </tbody>
  </table>

  <table class="ca-signoff" aria-label="{{t "signoff_title"}}">
    <caption>{{t "signoff_title"}}</caption>
    <thead><tr><th scope="col">{{t "signoff_role"}}</th><th scope="col">{{t "signoff_name"}}</th><th scope="col">{{t "signoff_date"}}</th><th scope="col">{{t "signoff_sign"}}</th></tr></thead>
    <tbody>
      <tr><th scope="row">{{t "signoff_author"}}</th><td></td><td></td><td></td></tr>
      <tr><th scope="row">{{t "signoff_reviewer"}}</th><td></td><td></td><td></td></tr>
      <tr><th scope="row">{{t "signoff_approver"}}</th><td></td><td></td><td></td></tr>
    </tbody>
  </table>

  <table class="ca-history" aria-label="{{t "history_title"}}">
    <caption>{{t "history_title"}}</caption>
    <thead><tr><th scope="col">{{t "col_version"}}</th><th scope="col">{{t "col_date"}}</th><th scope="col">{{t "col_change"}}</th><th scope="col">{{t "col_author"}}</th></tr></thead>
    <tbody><tr><td>{{default variables.document_version "1.0"}}</td><td>{{format_date generated_at}}</td><td>{{t "history_change_pre"}}{{format_date generated_at}}{{t "history_change_post"}}</td><td>{{#if variables.prepared_by}}{{variables.prepared_by}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td></tr></tbody>
  </table>
</header>

<nav class="ca-toc" aria-label="{{t "toc_title"}}">
  <h2 class="ca-toc-title">{{t "toc_title"}}</h2>
  <ol class="ca-toc-list">
    <li><a href="#s1">{{t "s1"}}</a></li>
    <li><a href="#s2">{{t "s2"}}</a></li>
    <li><a href="#s3">{{t "s3"}}</a></li>
    <li><a href="#s4">{{t "s4"}}</a></li>
    <li><a href="#s5">{{t "s5"}}</a></li>
    <li><a href="#s6">{{t "s6"}}</a></li>
    <li><a href="#s7">{{t "s7"}}</a></li>
    <li><a href="#appendix-a">{{t "appendix_a"}}</a></li>
    <li><a href="#appendix-b">{{t "appendix_b"}}</a></li>
    <li><a href="#appendix-c">{{t "appendix_c"}}</a></li>
  </ol>
</nav>

<section class="ca-section" id="s1">
  <h2 class="ca-h2">{{t "s1"}}</h2>

  <h3 class="ca-h3">{{t "s1_1"}}</h3>
  <p>{{t "s1_1_body"}}</p>

  <h3 class="ca-h3">{{t "s1_2"}}</h3>
  <p>{{t "s1_2_body"}}</p>
  <table class="ca-table ca-table--compact ca-scope">
    <tbody>
      <tr><th scope="row">{{t "scope_total"}}</th><td class="t-num">{{len doks}}</td>
          <th scope="row">{{t "scope_active"}}</th><td class="t-num">{{len (where_status doks "active")}}</td></tr>
      <tr><th scope="row">{{t "scope_rules"}}</th><td class="t-num">{{len (expand_rules doks)}}</td>
          <th scope="row">{{t "scope_pending"}}</th><td class="t-num">{{add (len (where_status doks "draft")) (len (where_status doks "review"))}}</td></tr>
    </tbody>
  </table>

  <h3 class="ca-h3">{{t "s1_3"}}</h3>
  <p>{{t "s1_3_body_1"}}</p>
  <p>{{t "s1_3_body_2"}}</p>
  <dl class="ca-defs">
    <div><dt>{{t "type_permission"}}</dt><dd>{{t "def_permission"}}</dd></div>
    <div><dt>{{t "type_restriction"}}</dt><dd>{{t "def_restriction"}}</dd></div>
    <div><dt>{{t "type_policy"}}</dt><dd>{{t "def_policy"}}</dd></div>
    <div><dt>{{t "type_validation"}}</dt><dd>{{t "def_validation"}}</dd></div>
    <div><dt>{{t "type_calculation"}}</dt><dd>{{t "def_calculation"}}</dd></div>
  </dl>

  <h3 class="ca-h3">{{t "s1_4"}}</h3>
  <ol class="ca-list">
    <li>{{t "s1_4_body_1"}}</li>
    <li>{{t "s1_4_body_2"}}</li>
    <li>{{t "s1_4_body_3"}}</li>
  </ol>
</section>

<section class="ca-section" id="s2">
  <h2 class="ca-h2">{{t "s2"}}</h2>
  <p class="ca-conclusion">{{t "concl_1"}}<strong>{{len doks}}</strong>{{t "concl_2"}}<strong>{{len (expand_rules doks)}}</strong>{{t "concl_3"}}<strong>{{len (rules_by_type doks "permission")}}</strong>{{t "concl_4"}}<strong>{{len (rules_by_type doks "restriction")}}</strong>{{t "concl_5"}}</p>

  <h3 class="ca-h3">{{t "s2_1"}}</h3>
  <table class="ca-table ca-table--summary">
    <colgroup><col class="c-type"><col class="c-def"><col class="c-count"><col class="c-sec"></colgroup>
    <thead><tr><th>{{t "col_type"}}</th><th>{{t "col_definition"}}</th><th class="t-num">{{t "col_count"}}</th><th>{{t "col_section"}}</th></tr></thead>
    <tbody>
      <tr><th scope="row">{{t "type_permission"}}</th><td>{{t "def_permission"}}</td><td class="t-num">{{len (rules_by_type doks "permission")}}</td><td><a href="#s4">4</a></td></tr>
      <tr><th scope="row">{{t "type_restriction"}}</th><td>{{t "def_restriction"}}</td><td class="t-num">{{len (rules_by_type doks "restriction")}}</td><td><a href="#s5">5</a></td></tr>
      <tr><th scope="row">{{t "type_policy"}}</th><td>{{t "def_policy"}}</td><td class="t-num">{{len (rules_by_type doks "policy")}}</td><td><a href="#s6-1">6.1</a></td></tr>
      <tr><th scope="row">{{t "type_validation"}}</th><td>{{t "def_validation"}}</td><td class="t-num">{{len (rules_by_type doks "validation")}}</td><td><a href="#s6-2">6.2</a></td></tr>
      <tr><th scope="row">{{t "type_calculation"}}</th><td>{{t "def_calculation"}}</td><td class="t-num">{{len (rules_by_type doks "calculation")}}</td><td><a href="#s6-3">6.3</a></td></tr>
    </tbody>
    <tfoot><tr><th scope="row" colspan="2">{{t "scope_rules"}}</th><td class="t-num">{{len (expand_rules doks)}}</td><td></td></tr></tfoot>
  </table>

  <h3 class="ca-h3">{{t "s2_2"}}</h3>
  <ol class="ca-list ca-observations">
    {{#unless (len (rules_by_type doks "permission"))}}
    <li>{{t "obs_none_perm"}}</li>
    {{/unless}}
    {{#if (len (rules_by_type doks "permission"))}}{{#if (len (doks_without_rule_type doks "permission"))}}
    <li>{{t "obs_no_perm_pre"}}{{len (doks_without_rule_type doks "permission")}}{{t "obs_no_perm_post"}}</li>
    {{/if}}{{/if}}
    {{#if (add (add (len (where_status doks "draft")) (len (where_status doks "review"))) (len (where_status doks "planned")))}}
    <li>{{t "obs_pending_pre"}}{{add (len (where_status doks "draft")) (len (where_status doks "review"))}}{{t "obs_pending_post"}}</li>
    {{else}}
    <li>{{t "obs_all_reviewed"}}</li>
    {{/if}}
    {{#if hub.roles.roles.length}}
    <li>{{t "obs_roles_pre"}}{{len hub.roles.roles}}{{t "obs_roles_post"}}</li>
    {{else}}
    <li>{{t "obs_no_roles"}}</li>
    {{/if}}
  </ol>
</section>

<section class="ca-section" id="s3">
  <h2 class="ca-h2">{{t "s3"}}</h2>

  <h3 class="ca-h3">{{t "s3_1"}}</h3>
  {{#if hub.roles.roles.length}}
  <table class="ca-table ca-table--roles">
    <colgroup><col class="c-id"><col class="c-name"><col class="c-kind"><col class="c-scope"><col class="c-desc"></colgroup>
    <thead><tr><th>{{t "col_role_id"}}</th><th>{{t "col_role_name"}}</th><th>{{t "col_role_kind"}}</th><th>{{t "col_role_scope"}}</th><th>{{t "col_role_desc"}}</th></tr></thead>
    <tbody>
      {{#each hub.roles.roles}}
      <tr>
        <td class="t-id"><code>{{this.role_id}}</code></td>
        <td class="t-strong">{{translate this.name}}</td>
        <td>{{> role-kind-label kind=this.kind}}</td>
        <td>{{> role-scope-label scope=this.scope}}</td>
        <td>{{#if this.description}}{{this.description}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p class="ca-none-note">{{t "obs_no_roles"}}</p>
  {{/if}}

  {{#if hub.roles.roles.length}}
  <h3 class="ca-h3">{{t "s3_2"}}</h3>
  <p>{{t "s3_2_body"}}</p>
  <table class="ca-table ca-matrix">
    <thead><tr><th>{{t "matrix_feature"}}</th>{{#each hub.roles.roles}}<th class="t-center">{{translate this.name}}<span class="t-sub">{{this.role_id}}</span></th>{{/each}}</tr></thead>
    <tbody>
      {{#each (role_matrix doks hub.roles.roles)}}
      <tr>
        <th scope="row">{{translate this.dok.name}}<span class="t-sub">{{this.dok.dok_id}}</span></th>
        {{#each this.cells}}
        <td class="t-center m-cell">{{#if this.step_count}}{{#if this.rule_count}}<span class="m-both" title="{{t "legend_both"}}">●</span>{{else}}<span class="m-steps" title="{{t "legend_steps"}}">○</span>{{/if}}{{else}}{{#if this.rule_count}}<span class="m-rules" title="{{t "legend_rules"}}">△</span>{{else}}<span class="m-none" title="{{t "legend_none"}}">–</span>{{/if}}{{/if}}</td>
        {{/each}}
      </tr>
      {{/each}}
    </tbody>
  </table>
  <p class="ca-legend"><span class="ca-legend-title">{{t "legend_title"}}</span> <span class="m-both">●</span> {{t "legend_both"}} · <span class="m-steps">○</span> {{t "legend_steps"}} · <span class="m-rules">△</span> {{t "legend_rules"}} · <span class="m-none">–</span> {{t "legend_none"}}</p>
  {{/if}}
</section>

<section class="ca-section" id="s4">
  <h2 class="ca-h2">{{t "s4"}}</h2>
  <p class="ca-lead">{{t "s4_lead"}}</p>
  {{> rule-table doks=doks type="permission"}}
</section>

<section class="ca-section" id="s5">
  <h2 class="ca-h2">{{t "s5"}}</h2>
  <p class="ca-lead">{{t "s5_lead"}}</p>
  {{> rule-table doks=doks type="restriction"}}
</section>

<section class="ca-section" id="s6">
  <h2 class="ca-h2">{{t "s6"}}</h2>
  <p class="ca-lead">{{t "s6_lead"}}</p>
  <h3 class="ca-h3" id="s6-1">{{t "s6_1"}}</h3>
  {{> rule-table doks=doks type="policy"}}
  <h3 class="ca-h3" id="s6-2">{{t "s6_2"}}</h3>
  {{> rule-table doks=doks type="validation"}}
  <h3 class="ca-h3" id="s6-3">{{t "s6_3"}}</h3>
  {{> rule-table doks=doks type="calculation"}}
</section>

<section class="ca-section" id="s7">
  <h2 class="ca-h2">{{t "s7"}}</h2>
  <p class="ca-lead">{{t "s7_lead"}}</p>

  <h3 class="ca-h3">{{t "s7_1"}}</h3>
  {{#if (len (doks_without_rule_type doks "permission"))}}
  <p>{{t "s7_1_body"}}</p>
  <table class="ca-table">
    <colgroup><col class="c-no"><col class="c-feature"><col class="c-other"></colgroup>
    <thead><tr><th>{{t "col_no"}}</th><th>{{t "col_feature"}}</th><th>{{t "col_other_rules"}}</th></tr></thead>
    <tbody>
      {{#each (doks_without_rule_type doks "permission")}}
      <tr>
        <td class="t-num">{{add @index 1}}</td>
        <td>{{translate this.name}}<span class="t-sub">{{this.dok_id}}</span></td>
        <td>{{#if this.business_rules.rules.length}}{{#each (rule_types this.business_rules.rules)}}{{#if @index}}, {{/if}}{{> rule-type-label type=this}}{{/each}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p class="ca-none-note">{{t "s7_1_none"}}</p>
  {{/if}}

  <h3 class="ca-h3">{{t "s7_2"}}</h3>
  {{#if (add (add (len (where_status doks "draft")) (len (where_status doks "review"))) (len (where_status doks "planned")))}}
  <p>{{t "s7_2_body"}}</p>
  <table class="ca-table">
    <colgroup><col class="c-no"><col class="c-feature"><col class="c-status"><col class="c-other"></colgroup>
    <thead><tr><th>{{t "col_no"}}</th><th>{{t "col_feature"}}</th><th>{{t "col_status"}}</th><th>{{t "col_other_rules"}}</th></tr></thead>
    <tbody>
      {{#each (where_status doks "draft")}}
      <tr>
        <td class="t-num">{{add @index 1}}</td>
        <td>{{translate this.name}}<span class="t-sub">{{this.dok_id}}</span></td>
        <td><span class="status status--draft">{{t "status_draft"}}</span></td>
        <td class="t-num">{{len this.business_rules.rules}}</td>
      </tr>
      {{/each}}
      {{#each (where_status doks "review")}}
      <tr>
        <td class="t-num">{{add (add @index 1) (len (where_status ../doks "draft"))}}</td>
        <td>{{translate this.name}}<span class="t-sub">{{this.dok_id}}</span></td>
        <td><span class="status status--review">{{t "status_review"}}</span></td>
        <td class="t-num">{{len this.business_rules.rules}}</td>
      </tr>
      {{/each}}
      {{#each (where_status doks "planned")}}
      <tr>
        <td class="t-num">{{add (add (add @index 1) (len (where_status ../doks "draft"))) (len (where_status ../doks "review"))}}</td>
        <td>{{translate this.name}}<span class="t-sub">{{this.dok_id}}</span></td>
        <td><span class="status status--planned">{{t "status_planned"}}</span></td>
        <td class="t-num">{{len this.business_rules.rules}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
  {{else}}
  <p class="ca-none-note">{{t "s7_2_none"}}</p>
  {{/if}}

  <h3 class="ca-h3">{{t "s7_3"}}</h3>
  <div class="ca-norole">
  <p class="ca-norole-body">{{t "s7_3_body"}}</p>
  <table class="ca-table ca-table--norole">
    <colgroup><col class="c-id"><col class="c-feature"><col class="c-rule"></colgroup>
    <thead><tr><th>{{t "col_id"}}</th><th>{{t "col_feature"}}</th><th>{{t "col_rule"}}</th></tr></thead>
    <tbody>{{~#each (expand_rules doks)~}}{{~#unless this.rule.applies_to_roles.length~}}<tr><td class="t-id"><code>{{this.rule.id}}</code></td><td>{{translate this.dok.name}}<span class="t-sub">{{this.dok.dok_id}}</span></td><td>{{translate this.rule.description}}</td></tr>{{~/unless~}}{{~/each~}}</tbody>
  </table>
  <p class="ca-none-note ca-norole-none">{{t "s7_3_none"}}</p>
  </div>
</section>

<section class="ca-section ca-appendix" id="appendix-a">
  <h2 class="ca-h2">{{t "appendix_a"}}</h2>
  <table class="ca-table ca-table--inventory">
    <colgroup><col class="c-no"><col class="c-id"><col class="c-name"><col class="c-status"><col class="c-impact"><col class="c-blast"><col class="c-cnt"><col class="c-cnt"><col class="c-cnt"></colgroup>
    <thead><tr><th>{{t "col_no"}}</th><th>{{t "col_feature_id"}}</th><th>{{t "col_feature"}}</th><th>{{t "col_status"}}</th><th>{{t "col_impact"}}</th><th>{{t "col_blast"}}</th><th class="t-num">{{t "col_rule_count"}}</th><th class="t-num">{{t "col_ac_count"}}</th><th class="t-num">{{t "col_file_count"}}</th></tr></thead>
    <tbody>
      {{#each doks}}
      <tr>
        <td class="t-num">{{add @index 1}}</td>
        <td class="t-id"><code>{{this.dok_id}}</code></td>
        <td class="t-strong">{{translate this.name}}</td>
        <td><span class="status status--{{this.status}}">{{> status-label status=this.status}}</span></td>
        <td>{{> impact-label impact=this.priority.impact}}</td>
        <td>{{> blast-label blast=this.priority.blast_radius}}</td>
        <td class="t-num">{{len this.business_rules.rules}}</td>
        <td class="t-num">{{len this.acceptance_criteria.criteria}}</td>
        <td class="t-num">{{len this._meta.source_anchors}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
</section>

<section class="ca-section ca-appendix" id="appendix-b">
  <h2 class="ca-h2">{{t "appendix_b"}}</h2>
  <dl class="ca-defs">
    <div><dt>{{t "term_dok"}}</dt><dd>{{t "term_dok_def"}}</dd></div>
    <div><dt>{{t "term_status"}}</dt><dd>{{t "term_status_def"}}</dd></div>
    <div><dt>{{t "term_rule_id"}}</dt><dd>{{t "term_rule_id_def"}}</dd></div>
    <div><dt>{{t "term_anchor"}}</dt><dd>{{t "term_anchor_def"}}</dd></div>
  </dl>
</section>

<section class="ca-section ca-appendix" id="appendix-c">
  <h2 class="ca-h2">{{t "appendix_c"}}</h2>
  <table class="ca-kv ca-kv--plain">
    <tbody>
      <tr><th scope="row">{{t "gen_template"}}</th><td>{{t "gen_template_value"}}</td></tr>
      <tr><th scope="row">{{t "gen_asof"}}</th><td>{{format_date generated_at}}</td></tr>
      <tr><th scope="row">{{t "gen_features"}}</th><td>{{len doks}}</td></tr>
      <tr><th scope="row">{{t "gen_rules"}}</th><td>{{len (expand_rules doks)}}</td></tr>
    </tbody>
  </table>
  <p class="ca-disclaimer">{{t "disclaimer"}}</p>
</section>

<footer class="ca-footer">
  <span>{{translate workspace.name}} · {{t "doc_title"}}</span>
  <span>{{#if variables.classification}}{{variables.classification}} · {{/if}}{{format_date generated_at}}</span>
</footer>
