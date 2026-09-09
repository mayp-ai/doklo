// Hardcoded JSX literal extraction for Lexicon term candidates.
//
// Activated when a service has no i18n files (the i18n flow is preferred
// when present). Walks .tsx / .jsx sources, collecting user-visible
// strings from JSX text nodes and string-valued JSX attributes that map
// to rendered UI text (placeholder, label, alt, title, aria-label, …).
//
// Filtering — only keep strings that:
//   • contain ≥ 1 character of the target locale's script (Hangul for ko,
//     CJK for ja/zh, etc.). Pure-ASCII identifiers are skipped, which
//     filters out class names, attribute values, and machine codes.
//   • are at least 2 characters long after trim.
//   • are not pure whitespace / punctuation / digits.
//
// Promotion threshold — a candidate is emitted only if it either:
//   • appears in 2 or more distinct files (recurrence signals a stable
//     domain term that belongs in the dictionary), OR
//   • is at least 12 characters long (long phrases are worth tracking
//     even at a single occurrence — they're usually full sentences).
//
// Output uses the same LexiconTermCandidate shape as the i18n extractor
// so callers can branch on `source` and pick the right `binding.type`
// when writing to lexicon.json.

import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { LexiconTermCandidate } from './lexicon-extractor.js';

/** Local tags describing what kind of UI string a JSX literal looks like.
 *  Deliberately NOT the core LexiconCategory — the Lexicon holds curated
 *  domain terms only; this module is a raw corpus-collection primitive. */
export type JsxStringCategory = 'label' | 'button' | 'error' | 'message' | 'concept';

export interface JsxLexiconTermCandidate extends LexiconTermCandidate {
  source: 'jsx';
  /** Authoritative text in the project's default locale. */
  text: string;
  /** Heuristic UI-string tag inferred from the text shape. */
  category: JsxStringCategory;
  /** Total occurrences across all files (a file with the same text 3
   *  times counts as 3). */
  occurrences: number;
}

export interface ExtractJsxLexiconOptions {
  rootDir: string;
  /** Files to scan, relative to rootDir. Non-`.tsx` / `.jsx` entries are
   *  silently ignored. */
  files: string[];
  /** Locale code attached to the emitted candidates (e.g., "ko"). */
  defaultLocale: string;
  /** Regex matching one character of the target locale's script. The
   *  candidate is rejected if it contains zero such characters.
   *  Default: Hangul syllables (uac00–d7a3), suitable for ko. */
  localeCharRange?: RegExp;
}

/** Attribute names whose string value is rendered to the user. */
const VISIBLE_ATTRS = new Set([
  'placeholder',
  'label',
  'alt',
  'title',
  'aria-label',
  'aria-description',
  'aria-roledescription',
]);

/** Default range: Hangul syllables. Suitable for ko-only projects. */
const DEFAULT_LOCALE_RANGE = /[가-힣]/;

/** Skip strings that are clearly not user-visible text (machine codes,
 *  empty/whitespace, very long blobs that are almost certainly inline
 *  data not display text). */
const MAX_TEXT_LENGTH = 200;

interface TextAcc {
  text: string;
  files: Set<string>;
  occurrences: number;
}

