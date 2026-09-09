import { marked } from 'marked';
import type { TemplateManifest } from './template-manifest.js';
import { EngineError } from './errors.js';
import { SOURCE_PATH_PATTERN_SOURCE } from './public-copy-patterns.js';

export type StableLintViolation = {
  code: 'INCOMPLETE_COPY' | 'INTERNAL_IDENTIFIER' | 'SOURCE_PATH' | 'FALSE_FRESHNESS' | 'STRUCTURAL_RAW_HTML';
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
  pattern: RegExp;
};

const RULES: LintRule[] = [
  {
    code: 'INCOMPLETE_COPY',
    message: 'Stable output contains unfinished or placeholder copy.',
    pattern: /\b(?:screenshot\s+coming\s+soon|coming\s+soon|not\s+ready(?:\s+yet)?|todo|tbd|placeholder|lorem\s+ipsum)\b|(?:스크린샷\s*)?준비\s*중|아직\s+준비되지|채워\s*주세요/giu,
  },
  {
    code: 'INTERNAL_IDENTIFIER',
    message: 'Stable output exposes an internal identifier or developer-only term.',
    pattern: /\b(?:user_actions(?:\.steps)?|business_rules|acceptance_criteria|source_anchors|topology\.edges|editingBanner|sourceAnchors?|dokId|termRef|userActions|businessRules|acceptanceCriteria|TermRef|Handlebars|DOM|null|Doks?|ROLE-[A-Z0-9_-]+|[Aa]uto[- ]suggested(?:\s+from\s+(?:a\s+)?(?:code|repository|workspace)?\s*scan)?|[Gg]enerated\s+from\s+(?:a\s+)?(?:code|repository|workspace)\s+scan|(?:high|medium|low)\s+confidence|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|(?:use|has|is)[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*(?:Id|Email))\b|_meta\b/gu,
  },
  {
    code: 'SOURCE_PATH',
    message: 'Stable output exposes an implementation or repository path.',
    pattern: new RegExp(SOURCE_PATH_PATTERN_SOURCE, 'gimu'),
  },
  {
    code: 'FALSE_FRESHNESS',
    message: 'Stable output makes an unsupported continuous-freshness claim.',
    pattern: /\balways\s+up(?:-|\s)to(?:-|\s)date\b|\bupdates?\s+automatically\b|\bautomatically\s+(?:updates?|refreshes?)\b|\b(?:updates?|refreshes?|regenerates?)\s+(?:as|when|whenever)\s+(?:the\s+)?(?:product|code)\s+changes\b|자동(?:으로)?\s*(?:갱신|업데이트)|(?:제품|코드)(?:이|가)?\s*바뀌면\s*(?:함께\s*)?(?:갱신|업데이트)/giu,
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
    for (const match of token.raw.matchAll(RAW_HTML_TAG_PATTERN)) {
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
  const allowTerms = new Set(input.allowTerms ?? []);

  for (const rule of RULES) {
    for (const source of sources) {
      rule.pattern.lastIndex = 0;
      for (const match of source.matchAll(rule.pattern)) {
        if (rule.code === 'INTERNAL_IDENTIFIER' && allowTerms.has(match[0])) continue;
        const index = match.index ?? 0;
        const excerpt = makeExcerpt(source, index, match[0].length);
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

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
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
