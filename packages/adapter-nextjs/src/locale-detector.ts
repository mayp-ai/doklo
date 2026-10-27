// Project locale detection — what language is this product written for?
//
// Answers the question to settle before the first generation: which language should the Dok prose default to? A Korean-only
// website analysed with `default_locale: en` produces an English Hub nobody
// asked for, so the default is proposed from the repository itself and only
// then from the operator's own language (decisions 2026-07-13 §미결①, closed
// 2026-10-26).
//
// Four signals, strongest first:
//   1. i18n config — next-intl routing/middleware, Next.js `i18n`, next-i18next:
//      `defaultLocale` is an explicit product decision.
//   2. content script — the letters a visitor reads. A site that hardcodes
//      Korean copy in JSX usually still ships `<html lang="en">` from the
//      template, so a non-Latin script in the copy outranks the `lang` attribute.
//      Comments, tests, fixtures and dictionaries are not copy (review 2026-10-27).
//   3. i18n message files — one locale directory means one language.
//   4. `<html lang>` in the root layout / `_document` — last, because
//      `create-next-app` writes `lang="en"` into every project.
//
// Latin-script content is left undetermined on purpose: telling English from
// French or Spanish needs a word list this module does not carry, and a wrong
// guess is worse than letting the caller fall back to the operator's language.
//
// Purely local reads, bounded in count and size. Never throws for a missing or
// unreadable file — detection is a proposal, not a gate.

import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { ts } from 'ts-morph';
import { canonicalDokLocale, normalizeLocaleTag } from '@doklo-beta/core';
import { discoverI18nFiles } from './lexicon-extractor.js';

export type LocaleSignal = 'i18n-config' | 'content' | 'html-lang' | 'i18n-files';

export interface DetectedLocale {
  /** Canonical BCP 47 tag (`ko`, `zh-Hant`), or null when nothing decisive was found. */
  locale: string | null;
  /** Every locale the project appears to ship, `locale` included. Empty when unknown. */
  supported: string[];
  /** Which signal decided `locale`; null when `locale` is null. */
  source: LocaleSignal | null;
  /** Path (relative to the root) of the file the verdict came from, when there is one. */
  evidence: string | null;
}

export interface DetectProjectLocaleOptions {
  /** The service's code root. */
  rootDir: string;
  /**
   * Source files to sample for the content signal, relative to `rootDir` — the
   * scan's `ir.files` when there is one. Without a list the detector walks the
   * root itself, shallowly and with the usual exclusions.
   */
  files?: readonly string[];
}

const NO_LOCALE: DetectedLocale = { locale: null, supported: [], source: null, evidence: null };

// ───────── 1. i18n configuration ─────────────────────────────────

const CONFIG_CANDIDATES = [
  'i18n/routing.ts', 'i18n/routing.js', 'src/i18n/routing.ts', 'src/i18n/routing.js',
  'i18n/config.ts', 'i18n/config.js', 'src/i18n/config.ts', 'src/i18n/config.js',
  'i18n.config.ts', 'i18n.config.js', 'i18n.config.mjs',
  'i18n.ts', 'i18n.js', 'src/i18n.ts', 'src/i18n.js',
  'next-i18next.config.js', 'next-i18next.config.cjs', 'next-i18next.config.mjs',
  'next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts',
  'middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js',
];

const DEFAULT_LOCALE_RE = /\bdefaultLocale\s*[:=]\s*['"`]([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)['"`]/;
const LOCALES_RE = /\blocales\s*[:=]\s*\[([^\]]*)\]/;
const QUOTED_RE = /['"`]([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)['"`]/g;

interface ConfigSignal {
  defaultLocale: string | null;
  locales: string[];
  file: string;
}

function readConfigSignal(rootDir: string): ConfigSignal | null {
  let partial: ConfigSignal | null = null;
  for (const candidate of CONFIG_CANDIDATES) {
    const text = readTextCapped(join(rootDir, candidate));
    if (text === null) continue;
    const defaultMatch = text.match(DEFAULT_LOCALE_RE);
    const localesMatch = text.match(LOCALES_RE);
    if (!defaultMatch && !localesMatch) continue;

    const locales = localesMatch
      ? [...localesMatch[1]!.matchAll(QUOTED_RE)].map((m) => m[1]!)
      : [];
    const signal: ConfigSignal = {
      defaultLocale: defaultMatch?.[1] ?? null,
      locales,
      file: candidate,
    };
    // The first file that names a default decides; one that only lists locales
    // is kept in case nothing else names one.
    if (signal.defaultLocale !== null) return signal;
    partial ??= signal;
  }
  return partial;
}

// ───────── 2. content script ─────────────────────────────────────
//
// What a visitor reads, not what a developer wrote. JSX text and the
// user-facing attributes (`placeholder`, `title`, `alt`, `aria-label`, `label`)
// are visible copy and count in every script, Latin included. Other string and
// template literals count for non-Latin scripts only: an ASCII string is far
// more often a class list, a path or a key than a sentence. Comments are trivia
// to the parser and never count — before 2026-10-27 three Korean comments were
// enough to call an English app Korean. A non-Latin verdict must also outweigh
// the visible Latin copy, so Korean sample data cannot outvote an English page.

const SAMPLE_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.mdx', '.html', '.vue', '.svelte']);
const MAX_SAMPLED_FILES = 400;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_WALKED_DIRS = 2000;
const MAX_WALK_DEPTH = 12;
/** Fewer letters than this is stray text, not a product language. */
const MIN_SCRIPT_LETTERS = 80;
const MIN_DOMINANT_SHARE = 0.6;
const WALK_EXCLUDES = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.doklo', '.turbo', '.vercel',
]);
/**
 * Paths whose text is not the product's copy: tests, fixtures, mocks and seed
 * data, stories, i18n dictionaries (signal 3 reads those), static and vendored
 * assets, minified bundles, and the repository's own documents.
 */
