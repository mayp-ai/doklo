import type Handlebars from 'handlebars';
import type { HelperRoot } from './translate.js';

/**
 * A whitelist of `[pattern, replacement]` phrase substitutions that buffer
 * help-page free text so implementation jargon reaches a non-developer
 * operator as screen-observable language.
 *
 * PROJECT-SUPPLIED — the engine ships the *mechanism*, never the terms. A token
 * like `editingBanner` is meaningful only to the codebase it came from, so the
 * dictionary is loaded per-project (the CLI reads `.doklo/audience-text.json`
 * for the active locale and passes it on the render root). With no dictionary
 * the helper is a no-op, keeping the generic engine free of any one project's
 * identifiers.
 *
 * The real cure is dok-gen emitting operator language at the source; this is a
 * template-output buffer until then.
 */
export type AudienceDictionary = ReadonlyArray<readonly [string, string]>;

/**
 * Substitute whitelisted dev-jargon phrases with operator-observable language.
 * Pure + deterministic. Policy:
 *  - WHITELIST ONLY — tokens outside the dictionary are left untouched
 *    ("don't hide unknown code").
 *  - LONGEST-MATCH FIRST — longer phrases consume their span before shorter
 *    sub-phrases, so partial substitution can't distort meaning.
 *  - Empty dictionary → input returned verbatim (the generic default).
 */
export function audienceText(input: string, dictionary: AudienceDictionary): string {
  if (dictionary.length === 0) return input;
  const sorted = [...dictionary].sort((a, b) => b[0].length - a[0].length);
  let out = input;
  const appliedReplacements = new Set<string>();
  for (const [pattern, replacement] of sorted) {
    if (out.includes(pattern)) {
      out = out.split(pattern).join(replacement);
      appliedReplacements.add(replacement);
    }
  }
  return polishReplacementBoundaries(out, appliedReplacements);
}

function polishReplacementBoundaries(input: string, replacements: ReadonlySet<string>): string {
  let out = input;
  for (const replacement of replacements) {
    if (!replacement) continue;
    out = out.split(`${replacement}(${replacement})`).join(replacement);

    const firstWord = replacement.trim().split(/\s+/u)[0];
    if (firstWord) {
      out = out.split(`${firstWord} ${replacement}`).join(replacement);
    }

    const lastCharacter = replacement.trim().at(-1);
    if (!lastCharacter || !/[가-힣]/u.test(lastCharacter)) continue;
    const hasFinalConsonant = (lastCharacter.charCodeAt(0) - 0xac00) % 28 !== 0;
    const particlePattern = new RegExp(
      `${escapeRegExp(replacement)}(이|가|은|는|을|를|과|와)`,
      'gu',
    );
    out = out.replace(particlePattern, (_match, particle: string) => (
      `${replacement}${correctParticle(particle, hasFinalConsonant)}`
    ));
  }
  return out;
}

function correctParticle(particle: string, hasFinalConsonant: boolean): string {
  const pair = ({
    이: ['이', '가'],
    가: ['이', '가'],
    은: ['은', '는'],
    는: ['은', '는'],
    을: ['을', '를'],
    를: ['을', '를'],
    과: ['과', '와'],
    와: ['과', '와'],
  } as const)[particle as '이' | '가' | '은' | '는' | '을' | '를' | '과' | '와'];
  return pair?.[hasFinalConsonant ? 0 : 1] ?? particle;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function registerAudienceText(hb: typeof Handlebars): void {
  /**
   * {{audience_text (translate ...)}} — buffer help-page free text so code
   * jargon reaches the operator as screen-observable language. The dictionary
   * is read from the render root (`__audienceDictionary`, project-supplied for
   * the active locale); absent or empty → the value passes through unchanged.
   */
  hb.registerHelper('audience_text', function (this: unknown, value: unknown, options: Handlebars.HelperOptions) {
    if (value === undefined || value === null) return '';
    const root = (options?.data?.root ?? this) as HelperRoot | undefined;
    const s = String(value);
    const dict = root?.__audienceDictionary;
    return dict && dict.length > 0 ? audienceText(s, dict) : s;
  });
}
