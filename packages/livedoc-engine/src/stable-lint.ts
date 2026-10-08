import { marked } from 'marked';
import type { TemplateManifest } from './template-manifest.js';
import { EngineError } from './errors.js';
import { findSourcePaths, type PatternMatch } from './public-copy-patterns.js';

export type StableLintViolation = {
  code: 'INCOMPLETE_COPY' | 'INTERNAL_IDENTIFIER' | 'SOURCE_PATH' | 'FALSE_FRESHNESS' | 'STRUCTURAL_RAW_HTML' | 'IMPLEMENTATION_DETAIL';
  message: string;
  excerpt: string;
};

export class StableLintError extends EngineError {
  constructor(public readonly violations: StableLintViolation[]) {
    super({
      code: 'STABLE_LINT_FAILED',
      message: `Stable artifact lint failed with ${violations.length} violation${violations.length === 1 ? '' : 's'}`,
    });
    this.name = 'StableLintError';
  }
}

type LintRule = {
  code: StableLintViolation['code'];
  message: string;
  find: (source: string) => Iterable<PatternMatch>;
};

function matching(pattern: RegExp): (source: string) => Iterable<PatternMatch> {
  return (source) => [...source.matchAll(pattern)].map((match) => ({ index: match.index ?? 0, text: match[0] }));
}

/**
 * Developer-only terms that must not reach a stable artifact.
 *
 * The CamelCase alternative is `[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*`: a capitalised
 * word, a second capital, then the rest of the word. It was once written with
 * the tail repeated — `(?:[A-Z][A-Za-z0-9]*)+` — which names the same strings,
 * because the tail's own class already admits capitals. That form let the
 * engine split a run of capitals in every possible way before giving up, so a
 * publication name such as "Aa" + forty capitals + "_" did not finish.
 *
 * The "auto-suggested from … scan" alternative had the same kind of fault on a
 * smaller scale: an optional word between two whitespace repetitions left them
 * adjacent when the word was absent, so a long whitespace run after "from" was
 * split every possible way (quadratic; template metadata is not whitespace-
 * collapsed). The word now carries its own trailing whitespace.
 *
 * Keep every repeated group here unambiguous — one way to match — because the
 * text it reads is written by a workspace.
 */
export const INTERNAL_IDENTIFIER_PATTERN = /\b(?:user_actions(?:\.steps)?|business_rules|acceptance_criteria|source_anchors|topology\.edges|editingBanner|sourceAnchors?|dokId|termRef|userActions|businessRules|acceptanceCriteria|TermRef|Handlebars|DOM|null|Doks?|ROLE-[A-Z0-9_-]+|[Aa]uto[- ]suggested(?:\s+from\s+(?:a\s+)?(?:(?:code|repository|workspace)\s*)?scan)?|[Gg]enerated\s+from\s+(?:a\s+)?(?:code|repository|workspace)\s+scan|(?:high|medium|low)\s+confidence|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|(?:use|has|is)[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*(?:Id|Email))\b|_meta\b/gu;
// Public file-format names are customer vocabulary. Keep exact matching: an
// implementation symbol such as WebPEncoder must still be checked below.
const PUBLIC_FILE_FORMATS = ['JPEG', 'PNG', 'WebP', 'HEIC', 'HEIF'] as const;

const RULES: LintRule[] = [
  {
    code: 'IMPLEMENTATION_DETAIL',
    message: 'Customer output describes internal invitation-address implementation details.',
    find: matching(/내부\s*초대용\s*(?:이메일\s*)?주소|\b(?:synthetic\s+e-?mail(?:\s+address)?|internal\s+(?:invitation|invite)\s+(?:e-?mail\s+)?address)\b/giu),
  },
  {
    code: 'INCOMPLETE_COPY',
    message: 'Stable output contains unfinished or placeholder copy.',
    find: matching(/\b(?:screenshot\s+coming\s+soon|coming\s+soon|not\s+ready(?:\s+yet)?|todo|tbd|placeholder|lorem\s+ipsum)\b|(?:스크린샷\s*)?준비\s*중|아직\s+준비되지|채워\s*주세요/giu),
  },
  {
    code: 'INTERNAL_IDENTIFIER',
    message: 'Stable output exposes an internal identifier or developer-only term. Rewrite implementation terms for readers; for a public name, add an exact match to stable_public_terms in workspace.json. This only exempts identifier patterns, not selected Dok IDs or other copy checks.',
    find: matching(INTERNAL_IDENTIFIER_PATTERN),
  },
  {
    code: 'SOURCE_PATH',
    message: 'Stable output exposes an implementation or repository path.',
    // Runs the source-path expression through its linear matcher.
    find: findSourcePaths,
  },
  {
    code: 'FALSE_FRESHNESS',
    message: 'Stable output makes an unsupported continuous-freshness claim.',
    find: matching(/\balways\s+up(?:-|\s)to(?:-|\s)date\b|\bupdates?\s+automatically\b|\bautomatically\s+(?:updates?|refreshes?)\b|\b(?:updates?|refreshes?|regenerates?)\s+(?:as|when|whenever)\s+(?:the\s+)?(?:product|code)\s+changes\b|자동(?:으로)?\s*(?:갱신|업데이트)|(?:제품|코드)(?:이|가)?\s*바뀌면\s*(?:함께\s*)?(?:갱신|업데이트)/giu),
  },
];

const RAW_HTML_TAG_PATTERN = /<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^>]*>/gu;
const ALLOWED_INLINE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