const NOT_COPY = [
  /(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures?|mocks?|seeds?|stories|storybook)\//i,
  /\.(test|spec|stories|story|e2e|mock)\.[cm]?[jt]sx?$/i,
  /(^|\/)(i18n|locales?|messages|translations?|dictionar(?:y|ies)|langs?)\//i,
  /(^|\/)(public|static|vendor|third[-_]party)\//i,
  /\.min\.[cm]?js$/i,
  // The repository's own documents and tooling: a root `docs/` or `scripts/`
  // holds reports, decisions and seed scripts, not pages. (`app/docs/` is a
  // route and stays.)
  /^(docs?|scripts?)\//i,
  /(^|\/)seed[^/]*\.[cm]?[jt]sx?$/i,
];
const COPY_ATTRIBUTES = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label']);

function isProductCopy(file: string): boolean {
  const path = file.split(sep).join('/');
  return SAMPLE_EXTENSIONS.has(extname(path)) && !NOT_COPY.some((pattern) => pattern.test(path));
}

type Script =
  | 'hangul' | 'kana' | 'han' | 'cyrillic' | 'thai' | 'arabic' | 'hebrew' | 'greek' | 'devanagari';

const SCRIPT_LOCALE: Record<Script, string> = {
  hangul: 'ko',
  kana: 'ja',
  han: 'zh-Hans',
  cyrillic: 'ru',
  thai: 'th',
  arabic: 'ar',
  hebrew: 'he',
  greek: 'el',
  devanagari: 'hi',
};

/**
 * Latin letters a single CJK character stands for, roughly — "설정" is
 * "Settings". Used only when a script is weighed against visible Latin copy.
 */
const SCRIPT_WEIGHT: Partial<Record<Script, number>> = { hangul: 3, kana: 2, han: 3 };

/**
 * Characters that exist in only one of the two Chinese scripts, common in
 * product copy. More of the first than the second reads as Traditional.
 */
const TRADITIONAL_ONLY = new Set([...'這個們來時會說對為與開關頁點設選擇單號帳戶碼註冊錄請輸費價訂購買賣確認刪載檔發現從動務項顯網頭圖書記報錯誤傳線際體種業學機電話郵雙舊變歷處導覽尋結間長門問題應該讓還經過']);
const SIMPLIFIED_ONLY = new Set([...'这个们来时会说对为与开关页点设选择单号账户码注册录请输费价订购买卖确认删载档发现从动务项显网头图书记报错误传线际体种业学机电话邮双旧变历处导览寻结间长门问题应该让还经过']);

function scriptOf(code: number): Script | null {
  if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f)) return 'hangul';
  if (code >= 0x3040 && code <= 0x30ff) return 'kana';
  if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) return 'han';
  if (code >= 0x0400 && code <= 0x04ff) return 'cyrillic';
  if (code >= 0x0e00 && code <= 0x0e7f) return 'thai';
  if (code >= 0x0600 && code <= 0x06ff) return 'arabic';
  if (code >= 0x0590 && code <= 0x05ff) return 'hebrew';
  if (code >= 0x0370 && code <= 0x03ff) return 'greek';
  if (code >= 0x0900 && code <= 0x097f) return 'devanagari';
  return null;
}

function isLatinLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7);
}

export interface ScriptTally {
  /** Non-Latin letters by script. */
  counts: Partial<Record<Script, number>>;
  /** Sum of `counts`. */
  total: number;
  /** Latin letters in visible copy (JSX text, user-facing attributes, MDX prose). */
  latin: number;
  /** Han characters only Traditional Chinese writes, and only Simplified writes. */
  traditional: number;
  simplified: number;
}

