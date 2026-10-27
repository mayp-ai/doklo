// Dok output locales — the languages `doklo generate` can write Dok prose in.
//
// `workspace.default_locale` names one of these (or any other BCP 47 tag; the
// schema stays a plain string so a workspace is never rejected for a language
// this list has not caught up with). The list exists so that every surface that
// *offers* a choice offers the same one, and so that the generator can name the
// language in its prompt instead of falling back to English for anything that is
// not Korean.
//
// Decision 2026-10-26: one Dok is written in one language (`_meta.locale`). A
// workspace that wants its Hub in another language regenerates it; language
// editions of a single Dok are a later track.

export interface DokLocale {
  /** BCP 47 tag, as stored in `workspace.default_locale` and `_meta.locale`. */
  code: string;
  /** English name — what the generation prompt says ("Respond strictly in …"). */
  language: string;
  /** The language's own name — what a picker shows next to the code. */
  native: string;
  /** The script its prose is written in (ISO 15924; `Hani` covers both Chinese scripts). */
  script: DokScript;
  /**
   * "Write in this language" in the language itself. The generation prompt ends
   * with it: an English instruction alone lost to Korean source for Chinese
   * (review 2026-10-27).
   */
  instruction: string;
}

/** Scripts that tell the listed languages apart: Latin, Hangul, Japanese (kana with Han), Han. */
export type DokScript = 'Latn' | 'Hang' | 'Jpan' | 'Hani';

export const DOK_LOCALES: readonly DokLocale[] = [
  { code: 'en', language: 'English', native: 'English', script: 'Latn',
    instruction: 'Write every reader-facing field in English, even when the source code and its on-screen text are in another language.' },
  { code: 'ko', language: 'Korean (한국어)', native: '한국어', script: 'Hang',
    instruction: '독자가 읽는 모든 필드는 소스 코드와 화면 문구가 다른 언어여도 한국어로 씁니다.' },
  { code: 'ja', language: 'Japanese (日本語)', native: '日本語', script: 'Jpan',
    instruction: 'ソースコードや画面の文言が別の言語であっても、読み手向けの項目はすべて日本語で書いてください。' },
  { code: 'zh-Hans', language: 'Simplified Chinese (简体中文)', native: '简体中文', script: 'Hani',
    instruction: '即使源代码和界面文字使用其他语言，所有面向读者的字段也都必须用简体中文撰写。' },
  { code: 'zh-Hant', language: 'Traditional Chinese (繁體中文)', native: '繁體中文', script: 'Hani',
    instruction: '即使原始碼和介面文字使用其他語言，所有面向讀者的欄位也都必須以繁體中文撰寫。' },
  { code: 'fr', language: 'French (français)', native: 'Français', script: 'Latn',
    instruction: "Rédigez tous les champs destinés au lecteur en français, même si le code source et les textes affichés à l'écran sont dans une autre langue." },
  { code: 'es', language: 'Spanish (español)', native: 'Español', script: 'Latn',
    instruction: 'Redacta en español todos los campos dirigidos al lector, aunque el código fuente y los textos de la pantalla estén en otro idioma.' },
  { code: 'de', language: 'German (Deutsch)', native: 'Deutsch', script: 'Latn',
    instruction: 'Schreibe alle Felder, die Leser sehen, auf Deutsch – auch wenn der Quellcode und die Bildschirmtexte in einer anderen Sprache sind.' },
  { code: 'pt', language: 'Portuguese (português)', native: 'Português', script: 'Latn',
    instruction: 'Escreva em português todos os campos voltados ao leitor, mesmo que o código-fonte e os textos da tela estejam em outro idioma.' },
];

export const DEFAULT_DOK_LOCALE = 'en';

const BCP47_LOOSE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-[A-Za-z]{2}|-\d{3})?$/;

/** `ko_KR` → `ko-KR`, `EN` → `en`, `zh-hans` → `zh-Hans`. Unknown shapes return null. */
export function normalizeLocaleTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().replace(/_/g, '-');
  if (tag === '' || !BCP47_LOOSE.test(tag)) return null;
  const [language, ...rest] = tag.split('-');
  const parts = [language!.toLowerCase()];
  for (const part of rest) {
    if (part.length === 4) parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    else parts.push(part.toUpperCase());
  }
  return parts.join('-');
}

