<header class="digest-masthead">
  <div class="digest-masthead-inner">
    <span class="digest-brand">{{workspace.name}}</span>
    <span class="digest-masthead-label">{{t "masthead_label"}}</span>
  </div>
</header>

<div class="digest">

  <header class="digest-head">
    <h1 class="digest-title">{{t "title"}}</h1>
    {{#if variables.release_label}}
    <p class="digest-date">{{variables.release_label}}</p>
    {{/if}}
    <p class="digest-intro">{{#if changes.baseline_found}}{{t "intro"}}{{else}}{{t "first_edition_intro"}}{{/if}}</p>
  </header>

{{#if changes.baseline_found}}
{{#unless changes.has_customer_changes}}
  <p class="digest-empty">{{t "no_changes"}}</p>
{{/unless}}
{{#if changes.has_customer_changes}}
  <section class="digest-glance" aria-label="{{t "glance_title"}}">
    <h2 class="digest-glance-title">{{t "glance_title"}}</h2>
    <ul class="digest-glance-list">
{{#if changes.added.length}}
      <li><span class="digest-glance-key digest-glance-key--new">{{t "glance_added"}} {{len changes.added}}</span><span class="digest-glance-names">{{#each changes.added}}{{#if @index}} · {{/if}}{{translate this.name}}{{/each}}</span></li>
{{/if}}
{{#if changes.changed.length}}
      <li><span class="digest-glance-key digest-glance-key--changed">{{t "glance_changed"}} {{len changes.changed}}</span><span class="digest-glance-names">{{#each changes.changed}}{{#if @index}} · {{/if}}{{translate this.name}}{{/each}}</span></li>
{{/if}}
{{#if changes.removed.length}}
      <li><span class="digest-glance-key digest-glance-key--removed">{{t "glance_removed"}} {{len changes.removed}}</span><span class="digest-glance-names">{{#each changes.removed}}{{#if @index}} · {{/if}}{{this.name}}{{/each}}</span></li>
{{/if}}
    </ul>
  </section>
{{/if}}
{{#each changes.added}}
{{#if (lt @index 2)}}
  <article class="digest-feature" id="{{this.dok_id}}">
    <h2 class="digest-feature-title">{{translate this.name}}</h2>
    <p class="digest-feature-body">{{audience_text (translate this.description)}}</p>
{{#if ../variables.help_base_url}}
    <p class="digest-feature-link"><a href="{{../variables.help_base_url}}/{{this.dok_id}}.html">{{t "learn_more"}}</a></p>
{{/if}}
  </article>
{{/if}}
{{/each}}
{{#if (gt changes.added.length 2)}}
  <section class="digest-group">
    <h3 class="digest-group-title">{{t "section_added_more"}}</h3>
    <ul class="digest-list">
{{#each changes.added}}
{{#if (gte @index 2)}}
      <li><strong>{{translate this.name}}</strong> — {{audience_text (translate this.description)}}</li>
{{/if}}
{{/each}}
    </ul>
  </section>
{{/if}}
{{#if changes.changed.length}}
  <section class="digest-group">
    <h3 class="digest-group-title">{{t "section_changed"}}</h3>
    <ul class="digest-list">
{{#each changes.changed}}
      <li><strong>{{translate this.name}}</strong> — {{#if (lookup ../changes.notes_text this.dok_id)}}{{lookup ../changes.notes_text this.dok_id}}{{else}}{{t "changed_item_suffix"}}{{/if}}</li>
{{/each}}
    </ul>
  </section>
{{/if}}
{{#if changes.removed.length}}
  <section class="digest-retired">
    <h3 class="digest-group-title">{{t "section_removed"}}</h3>
    <div class="digest-retired-body">
      <ul class="digest-retired-list">
{{#each changes.removed}}
        <li><strong>{{this.name}}</strong> {{t "removed_item_suffix"}}</li>
{{/each}}
      </ul>
    </div>
  </section>
{{/if}}
{{else}}
{{#each doks}}
  <article class="digest-feature digest-feature--catalog" id="{{this.dok_id}}">
    <h2 class="digest-feature-title">{{translate this.name}}</h2>
    <p class="digest-feature-body">{{audience_text (translate this.description)}}</p>
{{#if ../variables.help_base_url}}
    <p class="digest-feature-link"><a href="{{../variables.help_base_url}}/{{this.dok_id}}.html">{{t "learn_more"}}</a></p>
{{/if}}
  </article>
{{/each}}
{{/if}}

  <footer class="digest-foot">
    {{#if variables.support_url}}
    <p class="digest-support">{{t "support_question"}} <a href="{{variables.support_url}}">{{t "support"}}</a></p>
    {{/if}}
    <p class="digest-colophon">{{t "colophon"}}</p>
  </footer>

</div>