function emptyTally(): ScriptTally {
  return { counts: {}, total: 0, latin: 0, traditional: 0, simplified: 0 };
}

/**
 * Exposed for tests: count letters by script in one text. `visible` text is
 * copy a visitor reads, and its Latin letters count too; other text only
 * contributes non-Latin scripts.
 */
export function tallyScripts(text: string, into: ScriptTally = emptyTally(), visible = true): ScriptTally {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x0370) {
      if (visible && isLatinLetter(code)) into.latin += 1;
      continue;
    }
    const script = scriptOf(code);
    if (script === null) continue;
    into.counts[script] = (into.counts[script] ?? 0) + 1;
    into.total += 1;
    if (script === 'han') {
      if (TRADITIONAL_ONLY.has(char)) into.traditional += 1;
      else if (SIMPLIFIED_ONLY.has(char)) into.simplified += 1;
    }
  }
  return into;
}

function weighted(script: Script, count: number): number {
  return count * (SCRIPT_WEIGHT[script] ?? 1);
}

function verdictFromTally(tally: ScriptTally): { script: Script; locale: string } | null {
  if (tally.total < MIN_SCRIPT_LETTERS) return null;
  // Kana and Han together are Japanese: the Han share must not be read as Chinese.
  const kana = tally.counts.kana ?? 0;
  const han = tally.counts.han ?? 0;
  if (kana > 0 && kana + han >= tally.total * MIN_DOMINANT_SHARE && kana >= MIN_SCRIPT_LETTERS / 4) {
    return weighted('kana', kana + han) >= tally.latin ? { script: 'kana', locale: SCRIPT_LOCALE.kana } : null;
  }
  let best: Script | null = null;
  let bestCount = 0;
  for (const [script, count] of Object.entries(tally.counts) as [Script, number][]) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  if (best === null || bestCount < tally.total * MIN_DOMINANT_SHARE) return null;
  // The visible Latin copy outweighs it: an English page with Korean strings
  // somewhere is still an English page, and Latin cannot say which language.
  if (weighted(best, bestCount) < tally.latin) return null;
  if (best === 'han') {
    // The characters only one script writes decide; a tie is just "Chinese",
    // for the caller to settle from a declared locale.
    if (tally.traditional !== tally.simplified) return { script: best, locale: tally.traditional > tally.simplified ? 'zh-Hant' : 'zh-Hans' };
    return { script: best, locale: 'zh' };
  }
  return { script: best, locale: SCRIPT_LOCALE[best] };
}

function sampleFiles(rootDir: string, files: readonly string[] | undefined): string[] {
  const picked: string[] = [];
  if (files !== undefined) {
    for (const file of files) {
      if (!isProductCopy(file)) continue;
      picked.push(file);
      if (picked.length >= MAX_SAMPLED_FILES) break;
    }
    return picked;
  }
  let dirs = 0;
  const walk = (dir: string, depth: number): void => {
    if (picked.length >= MAX_SAMPLED_FILES || dirs >= MAX_WALKED_DIRS || depth > MAX_WALK_DEPTH) return;
    dirs += 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (picked.length >= MAX_SAMPLED_FILES) return;
      if (entry.startsWith('.') || WALK_EXCLUDES.has(entry)) continue;
      const abs = join(dir, entry);
      let stat;
      try {
        // Never follow a link: it can leave the root, or loop.
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(abs, depth + 1);
      else if (stat.isFile() && isProductCopy(relative(rootDir, abs))) picked.push(relative(rootDir, abs));
    }
  };
  walk(rootDir, 0);
  return picked;
}

function scriptKindOf(file: string): ts.ScriptKind {
  const extension = extname(file);
  if (extension === '.ts') return ts.ScriptKind.TS;
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  return ts.ScriptKind.JSX;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  return ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'));
}

/** The text of one source file, split into what a visitor reads and every other literal. */
function tallyScriptSource(file: string, text: string, tally: ScriptTally): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      tallyScripts(node.text, tally, true);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!isModuleSpecifier(node)) {
        const attribute = node.parent !== undefined && ts.isJsxAttribute(node.parent) ? node.parent.name.getText(source) : null;
        tallyScripts(node.text, tally, attribute !== null && COPY_ATTRIBUTES.has(attribute));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** Markup and MDX, read without a parser: comments and code blocks out, text between tags visible. */
function tallyMarkup(file: string, text: string, tally: ScriptTally): void {
  let rest = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (extname(file) === '.mdx') {
    rest = rest.replace(/```[\s\S]*?```/g, ' ').replace(/^(?:import|export)\b.*$/gm, ' ');
    tallyScripts(rest, tally, true);
    return;
  }
  rest = rest.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (block) => {
    tallyScripts(block.replace(/\/\/.*$/gm, ' '), tally, false);
    return ' ';
  });
  for (const match of rest.matchAll(/>([^<>]+)</g)) tallyScripts(match[1]!, tally, true);
}