export function findDokLocale(code: string | null | undefined): DokLocale | undefined {
  const tag = normalizeLocaleTag(code);
  if (tag === null) return undefined;
  const exact = DOK_LOCALES.find((entry) => entry.code === tag);
  if (exact) return exact;
  // `ko-KR` is Korean. For Chinese the script subtag decides (`zh-Hant-TW`,
  // `zh-Hans-HK`), and only without one does a region pick it.
  const [language, ...subtags] = tag.split('-');
  if (language === 'zh') {
    if (subtags.includes('Hans')) return findDokLocale('zh-Hans');
    if (subtags.includes('Hant') || subtags.some((part) => part === 'TW' || part === 'HK' || part === 'MO')) return findDokLocale('zh-Hant');
    return findDokLocale('zh-Hans');
  }
  return DOK_LOCALES.find((entry) => entry.code === language);
}

export function isKnownDokLocale(code: string | null | undefined): boolean {
  return findDokLocale(code) !== undefined;
}

/**
 * The language name the generation prompt uses. A tag outside the list still
 * gets an instruction the model can follow ("the language tagged `nl`") rather
 * than a silent fall-through to English.
 */
export function dokLanguageName(code: string | null | undefined): string {
  const known = findDokLocale(code);
  if (known) return known.language;
  const tag = normalizeLocaleTag(code);
  return tag === null ? 'English' : `the language with BCP 47 tag \`${tag}\``;
}

/** The canonical tag for a loosely written one — `ko_KR` → `ko`, `zh-TW` → `zh-Hant`. */
export function canonicalDokLocale(code: string | null | undefined): string {
  const known = findDokLocale(code);
  if (known) return known.code;
  return normalizeLocaleTag(code) ?? DEFAULT_DOK_LOCALE;
}

// Quotations, parentheses and code keep an on-screen label in the product's own
// language, so they are not evidence of the language the prose is written in.
// A single quote counts only after a space or bracket: `l'invitation` is French.
const NOT_PROSE = /`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|«[^»]*»|「[^」]*」|『[^』]*』|\([^)]*\)|（[^）]*）|(?<=^|[\s(:,])'[^'\n]*'/gu;

/** Fewer CJK characters plus Latin words than this is too little prose to name a script. */
const PROSE_SCRIPT_MIN_UNITS = 20;

/** Letters per script outside quotations, parentheses and code; Latin counted in words. */
export interface ProseScriptCounts {
  hangul: number;
  kana: number;
  han: number;
  latinWords: number;
}

export function proseScriptCounts(texts: readonly string[]): ProseScriptCounts {
  const counts: ProseScriptCounts = { hangul: 0, kana: 0, han: 0, latinWords: 0 };
  for (const text of texts) {
    const prose = text.replace(NOT_PROSE, ' ');
    counts.hangul += prose.match(/\p{Script=Hangul}/gu)?.length ?? 0;
    counts.kana += prose.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
    counts.han += prose.match(/\p{Script=Han}/gu)?.length ?? 0;
    counts.latinWords += prose.match(/\p{Script=Latin}+/gu)?.length ?? 0;
  }
  return counts;
}

/**
 * The script most of this prose is written in, or null when there is too little
 * of it to say. One CJK character weighs as much as one Latin word: the terms
 * and identifiers CJK prose carries are words, and Latin prose carries CJK only
 * in quotations. Han with a tenth or more of kana is Japanese.
 */
export function proseScript(texts: readonly string[]): DokScript | null {
  const { hangul, kana, han, latinWords } = proseScriptCounts(texts);
  const cjk = hangul + kana + han;
  if (cjk + latinWords < PROSE_SCRIPT_MIN_UNITS) return null;
  if (cjk < latinWords) return 'Latn';
  if (kana * 10 >= cjk) return 'Jpan';
  return hangul >= han ? 'Hang' : 'Hani';
}

/**
 * Whether a short text, a title or a label, carries letters its language does
 * not write with: Hangul or kana in Chinese, Hangul in Japanese, kana or Han
 * without Hangul in Korean, and CJK without a single Latin word in a Latin
 * language. Too short for `proseScript`, and one stray letter is enough —
 * "방案行程管理" was a Chinese title (review 2026-10-27).
 */
export function hasForeignScript(text: string, script: DokScript): boolean {
  const { hangul, kana, han, latinWords } = proseScriptCounts([text]);
  switch (script) {
    case 'Hani': return hangul > 0 || kana > 0;
    case 'Jpan': return hangul > 0;
    case 'Hang': return kana > 0 || (han > 0 && hangul === 0);
    case 'Latn': return hangul + kana + han > 0 && latinWords === 0;
  }
}
