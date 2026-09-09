import type Handlebars from 'handlebars';
import { resolveTranslatable, type Translatable, type TranslateContext, type TranslateCollector } from '@doklo-beta/core';
import type { TemplateOutputSource } from '../template-manifest.js';

/**
 * Render context fields that helpers read from the Handlebars data root frame.
 * Render orchestration (render.ts) populates these before compile time.
 */
export interface HelperRoot {
  __locale: string;
  __primaryLocale: string;
  __lexicon: TranslateContext['lexicon'];
  __roles: TranslateContext['roles'];
  __strings?: Record<string, Record<string, string>>;
  __defaultLocale?: string;
  __stringsMissing?: Set<string>;
  __collector?: TranslateCollector;
  /** Source syntax of the body currently being rendered. */
  __outputSource?: TemplateOutputSource;
  /** Project-supplied dev-jargon → operator-language substitutions (audience_text). */
  __audienceDictionary?: ReadonlyArray<readonly [string, string]>;
}

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  const root = options.data?.root ?? context;
  return root as HelperRoot;
}

export function registerTranslate(hb: typeof Handlebars): void {
  /**
   * {{translate value}} — resolve a Translatable to a string in the active locale.
   * Falls back per the core resolver's chain: primary → first available → [TERM:??].
   */
  hb.registerHelper('translate', function (this: unknown, value: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    if (value === undefined || value === null) return '';
    return resolveTranslatable(
      value as Translatable,
      {
        locale: root.__locale,
        primaryLocale: root.__primaryLocale,
        lexicon: root.__lexicon,
        roles: root.__roles,
      },
      root.__collector,
    );
  });
}
