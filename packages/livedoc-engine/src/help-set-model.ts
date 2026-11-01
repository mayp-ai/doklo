import type { Actor, Dok, ServiceHubSlice, Translatable } from '@doklo-beta/core';
import { prepareStableHelpCopy } from './stable-help-copy.js';
import type { AudienceDictionary } from './helpers/audience-text.js';
import { buildHelpCategories } from './helpers/ia-index.js';

/**
 * Customer-safe help-set view model — the JSON contract the headless help
 * SDK consumes (`doklo-help-set@1`).
 *
 * Every article body field passes through the same stable-help-copy pipeline
 * as the stable `help-page` template, then gets projected onto an explicit
 * whitelist: raw schema internals (Actor role_refs, BR-/AC- ids,
 * source_anchors, variants) never reach the JSON. `id` is the one structural
 * identifier kept — the SDK needs it for hrefs and keys; it is data, not
 * body copy.
 */
export interface HelpSetStep {
  display_number?: number;
  is_system: boolean;
  actor_label?: string;
  intent?: string;
  outcome?: string;
  preconditions: string[];
  platforms: string[];
}

export interface HelpSetArticle {
  id: string;
  title: string;
  lede?: string;
  actors: Array<{ kind: Actor['kind']; label: string }>;
  steps: HelpSetStep[];
  rules: Array<{ type: string; text: string }>;
  checks: Array<{ text: string }>;
  faq: Array<{ id: string; question: string; answer: string }>;
}

export interface HelpSetCategory {
  label: string;
  path?: string;
  count: number;
  article_ids: string[];
}

export interface HelpSetModel {
  schema: 'doklo-help-set@1';
  workspace: { name: string };
  locale: string;
  categories: HelpSetCategory[];
  articles: HelpSetArticle[];
  unplaced_article_ids: string[];
  /** Doks whose title had no customer-safe wording — recorded, never silent. */
  omitted_dok_ids: string[];
}

export interface BuildHelpSetArgs {
  doks: Dok[];
  services: ServiceHubSlice[];
  workspaceName: string;
  locale: string;
  resolve: (value: Translatable) => string;
  actorLabel: (actor: Actor) => string;
  audienceDictionary?: AudienceDictionary;
}

export function buildHelpSetModel(args: BuildHelpSetArgs): HelpSetModel {
  const articles: HelpSetArticle[] = [];
  const omitted: string[] = [];

  for (const dok of args.doks) {
    const prepared = prepareStableHelpCopy({
      dok,
      workspaceName: args.workspaceName,
      resolve: args.resolve,
      actorLabel: args.actorLabel,
      ...(args.audienceDictionary !== undefined
        ? { audienceDictionary: args.audienceDictionary }
        : {}),
    });
    if (prepared.unsafeTitle) {
      omitted.push(dok.dok_id);
      continue;
    }
    const copy = prepared.copy;
    articles.push({
      id: dok.dok_id,
      title: copy.title,
      ...(copy.description !== undefined ? { lede: copy.description } : {}),
      actors: copy.actors,
      steps: copy.steps.map((step) => {
        const raw = step as {
          actor?: { kind?: string };
          variants?: Array<{ platform?: unknown }>;
        };
        return {
          ...(step.display_number !== undefined
            ? { display_number: step.display_number }
            : {}),
          is_system: raw.actor?.kind === 'system',
          ...(step.actor_label !== undefined ? { actor_label: step.actor_label } : {}),
          ...(step.intent !== undefined ? { intent: step.intent } : {}),
          ...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
          preconditions: step.preconditions,
          platforms: [
            ...new Set(
              (raw.variants ?? [])
                .map((variant) => variant.platform)
                .filter((platform): platform is string => typeof platform === 'string'),
            ),
          ],
        };
      }),
      rules: copy.rules.map((rule) => ({ type: String(rule.type), text: rule.description })),
      checks: copy.criteria.map((criterion) => ({ text: criterion.statement })),
      faq: copy.faq,
    });
  }

  const placed = new Set(articles.map((article) => article.id));
  const placedDoks = args.doks.filter((dok) => placed.has(dok.dok_id));
  const grouped = buildHelpCategories(args.services, placedDoks, '.html');

  return {
    schema: 'doklo-help-set@1',
    workspace: { name: args.workspaceName },
    locale: args.locale,
    categories: grouped.categories.map((category) => ({
      label: args.resolve(category.label),
      ...(category.path !== undefined ? { path: category.path } : {}),
      count: category.count,
      article_ids: category.articles.map((entry) => entry.dok.dok_id),
    })),
    articles,
    unplaced_article_ids: grouped.unplaced.map((entry) => entry.dok.dok_id),
    omitted_dok_ids: omitted,
  };
}