function readContentSignal(
  rootDir: string,
  files: readonly string[] | undefined,
): { locale: string; evidence: string | null } | null {
  const tally = emptyTally();
  let heaviest: { file: string; count: number } | null = null;
  for (const file of sampleFiles(rootDir, files)) {
    const text = readTextCapped(join(rootDir, file));
    if (text === null) continue;
    const before = tally.total;
    try {
      if (['.html', '.vue', '.svelte', '.mdx'].includes(extname(file))) tallyMarkup(file, text, tally);
      else tallyScriptSource(file, text, tally);
    } catch {
      continue;
    }
    const added = tally.total - before;
    if (added > 0 && (heaviest === null || added > heaviest.count)) heaviest = { file, count: added };
  }
  const verdict = verdictFromTally(tally);
  if (verdict === null) return null;
  return { locale: verdict.locale, evidence: heaviest?.file ?? null };
}

// ───────── 3. <html lang> ────────────────────────────────────────

const LAYOUT_CANDIDATES = [
  'app/layout.tsx', 'app/layout.jsx', 'app/layout.js',
  'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js',
  'pages/_document.tsx', 'pages/_document.jsx', 'pages/_document.js',
  'src/pages/_document.tsx', 'src/pages/_document.jsx', 'src/pages/_document.js',
  'index.html', 'public/index.html',
];
const HTML_LANG_RE = /<(?:html|Html)\b[^>]*\slang=["']([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)["']/;

function readHtmlLangSignal(rootDir: string): { locale: string; file: string } | null {
  for (const candidate of LAYOUT_CANDIDATES) {
    const text = readTextCapped(join(rootDir, candidate));
    if (text === null) continue;
    const match = text.match(HTML_LANG_RE);
    if (match) return { locale: match[1]!, file: candidate };
  }
  return null;
}

// ───────── shared ────────────────────────────────────────────────

/** The first 64 KiB of a regular file — never a link, never more than that read. */
function readTextCapped(path: string): string | null {
  let fd: number | null = null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

const LANGUAGE_NAMES = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
  } catch {
    return null;
  }
})();

/** A language subtag ICU can name — `messages/app.json` is a file, not the "app" language. */
function isKnownLanguage(tag: string): boolean {
  if (LANGUAGE_NAMES === null) return true;
  try {
    return LANGUAGE_NAMES.of(tag.split('-')[0]!) !== undefined;
  } catch {
    return false;
  }
}

function canonicalList(raw: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const tag = normalizeLocaleTag(entry);
    if (tag === null || !isKnownLanguage(tag)) continue;
    const canonical = canonicalDokLocale(tag);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Propose the product's default language and the locales it ships.
 *
 * Never throws; a project with no recognisable signal yields `locale: null` so
 * the caller can fall back to the operator's language.
 */
export function detectProjectLocale(opts: DetectProjectLocaleOptions): DetectedLocale {
  try {
    const config = readConfigSignal(opts.rootDir);
    const fileLocales = discoverI18nFiles(opts.rootDir).map((f) => f.locale);
    const supported = canonicalList([...(config?.locales ?? []), ...fileLocales]);

    const finish = (locale: string | null, source: LocaleSignal | null, evidence: string | null): DetectedLocale => {
      if (locale === null) return { ...NO_LOCALE, supported };
      const canonical = canonicalDokLocale(locale);
      return {
        locale: canonical,
        supported: supported.includes(canonical) ? supported : [canonical, ...supported],
        source,
        evidence,
      };
    };

    if (config?.defaultLocale) return finish(config.defaultLocale, 'i18n-config', config.file);

    const html = readHtmlLangSignal(opts.rootDir);
    const content = readContentSignal(opts.rootDir, opts.files);
    if (content !== null) {
      // Han copy alone does not always tell the two Chinese scripts apart; a
      // declared Taiwanese or Hong Kong locale does.
      const declared = [...(html === null ? [] : [canonicalDokLocale(html.locale)]), ...supported];
      const locale = content.locale !== 'zh' ? content.locale
        : declared.includes('zh-Hant') && !declared.includes('zh-Hans') ? 'zh-Hant' : 'zh-Hans';
      return finish(locale, 'content', content.evidence);
    }

    if (supported.length === 1) {
      const evidence = config?.file ?? discoverI18nFiles(opts.rootDir)[0]?.file ?? null;
      return finish(supported[0]!, 'i18n-files', evidence);
    }

    if (html !== null && isKnownLanguage(html.locale)) return finish(html.locale, 'html-lang', html.file);

    return finish(null, null, null);
  } catch {
    return NO_LOCALE;
  }
}
