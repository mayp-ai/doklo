<header class="hc-masthead">
  <div class="hc-masthead-inner">
    <span class="hc-brand">{{workspace.name}}</span>
    <span class="hc-masthead-label">{{t "title"}}</span>
  </div>
</header>

<div class="hc">

  <section class="hc-hero">
    <h1 class="hc-hero-title">{{t "hero"}}</h1>
    <p class="hc-hero-intro">{{t "intro"}}</p>
  </section>

{{#with (help_categories hub.services doks variables.link_extension variables.link_prefix)}}
{{#if this.categories.length}}
  <section class="hc-grid">
{{#each this.categories}}
    <article class="hc-card">
      <h2 class="hc-card-title">{{translate this.label}}</h2>
      <p class="hc-card-count">{{t "count_before"}}{{this.count}}{{#if (eq this.count 1)}}{{t "count_after_one"}}{{else}}{{t "count_after_many"}}{{/if}}</p>
      <ul class="hc-card-list">
{{#each this.articles}}
        <li><a href="{{this.href}}">{{translate this.dok.name}}</a></li>
{{/each}}
      </ul>
    </article>
{{/each}}
  </section>
{{/if}}
{{#if this.unplaced.length}}
  <section class="hc-other">
    <h2 class="hc-other-title">{{t "section_other"}}</h2>
    <ul class="hc-other-list">
{{#each this.unplaced}}
      <li><a href="{{this.href}}">{{translate this.dok.name}}</a></li>
{{/each}}
    </ul>
  </section>
{{/if}}
{{#unless this.categories.length}}{{#unless this.unplaced.length}}
  <p class="hc-empty">{{t "empty"}}</p>
{{/unless}}{{/unless}}
{{/with}}

  <footer class="hc-foot">
    {{#if variables.support_url}}
    <p class="hc-support">{{t "support_question"}} <a href="{{variables.support_url}}">{{t "support"}}</a></p>
    {{/if}}
    <p class="hc-colophon">{{t "colophon"}}</p>
  </footer>

</div>