export function extractJsxLexiconCandidates(
  opts: ExtractJsxLexiconOptions,
): JsxLexiconTermCandidate[] {
  const localeRange = opts.localeCharRange ?? DEFAULT_LOCALE_RANGE;
  const project = new Project({
    compilerOptions: { allowJs: true, jsx: 2 },
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
  });

  for (const file of opts.files) {
    if (!file.endsWith('.tsx') && !file.endsWith('.jsx')) continue;
    try {
      project.addSourceFileAtPath(`${opts.rootDir}/${file}`);
    } catch {
      // Unparseable / missing file — skip silently. The scanner already
      // filters most of these out, this catches the rest.
    }
  }

  const acc = new Map<string, TextAcc>();

  for (const sf of project.getSourceFiles()) {
    const filePath = relative(opts.rootDir, sf.getFilePath());

    sf.forEachDescendant((node) => {
      // 1. JSX text nodes: <Button>저장</Button>
      if (node.getKind() === SyntaxKind.JsxText) {
        const raw = node.getText();
        ingest(raw, filePath, acc, localeRange);
        return;
      }
      // 2. JSX attribute string values for user-visible attrs.
      //    e.g., <input placeholder="검색어를 입력하세요" />
      if (Node.isJsxAttribute(node)) {
        const name = node.getNameNode().getText();
        if (!VISIBLE_ATTRS.has(name)) return;
        const initializer = node.getInitializer();
        if (!initializer) return;

        if (Node.isStringLiteral(initializer)) {
          ingest(initializer.getLiteralText(), filePath, acc, localeRange);
        } else if (Node.isJsxExpression(initializer)) {
          // {"..."}  or  {`...`}  — pick up the literal inside.
          const expr = initializer.getExpression();
          if (expr && Node.isStringLiteral(expr)) {
            ingest(expr.getLiteralText(), filePath, acc, localeRange);
          } else if (expr && Node.isNoSubstitutionTemplateLiteral(expr)) {
            ingest(expr.getLiteralText(), filePath, acc, localeRange);
          }
        }
      }
    });
  }

  const results: JsxLexiconTermCandidate[] = [];
  for (const entry of acc.values()) {
    if (!shouldPromote(entry)) continue;
    const termId = textToTermId(entry.text, opts.defaultLocale);
    const category = inferCategory(entry.text);
    results.push({
      source: 'jsx',
      text: entry.text,
      term_id: termId,
      key: entry.text, // No i18n key — text itself is the join attribute.
      category,
      files: [...entry.files].sort(),
      supported_locales: [opts.defaultLocale],
      sample_locales: { [opts.defaultLocale]: entry.text },
      occurrences: entry.occurrences,
    });
  }

  // De-duplicate by term_id (different texts hashing to the same prefix is
  // theoretically possible — keep first-seen) and sort.
  const byId = new Map<string, JsxLexiconTermCandidate>();
  for (const r of results) {
    if (!byId.has(r.term_id)) byId.set(r.term_id, r);
  }
  return [...byId.values()].sort((a, b) => a.term_id.localeCompare(b.term_id));
}

function ingest(
  raw: string,
  filePath: string,
  acc: Map<string, TextAcc>,
  localeRange: RegExp,
): void {
  const text = normalize(raw);
  if (!text) return;
  if (text.length > MAX_TEXT_LENGTH) return;
  if (!localeRange.test(text)) return;
  if (!hasMeaningfulCharacter(text)) return;

  const existing = acc.get(text);
  if (existing) {
    existing.files.add(filePath);
    existing.occurrences += 1;
  } else {
    acc.set(text, {
      text,
      files: new Set([filePath]),
      occurrences: 1,
    });
  }
}

/** Trim and collapse interior whitespace runs (so "결제\n   완료" → "결제 완료"). */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Require at least one letter-ish character — pure punctuation / digits
 *  / whitespace strings don't deserve a term. */
function hasMeaningfulCharacter(s: string): boolean {
  return /\p{L}/u.test(s);
}

function shouldPromote(entry: TextAcc): boolean {
  if (entry.files.size >= 2) return true;
  if (entry.text.length >= 12) return true;
  return false;
}

/** Heuristic category from Korean text shape. Anything we can't classify
 *  falls back to `label`. Users can re-categorize in Studio. */
function inferCategory(text: string): JsxStringCategory {
  if (/오류|실패|에러|오류가|실패했|오류입니다/.test(text)) return 'error';
  // Sentence-like endings → message
  if (
    /(되었습니다|하시겠습니까|하시겠어요|입니다|해주세요|해 주세요|주세요)\s*[.?!]?$/.test(
      text,
    )
  ) {
    return 'message';
  }
  // Very short verb forms / single nouns → likely a button
  if (text.length <= 4 && /(하기|보기|취소|확인|저장|삭제|추가|편집|시작|완료|등록|닫기|열기)$/.test(text)) {
    return 'button';
  }
  return 'label';
}

/** Build a deterministic, schema-valid TERM-ID.
 *
 *  Korean text can't be slugified cleanly to ASCII, so we hash it. The
 *  category prefix gives humans a small readability boost; the hash is
 *  short (8 hex chars) but collision-resistant enough for the
 *  candidate counts we generate (~hundreds). The `_locale` segment
 *  documents which language the source text was in.
 *
 *  Examples:
 *    "결제하기"           → "TERM-BTN-KO-7A2C3F18"
 *    "확인하시겠습니까"   → "TERM-MSG-KO-91B4..."
 */
function textToTermId(text: string, locale: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 8).toUpperCase();
  const category = inferCategory(text);
  const catAbbr = ({
    button: 'BTN',
    error: 'ERR',
    message: 'MSG',
    label: 'LBL',
    concept: 'CON',
    navigation: 'NAV',
    role: 'ROLE',
  } as const)[category];
  const localeAbbr = locale.toUpperCase().slice(0, 4).replace(/[^A-Z0-9]/g, '');
  return `TERM-${catAbbr}-${localeAbbr || 'X'}-${hash}`;
}
