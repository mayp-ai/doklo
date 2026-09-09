import Handlebars from 'handlebars';
import { registerIaIndex } from './helpers/ia-index.js';
import {
  registerActorLabel,
  registerFormatDate,
  registerMarkdown,
  registerMarkdownEscape,
  registerBlockers,
  registerMathHelpers,
  registerRoleLabel,
  registerServiceLabel,
  registerSurfaceLabel,
  registerT,
  registerTranslate,
  registerUniqueActors,
  registerUserSteps,
  registerGroupByTag,
  registerRulesByType,
  registerRulesFor,
  registerAggregations,
  registerAudienceText,
} from './helpers/index.js';

/**
 * Create a fresh Handlebars instance with all built-in Livedoc helpers
 * registered. Use a fresh instance per render so partial registrations
 * from one template don't leak into another.
 */
export function createEngine(): typeof Handlebars {
  const hb = Handlebars.create();
  registerMathHelpers(hb);
  registerTranslate(hb);
  registerT(hb);
  registerFormatDate(hb);
  registerActorLabel(hb);
  registerRoleLabel(hb);
  registerServiceLabel(hb);
  registerSurfaceLabel(hb);
  registerMarkdown(hb);
  registerMarkdownEscape(hb);
  registerBlockers(hb);
  registerUniqueActors(hb);
  registerUserSteps(hb);
  registerGroupByTag(hb);
  registerRulesByType(hb);
  registerRulesFor(hb);
  registerAggregations(hb);
  registerAudienceText(hb);
  registerIaIndex(hb);
  return hb;
}