/**
 * The tags {@link RAW_HTML_TAG_PATTERN} finds in one html token. Every match
 * ends at a ">", so nothing after the last one can match; reading only up to
 * it stops each unterminated opener from scanning the rest of the token, which
 * made a long token of openers quadratic. Indexes are unchanged.
 */
export function rawHtmlTags(raw: string): RegExpMatchArray[] {
  return [...raw.slice(0, raw.lastIndexOf('>') + 1).matchAll(RAW_HTML_TAG_PATTERN)];
}

export function lintStableMarkdown(markdown: string): StableLintViolation[] {
  const violations: StableLintViolation[] = [];
  for (const match of markdown.matchAll(/<(?:[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9_-]+|[A-Z][A-Z0-9_]*)>/gu)) {
    violations.push({
      code: 'INCOMPLETE_COPY',
      message: 'Stable output contains an angle-bracket placeholder.',
      excerpt: makeExcerpt(markdown, match.index ?? 0, match[0].length),
    });
  }
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type !== 'html') return;
    for (const match of rawHtmlTags(token.raw)) {
      const tag = match[1]!.toLowerCase();
      if (ALLOWED_INLINE_HTML_TAGS.has(tag)) continue;
      const index = match.index ?? 0;
      violations.push({
        code: 'STRUCTURAL_RAW_HTML',
        message: 'Stable Markdown contains structural raw HTML.',
        excerpt: makeExcerpt(token.raw, index, match[0].length),
      });
    }
  });
  return violations;
}

export function lintStableArtifact(input: {
  html: string;
  manifest: TemplateManifest;
  provenance: { generatedAt: string; sourceRevision?: string };
  knownDokIds?: readonly string[];
  /** Public proper nouns that INTERNAL_IDENTIFIER must not flag (workspace.stable_public_terms). */
  allowTerms?: readonly string[];
}): StableLintViolation[] {
  const sources = [
    visibleText(input.html),
    publicationMetadata(input.manifest),
    input.provenance.sourceRevision ?? '',
  ];
  const violations: StableLintViolation[] = [];
  const seen = new Set<string>();
  const allowTerms = new Set<string>([...PUBLIC_FILE_FORMATS, ...(input.allowTerms ?? [])]);

  for (const rule of RULES) {
    for (const source of sources) {
      for (const match of rule.find(source)) {
        if (rule.code === 'INTERNAL_IDENTIFIER' && allowTerms.has(match.text)) continue;
        const excerpt = makeExcerpt(source, match.index, match.text.length);
        const key = `${rule.code}\0${excerpt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({ code: rule.code, message: rule.message, excerpt });
      }
    }
  }
  const knownDokIds = [...new Set(input.knownDokIds ?? [])].sort();
  for (const source of sources) {
    for (const dokId of knownDokIds) {
      let offset = 0;
      while (dokId.length > 0) {
        const index = source.indexOf(dokId, offset);
        if (index < 0) break;
        offset = index + dokId.length;
        if (!isIdentifierBoundary(source[index - 1]) || !isIdentifierBoundary(source[offset])) continue;
        const excerpt = makeExcerpt(source, index, dokId.length);
        const key = `INTERNAL_IDENTIFIER\0${excerpt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          code: 'INTERNAL_IDENTIFIER',
          message: 'Stable output exposes a selected internal Dok identifier.',
          excerpt,
        });
      }
    }
  }
  return violations;
}

