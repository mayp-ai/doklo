import type Handlebars from 'handlebars';
import { actorLabel, type Actor } from '@doklo-beta/core';
import type { HelperRoot } from './translate.js';

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

export function registerActorLabel(hb: typeof Handlebars): void {
  /**
   * {{actor_label actor}} — Actor discriminated union → display label.
   * - kind=role → look up role + translate role.name
   * - kind=system → localized "System" / "시스템"
   * - kind=external → label literal as-is
   */
  hb.registerHelper('actor_label', function (this: unknown, actor: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    if (!actor || typeof actor !== 'object') return '';
    return actorLabel(
      actor as Actor,
      {
        locale: root.__locale,
        primaryLocale: root.__primaryLocale,
        lexicon: root.__lexicon,
        roles: root.__roles,
      },
      root.__collector,
    ).text;
  });
}
