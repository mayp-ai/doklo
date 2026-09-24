<article id="{{help_html.article_id}}" class="doklo-help" lang="{{help_html.lang}}" aria-labelledby="{{help_html.title_id}}" tabindex="-1">
<header class="help-hero">
  <p class="help-crumb">{{#if variables.index_url}}<a href="{{variables.index_url}}">{{#if help.workspace_name}}{{help.workspace_name}} {{/if}}{{t "eyebrow_suffix"}}</a> › {{help.title}}{{else}}{{#if help.workspace_name}}{{help.workspace_name}} {{/if}}{{t "eyebrow_suffix"}}{{/if}}</p>
  <{{help_html.title_tag}} id="{{help_html.title_id}}" class="help-title" tabindex="-1">{{help.title}}</{{help_html.title_tag}}>
  {{#if help.description}}
  <p class="help-lede">{{help.description}}</p>
  {{/if}}
</header>

{{#if help.steps.length}}
<section id="{{help_html.how_id}}" class="help-section help-section--how" aria-labelledby="{{help_html.how_title_id}}" tabindex="-1">
<{{help_html.section_tag}} id="{{help_html.how_title_id}}" class="help-section-title" tabindex="-1">{{t "section_how"}}</{{help_html.section_tag}}>
<ol class="help-steps">
{{#each help.steps}}
{{#if (eq this.actor.kind "system")}}
<li class="help-step help-step--auto">
<p class="help-step-auto-text"><span class="help-step-auto-label">{{t "auto_step_label"}}</span>{{#if this.outcome}}{{this.outcome}}{{/if}}</p>
{{#if this.preconditions.length}}
<p class="help-step-auto-cond"><span class="help-step-auto-cond-label">{{t "auto_condition_label"}}</span>{{join this.preconditions " · "}}</p>
{{/if}}
</li>
{{else}}
<li class="help-step help-step--user">
{{#if (gt ../help.actors.length 1)}}
<p class="help-step-actor">{{this.actor_label}}</p>
{{/if}}
<p class="help-step-intent">{{this.intent}}</p>
{{#if this.preconditions.length}}
<p class="help-step-pre"><span class="help-step-pre-label">{{t "step_pre_label"}}</span>{{join this.preconditions " · "}}</p>
{{/if}}
{{#if this.outcome}}
<p class="help-step-result"><span class="help-step-result-label">{{t "step_result_label"}}</span>{{this.outcome}}</p>
{{/if}}
{{#unless ../variables.hide_screenshots}}
{{#if ../platforms.length}}
<div class="help-shots-multi">
{{#each ../platforms}}
{{#if (lookup (lookup ../../step_screenshots_by_platform this) ../source_index)}}
<figure class="help-step-screenshot help-shot-pane">
<span class="help-shot-plat help-shot-plat--{{this}}">{{t (concat "platform_" this)}}</span>
<span class="help-shot-wrap">
<img class="help-screenshot-img" src="{{lookup (lookup ../../step_screenshots_by_platform this) ../source_index}}" alt="" loading="lazy">
{{#with (lookup (lookup ../../step_annotations_by_platform this) ../source_index)}}
<span class="help-shot-box" style="left:{{x}}%;top:{{y}}%;width:{{w}}%;height:{{h}}%"></span>
{{/with}}
</span>
</figure>
{{/if}}
{{/each}}
</div>
{{else}}
{{#if (lookup ../step_screenshots this.source_index)}}
<figure class="help-step-screenshot">
<span class="help-shot-wrap">
<img class="help-screenshot-img" src="{{lookup ../step_screenshots this.source_index}}" alt="{{this.intent}}" loading="lazy">
{{#with (lookup ../step_annotations this.source_index)}}
<span class="help-shot-box" style="left:{{x}}%;top:{{y}}%;width:{{w}}%;height:{{h}}%"></span>
{{/with}}
</span>
</figure>
{{/if}}
{{/if}}
{{/unless}}
</li>
{{/if}}
{{/each}}
</ol>
</section>
{{/if}}

{{#if help.rules.length}}
<section id="{{help_html.tips_id}}" class="help-section help-section--tips" aria-labelledby="{{help_html.tips_title_id}}" tabindex="-1">
<{{help_html.section_tag}} id="{{help_html.tips_title_id}}" class="help-section-title" tabindex="-1">{{t "section_tips"}}</{{help_html.section_tag}}>
<ul class="help-tips">
{{#each help.rules}}
<li class="help-tip help-tip--{{this.type}}"><span class="help-tip-type">{{> rule-type-label rule=this}}</span><span class="help-tip-text">{{this.description}}</span></li>
{{/each}}
</ul>
</section>
{{/if}}

{{#if help.criteria.length}}
<section id="{{help_html.done_id}}" class="help-section help-section--done" aria-labelledby="{{help_html.done_title_id}}" tabindex="-1">
<{{help_html.section_tag}} id="{{help_html.done_title_id}}" class="help-section-title" tabindex="-1">{{t "section_done"}}</{{help_html.section_tag}}>
<ul class="help-checks">
{{#each help.criteria}}
<li class="help-check"><span class="help-check-text">{{this.statement}}</span>{{#if this.related_rules.length}}<span class="help-check-rules"><span class="help-check-rules-label">{{t "check_related_rule"}}</span>{{#each (rules_for this.related_rules ../help.rules)}}<span class="help-check-rule help-check-rule--{{this.type}}">{{> rule-type-label rule=this}}</span>{{/each}}</span>{{/if}}</li>
{{/each}}
</ul>
</section>
{{/if}}

{{#if variables.support_url}}
<footer class="help-feedback">
<p class="help-feedback-title">{{t "feedback_title"}}</p>
<p class="help-feedback-body">{{t "feedback_body"}} <a class="help-feedback-cta" href="{{variables.support_url}}">{{t "feedback_cta"}}</a></p>
</footer>
{{/if}}
</article>