function isIdentifierBoundary(value: string | undefined): boolean {
  return value === undefined || !/[A-Za-z0-9_-]/u.test(value);
}

function publicationMetadata(manifest: TemplateManifest): string {
  const localized = [
    manifest.display_name,
    manifest.description,
    manifest.audience,
    manifest.purpose,
    manifest.job,
    manifest.required_input,
  ];
  return [
    ...localized.flatMap((value) => value ? Object.values(value) : []),
    ...Object.values(manifest.variables).map((definition) => definition.description),
  ].join('\n');
}

/**
 * The page's text for the lint: comments, style and script elements, then
 * tags removed, entities decoded, whitespace collapsed.
 *
 * The removals were three replacements whose lazy or negated scans each began
 * at every unclosed opener ("<!--", "<style", "<") and read to the end of the
 * page: quadratic in text a document can carry, since the lint reads the page
 * before it is sanitised. They are linear scans now with the same results: the
 * nearest closer ends each element, and once an opener has no closer after it
 * no later opener can have one either.
 */
export function visibleText(html: string): string {
  return decodeEntities(
    stripTags(stripStyleAndScript(stripComments(html))),
  ).replace(/\s+/g, ' ').trim();
}

/** `replace(/<!--[\s\S]*?-->/g, ' ')` */
function stripComments(html: string): string {
  let result = '';
  let position = 0;
  for (let open = html.indexOf('<!--'); open >= 0; open = html.indexOf('<!--', position)) {
    const close = html.indexOf('-->', open + 4);
    if (close < 0) break;
    result += `${html.slice(position, open)} `;
    position = close + 3;
  }
  return result + html.slice(position);
}

const STYLE_OR_SCRIPT_OPEN = /<(?:style|script)\b/gi;
const STYLE_OR_SCRIPT_CLOSE = /<\/(?:style|script)>/gi;

/** `replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, ' ')` */
function stripStyleAndScript(html: string): string {
  let result = '';
  let position = 0;
  for (;;) {
    STYLE_OR_SCRIPT_OPEN.lastIndex = position;
    const open = STYLE_OR_SCRIPT_OPEN.exec(html);
    if (!open) break;
    const openEnd = html.indexOf('>', STYLE_OR_SCRIPT_OPEN.lastIndex);
    if (openEnd < 0) break;
    STYLE_OR_SCRIPT_CLOSE.lastIndex = openEnd + 1;
    const close = STYLE_OR_SCRIPT_CLOSE.exec(html);
    if (!close) break;
    result += `${html.slice(position, open.index)} `;
    position = close.index + close[0].length;
  }
  return result + html.slice(position);
}

/** `replace(/<[^>]*>/g, ' ')` */
function stripTags(html: string): string {
  let result = '';
  let position = 0;
  for (let open = html.indexOf('<'); open >= 0; open = html.indexOf('<', position)) {
    const close = html.indexOf('>', open + 1);
    if (close < 0) break;
    result += `${html.slice(position, open)} `;
    position = close + 1;
  }
  return result + html.slice(position);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function makeExcerpt(source: string, index: number, length: number): string {
  const start = Math.max(0, index - 32);
  const end = Math.min(source.length, index + length + 32);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}
