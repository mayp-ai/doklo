{{!-- feature-spec v1 — HTML. One delivery-grade functional specification for the whole Hub. --}}
<header class="fs-cover">
  {{#if variables.organization}}<p class="fs-cover-eyebrow">{{variables.organization}}</p>{{/if}}
  <h1 class="fs-cover-title">{{default variables.document_title (t "doc_title")}}</h1>
  <p class="fs-cover-system">{{default variables.system_name (translate workspace.name)}}</p>
  <p class="fs-cover-kind">{{t "doc_kind"}}</p>

  <table class="fs-kv">
    <tbody>
      {{#if variables.project_name}}<tr><th scope="row">{{t "cover_project"}}</th><td>{{variables.project_name}}</td></tr>{{/if}}
      <tr><th scope="row">{{t "cover_system"}}</th><td>{{default variables.system_name (translate workspace.name)}}</td></tr>
      {{#if variables.organization}}<tr><th scope="row">{{t "cover_org"}}</th><td>{{variables.organization}}</td></tr>{{/if}}
      <tr><th scope="row">{{t "cover_version"}}</th><td>{{default variables.document_version "1.0"}}</td></tr>
      <tr><th scope="row">{{t "cover_asof"}}</th><td>{{format_date generated_at}}</td></tr>
      {{#if variables.classification}}<tr><th scope="row">{{t "cover_classification"}}</th><td>{{variables.classification}}</td></tr>{{/if}}
      <tr><th scope="row">{{t "cover_scope"}}</th><td>{{t "cover_scope_pre"}}{{len doks}}{{t "cover_scope_mid1"}}{{len (expand_rules doks)}}{{t "cover_scope_mid2"}}{{len (expand_acs doks)}}{{t "cover_scope_post"}}</td></tr>
    </tbody>
  </table>

  <table class="fs-signoff" aria-label="{{t "signoff_title"}}">
    <caption>{{t "signoff_title"}}</caption>
    <thead><tr><th scope="col">{{t "signoff_role"}}</th><th scope="col">{{t "signoff_name"}}</th><th scope="col">{{t "signoff_date"}}</th><th scope="col">{{t "signoff_sign"}}</th></tr></thead>
    <tbody>
      <tr><th scope="row">{{t "signoff_author"}}</th><td>{{variables.prepared_by}}</td><td></td><td></td></tr>
      <tr><th scope="row">{{t "signoff_reviewer"}}</th><td>{{variables.reviewed_by}}</td><td></td><td></td></tr>
      <tr><th scope="row">{{t "signoff_approver"}}</th><td>{{variables.approved_by}}</td><td></td><td></td></tr>
    </tbody>
  </table>

  <table class="fs-history" aria-label="{{t "history_title"}}">
    <caption>{{t "history_title"}}</caption>
    <thead><tr><th scope="col">{{t "col_version"}}</th><th scope="col">{{t "col_date"}}</th><th scope="col">{{t "col_change"}}</th><th scope="col">{{t "col_author"}}</th></tr></thead>
    <tbody><tr><td>{{default variables.document_version "1.0"}}</td><td>{{format_date generated_at}}</td><td>{{t "history_change_pre"}}{{format_date generated_at}}{{t "history_change_post"}}</td><td>{{#if variables.prepared_by}}{{variables.prepared_by}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td></tr></tbody>
  </table>
</header>

<nav class="fs-toc" aria-label="{{t "toc_title"}}">
  <h2 class="fs-toc-title">{{t "toc_title"}}</h2>
  <ol class="fs-toc-list">
    <li><a href="#s1">{{t "s1"}}</a></li>
    {{#if variables.include_structure}}<li><a href="#s2">{{t "s2"}}</a></li>{{/if}}
    {{#if variables.include_catalog}}<li><a href="#s3">{{t "s3"}}</a></li>{{/if}}
    {{#if variables.include_details}}
    <li><a href="#s4">{{t "s4"}}</a>
      <ol class="fs-toc-sub">{{#each doks}}<li><a href="#f-{{this.dok_id}}">4.{{add @index 1}} {{translate this.name}}</a></li>{{/each}}</ol>
    </li>
    {{#if (add (len (rules_by_type doks "restriction")) (len (rules_by_type doks "policy")))}}<li><a href="#s5">{{t "s5"}}</a></li>{{/if}}
    {{/if}}
    {{#if variables.include_appendix}}
    <li><a href="#appendix-a">{{t "appendix_a"}}</a></li>
    {{#if hub.lexicon.terms.length}}<li><a href="#appendix-b">{{t "appendix_b"}}</a></li>{{/if}}
    {{/if}}
  </ol>
</nav>

<section class="fs-section" id="s1">
  <h2 class="fs-h2">{{t "s1"}}</h2>

  <h3 class="fs-h3">{{t "s1_1"}}</h3>
  <p>{{t "s1_1_body_pre"}}<strong>{{default variables.system_name (translate workspace.name)}}</strong>{{t "s1_1_body_post"}}</p>

  <h3 class="fs-h3">{{t "s1_2"}}</h3>
  <p>{{t "s1_2_body"}}</p>
  <table class="fs-table fs-table--compact fs-scope">
    <tbody>
      <tr><th scope="row">{{t "scope_total"}}</th><td class="t-num">{{len doks}}</td>
          <th scope="row">{{t "scope_active"}}</th><td class="t-num">{{len (where_status doks "active")}}</td>
          <th scope="row">{{t "scope_pending"}}</th><td class="t-num">{{add (len (where_status doks "draft")) (len (where_status doks "review"))}}</td>
          <th scope="row">{{t "scope_planned"}}</th><td class="t-num">{{len (where_status doks "planned")}}</td></tr>
      <tr><th scope="row">{{t "scope_rules"}}</th><td class="t-num">{{len (expand_rules doks)}}</td>
          <th scope="row">{{t "scope_acs"}}</th><td class="t-num">{{len (expand_acs doks)}}</td>
          <th scope="row">{{t "col_service"}}</th><td class="t-num">{{len workspace.services}}</td>
          <th scope="row">{{t "col_role_name"}}</th><td class="t-num">{{len hub.roles.roles}}</td></tr>
    </tbody>
  </table>

  <h3 class="fs-h3">{{t "s1_3"}}</h3>
  <p>{{t "s1_3_body"}}</p>

  <h3 class="fs-h3">{{t "s1_4"}}</h3>
  <dl class="fs-defs">
    <div><dt>{{t "notation_feature_id"}}</dt><dd>{{t "notation_feature_id_def"}}</dd></div>
    <div><dt>{{t "notation_rule_id"}}</dt><dd>{{t "notation_rule_id_def"}}</dd></div>
    <div><dt>{{t "notation_ac_id"}}</dt><dd>{{t "notation_ac_id_def"}}</dd></div>
    <div><dt>{{t "notation_status"}}</dt><dd>{{t "notation_status_def"}}</dd></div>
    <div><dt>{{t "notation_rule_type"}}</dt><dd>{{t "notation_rule_type_def"}}</dd></div>
    {{#if variables.include_structure}}{{#if hub.roles.roles.length}}<div><dt>{{t "notation_matrix"}}</dt><dd>{{t "notation_matrix_def"}}</dd></div>{{/if}}{{/if}}
  </dl>
</section>

{{#if variables.include_structure}}
<section class="fs-section" id="s2">
  <h2 class="fs-h2">{{t "s2"}}</h2>

  <h3 class="fs-h3">{{t "s2_1"}}</h3>
  <table class="fs-table fs-table--services">
    <colgroup><col class="c-id"><col class="c-kind"><col class="c-desc"></colgroup>
    <thead><tr><th>{{t "col_service"}}</th><th>{{t "col_service_type"}}</th><th>{{t "col_desc"}}</th></tr></thead>
    <tbody>
      {{#each workspace.services}}
      <tr><td class="t-id"><code>{{this.service_id}}</code></td><td>{{> service-type-label type=this.type}}</td><td>{{#if this.description}}{{this.description}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td></tr>
      {{/each}}
    </tbody>
  </table>

  <h3 class="fs-h3">{{t "s2_2"}}</h3>
  {{#with (ia_index hub.services doks ".html")}}
  {{#if this.sections.length}}
  <p>{{t "s2_2_body"}}</p>
  {{#each this.sections}}
  <table class="fs-table fs-table--ia">
    <caption><code>{{this.service_id}}</code></caption>
    <colgroup><col class="c-menu"><col class="c-path"><col class="c-feat"></colgroup>
    <thead><tr><th>{{t "col_menu"}}</th><th>{{t "col_path"}}</th><th>{{t "col_feature"}}</th></tr></thead>
    <tbody>
      {{> ia-rows nodes=this.nodes depth=0}}
    </tbody>
  </table>
  {{/each}}
  {{#if this.unplaced.length}}
  <p class="fs-note">{{t "ia_unplaced"}}: {{#each this.unplaced}}{{#if @index}}, {{/if}}{{translate this.dok.name}} <span class="t-id-inline">{{this.dok.dok_id}}</span>{{/each}}</p>
  {{/if}}
  {{else}}
  <p class="fs-none-note">{{t "ia_none"}}</p>
  {{/if}}
  {{/with}}

  <h3 class="fs-h3">{{t "s2_3"}}</h3>
  {{#if hub.roles.roles.length}}
  <table class="fs-table fs-table--roles">
    <colgroup><col class="c-id"><col class="c-name"><col class="c-kind"><col class="c-scope"><col class="c-desc"><col class="c-cnt"></colgroup>
    <thead><tr><th>{{t "col_role_id"}}</th><th>{{t "col_role_name"}}</th><th>{{t "col_role_kind"}}</th><th>{{t "col_role_scope"}}</th><th>{{t "col_desc"}}</th><th class="t-num">{{t "col_role_feats"}}</th></tr></thead>
    <tbody>
      {{#each hub.roles.roles}}
      <tr>
        <td class="t-id"><code>{{this.role_id}}</code></td>
        <td class="t-strong">{{translate this.name}}</td>
        <td>{{> role-kind-label kind=this.kind}}</td>
        <td>{{> role-scope-label scope=this.scope}}</td>
        <td>{{#if this.description}}{{this.description}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
        <td class="t-num">{{len (doks_for_role ../doks this.role_id)}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <h3 class="fs-h3">{{t "s2_4"}}</h3>
  <p>{{t "s2_4_body"}}</p>
  <table class="fs-table fs-matrix">
    <thead><tr><th>{{t "col_feature"}}</th>{{#each hub.roles.roles}}<th class="t-center">{{translate this.name}}</th>{{/each}}</tr></thead>
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
  <p class="fs-legend"><span class="fs-legend-title">{{t "legend_title"}}</span> <span class="m-both">●</span> {{t "legend_both"}} · <span class="m-steps">○</span> {{t "legend_steps"}} · <span class="m-rules">△</span> {{t "legend_rules"}} · <span class="m-none">–</span> {{t "legend_none"}}</p>
  {{else}}
  <p class="fs-none-note">{{t "roles_none"}}</p>
  {{/if}}
</section>
{{/if}}

{{#if variables.include_catalog}}
<section class="fs-section" id="s3">
  <h2 class="fs-h2">{{t "s3"}}</h2>
  <p>{{t "s3_body"}}{{#if variables.include_details}}. {{t "s3_detail_ref"}}{{/if}}</p>
  <table class="fs-table fs-table--catalog">
    <colgroup><col class="c-group"><col class="c-id"><col class="c-name"><col class="c-actors"><col class="c-status"><col class="c-prio"><col class="c-cnt"><col class="c-cnt"><col class="c-cnt"></colgroup>
    <thead><tr><th>{{t "col_group"}}</th><th>{{t "col_feature_id"}}</th><th>{{t "col_feature_name"}}</th><th>{{t "col_actors"}}</th><th>{{t "col_status"}}</th><th>{{t "col_priority"}}</th><th class="t-num">{{t "col_steps"}}</th><th class="t-num">{{t "col_rules"}}</th><th class="t-num">{{t "col_acs"}}</th></tr></thead>
    <tbody>
    {{#with (help_categories hub.services doks ".html")}}
    {{#each this.categories}}
      {{#each this.articles}}
      <tr>
        {{#if @first}}<th scope="rowgroup" rowspan="{{../count}}" class="fs-group">{{translate ../label}}</th>{{/if}}
        <td class="t-id"><a href="#f-{{this.dok.dok_id}}"><code>{{this.dok.dok_id}}</code></a></td>
        <td class="t-strong">{{translate this.dok.name}}</td>
        <td class="t-roles">{{> role-list steps=this.dok.user_actions.steps}}</td>
        <td><span class="status status--{{this.dok.status}}">{{> status-label status=this.dok.status}}</span></td>
        <td class="t-prio">{{#if this.dok.priority.impact}}{{> impact-label impact=this.dok.priority.impact}}{{#if this.dok.priority.blast_radius}} · {{> blast-label blast=this.dok.priority.blast_radius}}{{/if}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
        <td class="t-num">{{len (user_steps this.dok.user_actions.steps)}}</td>
        <td class="t-num">{{len this.dok.business_rules.rules}}</td>
        <td class="t-num">{{len this.dok.acceptance_criteria.criteria}}</td>
      </tr>
      {{/each}}
    {{/each}}
    {{#each this.unplaced}}
      <tr>
        {{#if @first}}<th scope="rowgroup" rowspan="{{len ../unplaced}}" class="fs-group">{{t "group_other"}}</th>{{/if}}
        <td class="t-id"><a href="#f-{{this.dok.dok_id}}"><code>{{this.dok.dok_id}}</code></a></td>
        <td class="t-strong">{{translate this.dok.name}}</td>
        <td class="t-roles">{{> role-list steps=this.dok.user_actions.steps}}</td>
        <td><span class="status status--{{this.dok.status}}">{{> status-label status=this.dok.status}}</span></td>
        <td class="t-prio">{{#if this.dok.priority.impact}}{{> impact-label impact=this.dok.priority.impact}}{{#if this.dok.priority.blast_radius}} · {{> blast-label blast=this.dok.priority.blast_radius}}{{/if}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
        <td class="t-num">{{len (user_steps this.dok.user_actions.steps)}}</td>
        <td class="t-num">{{len this.dok.business_rules.rules}}</td>
        <td class="t-num">{{len this.dok.acceptance_criteria.criteria}}</td>
      </tr>
    {{/each}}
    {{/with}}
    </tbody>
  </table>
</section>
{{/if}}

{{#if variables.include_details}}
<section class="fs-section" id="s4">
  <h2 class="fs-h2">{{t "s4"}}</h2>
  <p>{{t "s4_body"}}</p>

  {{#each doks}}
  <article class="fs-feature" id="f-{{this.dok_id}}">
    <h3 class="fs-h3 fs-feature-title">4.{{add @index 1}} {{translate this.name}} <span class="fs-feature-id">{{this.dok_id}}</span></h3>

    <table class="fs-kv fs-kv--feature">
      <tbody>
        <tr><th scope="row">{{t "d_id"}}</th><td><code>{{this.dok_id}}</code></td>
            <th scope="row">{{t "d_status"}}</th><td><span class="status status--{{this.status}}">{{> status-label status=this.status}}</span></td></tr>
        <tr><th scope="row">{{t "d_services"}}</th><td>{{#each this.surfaces}}{{#if @index}}, {{/if}}<code>{{this}}</code>{{else}}<span class="t-muted">{{t "na"}}</span>{{/each}}</td>
            <th scope="row">{{t "d_priority"}}</th><td>{{#if this.priority.impact}}{{> impact-label impact=this.priority.impact}}{{#if this.priority.blast_radius}} · {{> blast-label blast=this.priority.blast_radius}}{{/if}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td></tr>
        <tr><th scope="row">{{t "d_actors"}}</th><td>{{#each (unique_actors this.user_actions.steps)}}{{#if @index}}, {{/if}}{{actor_label this}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/each}}</td>
            <th scope="row">{{t "d_version"}}</th><td>{{this._meta.version}}</td></tr>
        {{#if this._meta.origins.length}}
        <tr><th scope="row">{{t "d_route"}}</th><td colspan="3">{{#each this._meta.origins}}{{#if this.primary_route}}<code>{{this.primary_route}}</code> {{/if}}{{/each}}</td></tr>
        {{/if}}
        <tr><th scope="row">{{t "d_related"}}</th><td colspan="3" class="fs-rel-cell">{{> related-features dok=this services=../hub.services doks=../doks}}</td></tr>
      </tbody>
    </table>

    <h4 class="fs-h4">{{t "d_desc"}}</h4>
    <p class="fs-desc">{{translate this.description}}</p>

    {{#if this.user_actions.steps.length}}
    <h4 class="fs-h4">{{t "d_steps"}}</h4>
    <table class="fs-table fs-table--steps">
      <colgroup><col class="c-no"><col class="c-actor"><col class="c-action"><col class="c-result"><col class="c-pre"></colgroup>
      <thead><tr><th>{{t "col_no"}}</th><th>{{t "col_actor"}}</th><th>{{t "col_action"}}</th><th>{{t "col_result"}}</th><th>{{t "col_pre"}}</th></tr></thead>
      <tbody>
        {{#each this.user_actions.steps}}
        <tr{{#if (eq this.actor.kind "system")}} class="fs-step--system"{{/if}}>
          <td class="t-num">{{this.order}}</td>
          <td>{{actor_label this.actor}}</td>
          <td>{{translate this.intent}}</td>
          <td>{{translate this.outcome}}</td>
          <td class="t-pre">{{#if this.preconditions.length}}{{join this.preconditions " · "}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td>
        </tr>
        {{/each}}
      </tbody>
    </table>
    {{/if}}

    {{#if this.business_rules.rules.length}}
    <h4 class="fs-h4">{{t "d_rules"}}</h4>
    <table class="fs-table fs-table--rules">
      <colgroup><col class="c-id"><col class="c-type"><col class="c-rule"><col class="c-roles">{{#if ../variables.show_repo_info}}<col class="c-evidence">{{/if}}</colgroup>
      <thead><tr><th>{{t "col_rule_id"}}</th><th>{{t "col_rule_type"}}</th><th>{{t "col_rule"}}</th><th>{{t "col_roles"}}</th>{{#if ../variables.show_repo_info}}<th>{{t "col_evidence"}}</th>{{/if}}</tr></thead>
      <tbody>
        {{#each this.business_rules.rules}}
        <tr>
          <td class="t-id"><code>{{this.id}}</code></td>
          <td>{{> rule-type-label type=this.type}}</td>
          <td>{{translate this.description}}</td>
          <td class="t-roles">{{#if this.applies_to_roles.length}}{{#each this.applies_to_roles}}{{#if @index}}, {{/if}}{{role_label this}}{{/each}}{{else}}<span class="t-muted">{{t "roles_unspecified"}}</span>{{/if}}</td>
          {{#if ../../variables.show_repo_info}}<td class="t-evidence">{{> code-anchor anchor=this.code_anchor}}</td>{{/if}}
        </tr>
        {{/each}}
      </tbody>
    </table>
    {{/if}}

    {{#if this.acceptance_criteria.criteria.length}}
    <h4 class="fs-h4">{{t "d_acs"}}</h4>
    <table class="fs-table fs-table--acs">
      <colgroup><col class="c-id"><col class="c-ac"><col class="c-related"></colgroup>
      <thead><tr><th>{{t "col_ac_id"}}</th><th>{{t "col_ac"}}</th><th>{{t "col_related_rules"}}</th></tr></thead>
      <tbody>
        {{#each this.acceptance_criteria.criteria}}
        <tr>
          <td class="t-id"><code>{{this.id}}</code></td>
          <td>{{translate this.statement}}{{#if this.given}}<span class="fs-gwt"><span class="fs-k">{{t "ac_given"}}</span> {{this.given}}</span>{{/if}}{{#if this.when}}<span class="fs-gwt"><span class="fs-k">{{t "ac_when"}}</span> {{this.when}}</span>{{/if}}{{#if this.then}}<span class="fs-gwt"><span class="fs-k">{{t "ac_then"}}</span> {{this.then}}</span>{{/if}}</td>
          <td class="t-id">{{#each this.related_rules}}{{#if @index}}<br>{{/if}}<code>{{this}}</code>{{else}}<span class="t-muted">{{t "na"}}</span>{{/each}}</td>
        </tr>
        {{/each}}
      </tbody>
    </table>
    {{/if}}

    {{#if this._meta.history.length}}
    <h4 class="fs-h4">{{t "d_history"}}</h4>
    <table class="fs-table fs-table--history">
      <colgroup><col class="c-ver"><col class="c-date"><col class="c-change"><col class="c-author"></colgroup>
      <thead><tr><th>{{t "col_version"}}</th><th>{{t "col_date"}}</th><th>{{t "col_change"}}</th><th>{{t "col_author"}}</th></tr></thead>
      <tbody>
        {{#each this._meta.history}}
        <tr><td class="t-num">{{this.version}}</td><td class="t-date">{{format_date this.date}}</td><td>{{this.change}}</td><td>{{#if this.author}}{{this.author}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/if}}</td></tr>
        {{/each}}
      </tbody>
    </table>
    {{/if}}
  </article>
  {{/each}}
</section>

{{#if (add (len (rules_by_type doks "restriction")) (len (rules_by_type doks "policy")))}}
<section class="fs-section" id="s5">
  <h2 class="fs-h2">{{t "s5"}}</h2>
  <p>{{t "s5_body"}}</p>
  {{#if (len (rules_by_type doks "restriction"))}}
  <h3 class="fs-h3">{{t "s5_1"}}</h3>
  {{> rule-digest doks=doks type="restriction" vars=variables}}
  {{/if}}
  {{#if (len (rules_by_type doks "policy"))}}
  <h3 class="fs-h3">{{t "s5_2"}}</h3>
  {{> rule-digest doks=doks type="policy" vars=variables}}
  {{/if}}
</section>
{{/if}}
{{/if}}

{{#if variables.include_appendix}}
<section class="fs-section fs-appendix" id="appendix-a">
  <h2 class="fs-h2">{{t "appendix_a"}}</h2>
  <p>{{t "appendix_a_body"}}</p>
  <table class="fs-table fs-table--rtm">
    <colgroup><col class="c-id"><col class="c-name"><col class="c-rules"><col class="c-id"><col class="c-ac">{{#if variables.show_repo_info}}<col class="c-program">{{/if}}</colgroup>
    <thead><tr><th>{{t "col_feature_id"}}</th><th>{{t "col_feature_name"}}</th><th>{{t "col_rule_id"}}</th><th>{{t "col_ac_id"}}</th><th>{{t "col_ac"}}</th>{{#if variables.show_repo_info}}<th>{{t "col_program"}}</th>{{/if}}</tr></thead>
    <tbody>
      {{#each (expand_acs doks)}}
      <tr>
        <td class="t-id"><code>{{this.dok.dok_id}}</code></td>
        <td>{{translate this.dok.name}}</td>
        <td class="t-id">{{#each this.rules}}{{#if @index}}<br>{{/if}}<code>{{this.id}}</code>{{else}}<span class="t-muted">{{t "na"}}</span>{{/each}}</td>
        <td class="t-id"><code>{{this.criterion.id}}</code></td>
        <td>{{translate this.criterion.statement}}</td>
        {{#if ../variables.show_repo_info}}<td class="t-program">{{#each this.anchors}}<code>{{this}}</code>{{#unless @last}}<br>{{/unless}}{{else}}<span class="t-muted">{{t "na"}}</span>{{/each}}</td>{{/if}}
      </tr>
      {{/each}}
    </tbody>
  </table>
</section>

{{#if hub.lexicon.terms.length}}
<section class="fs-section fs-appendix" id="appendix-b">
  <h2 class="fs-h2">{{t "appendix_b"}}</h2>
  <table class="fs-table fs-table--glossary">
    <colgroup><col class="c-term"><col class="c-kind"><col class="c-alt"><col class="c-doks"></colgroup>
    <thead><tr><th>{{t "col_term"}}</th><th>{{t "col_term_kind"}}</th><th>{{t "col_term_alt"}}</th><th>{{t "col_term_doks"}}</th></tr></thead>
    <tbody>
      {{#each hub.lexicon.terms}}
      <tr>
        <td class="t-strong">{{#if this.locales}}{{default (lookup this.locales ../locale) (lookup this.locales ../primaryLocale)}}{{else}}{{#if this.snapshot}}{{default (lookup this.snapshot ../locale) (lookup this.snapshot ../primaryLocale)}}{{else}}{{#if this.binding.key}}<code>{{this.binding.key}}</code>{{else}}<code>{{this.term_id}}</code>{{/if}}{{/if}}{{/if}}</td>
        <td>{{#if (eq this.category "role")}}{{t "term_role"}}{{else}}{{t "term_concept"}}{{/if}}</td>
        <td class="t-alt">{{#each this.locales}}{{#unless (eq @key ../../locale)}}<span class="fs-alt"><span class="fs-k">{{@key}}</span> {{this}}</span>{{/unless}}{{/each}}{{#each this.snapshot}}{{#unless (eq @key ../../locale)}}<span class="fs-alt"><span class="fs-k">{{@key}}</span> {{this}}</span>{{/unless}}{{/each}}</td>
        <td class="t-id">{{#each this.related_doks}}{{#if @index}}, {{/if}}<a href="#f-{{this}}"><code>{{this}}</code></a>{{else}}<span class="t-muted">{{t "na"}}</span>{{/each}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>
</section>
{{/if}}
{{/if}}

<footer class="fs-footer">
  <span>{{default variables.system_name (translate workspace.name)}} · {{default variables.document_title (t "doc_title")}}</span>
  <span>{{#if variables.classification}}{{variables.classification}} · {{/if}}{{format_date generated_at}}</span>
</footer>
