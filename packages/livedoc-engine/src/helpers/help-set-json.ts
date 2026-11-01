import type Handlebars from 'handlebars';
import {
  actorLabel,
  resolveTranslatable,
  type Actor,
  type Dok,
  type ServiceHubSlice,
  type Translatable,
} from '@doklo-beta/core';
import type { HelperRoot } from './translate.js';
import { buildHelpSetModel } from '../help-set-model.js';

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

export function registerHelpSetJson(hb: typeof Handlebars): void {
  /**
   * {{{help_set_json hub.services doks workspaceName}}} — serialize the
   * customer-safe help-set view model (`doklo-help-set@1`) as pretty JSON.
   * Meant as the whole body of a `source: "json"` entry; the json writer
   * re-parses and canonicalizes it, so invalid JSON fails the render.
   */
  hb.registerHelper(
    'help_set_json',
    function (
      this: unknown,
      services: unknown,
      doks: unknown,
      workspaceName: unknown,
      options: Handlebars.HelperOptions,
    ) {
      const root = getRoot(this, options);
      const translate = {
        locale: root.__locale,
        primaryLocale: root.__primaryLocale,
        lexicon: root.__lexicon,
        roles: root.__roles,
      };
      const model = buildHelpSetModel({
        doks: Array.isArray(doks) ? (doks as Dok[]) : [],
        services: Array.isArray(services) ? (services as ServiceHubSlice[]) : [],
        workspaceName: typeof workspaceName === 'string' ? workspaceName : '',
        locale: root.__locale,
        resolve: (value: Translatable) =>
          resolveTranslatable(value, translate, root.__collector),
        actorLabel: (actor: Actor) =>
          actorLabel(actor, translate, root.__collector).text,
        ...(root.__audienceDictionary !== undefined
          ? { audienceDictionary: root.__audienceDictionary }
          : {}),
      });
      return JSON.stringify(model, null, 2);
    },
  );
}
