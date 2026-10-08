import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.js';
import { INTERNAL_IDENTIFIER_PATTERN, lintStableMarkdown, rawHtmlTags, visibleText } from '../src/stable-lint.js';
import { LEADING_WHITESPACE_REWRITES } from '../src/stable-help-copy.js';
import { parseTemplateManifest, type TemplateManifest } from '../src/template-manifest.js';

type Violation = {
  code: 'INCOMPLETE_COPY' | 'INTERNAL_IDENTIFIER' | 'SOURCE_PATH' | 'FALSE_FRESHNESS' | 'STRUCTURAL_RAW_HTML';
  message: string;
  excerpt: string;
};

const lint = (engine as unknown as {
  lintStableArtifact?: (input: {
    html: string;
    manifest: TemplateManifest;
    provenance: { generatedAt: string; sourceRevision?: string };
    knownDokIds?: readonly string[];
  }) => Violation[];
}).lintStableArtifact;

function stableManifest(overrides: Record<string, unknown> = {}): TemplateManifest {
  return parseTemplateManifest({
    name: 'safe-publication',
    version: '1.0.0',
    stability: 'stable',
    audience: { en: 'Customers' },
    purpose: { en: 'Explain a product task.' },
    job: { en: 'Complete the task.' },
    required_input: { en: 'Reviewed product context' },
    variables: {},
    output_formats: ['html'],
    scope: 'workspace',
    output_path: 'help.html',
    supported_locales: ['en'],
    default_locale: 'en',
    ...overrides,
  });
}

function run(
  html: string,
  manifest = stableManifest(),
  options: { sourceRevision?: string; knownDokIds?: readonly string[] } = {},
): Violation[] {
  expect(typeof lint).toBe('function');
  if (!lint) return [];
  return lint({
    html,
    manifest,
    provenance: {
      generatedAt: '2026-07-17T00:00:00.000Z',
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    },
    ...(options.knownDokIds ? { knownDokIds: options.knownDokIds } : {}),
  });
}

describe('stable artifact public-copy lint', () => {
  it('rejects structural raw HTML in Markdown while allowing inline semantic tags', () => {
    expect(lintStableMarkdown('<section>content</section>')).toContainEqual(
      expect.objectContaining({ code: 'STRUCTURAL_RAW_HTML' }),
    );
    expect(lintStableMarkdown('Press <kbd>Enter</kbd>.')).toEqual([]);
  });

  it.each([
    'li',
    'dt',
    'dd',
    'caption',
    'colgroup',
    'iframe',
    'video',
    'audio',
    'canvas',
    'object',
    'menu',
    'html',
    'body',
  ])(
    'rejects the structural raw HTML child element <%s>',
    (tag) => {
      expect(lintStableMarkdown(`<${tag}>content</${tag}>`)).toContainEqual(
        expect.objectContaining({ code: 'STRUCTURAL_RAW_HTML' }),
      );
    },
  );

  it('ignores structural tags inside indented and longer fenced code examples', () => {
    const markdown = [
      '    <section>indented example</section>',
      '',
      '````html',
      '<section>outer example',
      '```',
      '</section>',
      '````',
    ].join('\n');

    expect(lintStableMarkdown(markdown)).toEqual([]);
  });

  it('ends a fenced code example at a CRLF closing fence', () => {
    const markdown = [
      '````html',
      '<section>code example</section>',
      '````',
      '<section>published structure</section>',
    ].join('\r\n');

    const violations = lintStableMarkdown(markdown);
    expect(violations).toContainEqual(expect.objectContaining({
      code: 'STRUCTURAL_RAW_HTML',
      excerpt: expect.stringContaining('published structure'),
    }));
    expect(violations).toHaveLength(2);
  });

  it.each([
    '- item\n    <section>list continuation</section>',
    '- item\n\n    <section>blank-line list continuation</section>',
    'Paragraph text\n    <section>paragraph continuation</section>',
  ])('does not mask indented structural HTML outside a code block', (markdown) => {
    expect(lintStableMarkdown(markdown)).toContainEqual(expect.objectContaining({
      code: 'STRUCTURAL_RAW_HTML',
    }));
  });

  it('detects repository and implementation paths in visible copy or metadata', () => {
    expect(run('<p>Generated from packages/core/src/x.ts</p>')).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_PATH' }),
    );
    expect(run('<p>Reviewed product guidance.</p>', stableManifest({
      purpose: { en: 'Read apps/cli/src/index.ts before publishing.' },
    }))).toContainEqual(expect.objectContaining({ code: 'SOURCE_PATH' }));
    expect(run('<p>Reviewed product guidance.</p>', stableManifest(), {
      sourceRevision: '/Users/dev/project/auth.ts',
    }))
      .toContainEqual(expect.objectContaining({ code: 'SOURCE_PATH' }));
  });

  it.each([
    'Continue to /admin/settings.',
    'Continue to "/admin/settings".',
    'Continue to “/admin/settings”.',
    'Continue to [/admin/settings].',
    'Continue to `/admin/settings`.',
    'Route=/admin/settings',
  ])('detects raw application routes across public-copy delimiters: %s', (copy) => {
    expect(run(`<p>${copy}</p>`)).toContainEqual(expect.objectContaining({ code: 'SOURCE_PATH' }));
  });

  it.each([
    '/admin/data/[programObjectId]',
    '/admin/data/[programObjectId]/[projectObjectId]',
    '/ai-chat/{id}',
    '/ai-chat/{세션ID}',
    '/chat/[chatId]',
    '/company/{companyId}',
    '/program/:programId/company',
  ])('detects parameterized application routes: %s', (route) => {
    expect(run(`<p>Continue to ${route}.</p>`)).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_PATH' }),
    );
  });

  it('allows URL paths and ordinary route language', () => {
    expect(run('<p>Read https://example.com/admin/settings.</p>')).toEqual([]);
    expect(run('<p>The delivery route remains visible.</p>')).toEqual([]);
  });

  it('detects unsupported freshness promises', () => {
    expect(run('<p>Always up to date</p>')).toContainEqual(
      expect.objectContaining({ code: 'FALSE_FRESHNESS' }),
    );
    expect(run('<p>제품 변경 시 자동으로 갱신됩니다.</p>')).toContainEqual(
      expect.objectContaining({ code: 'FALSE_FRESHNESS' }),
    );
  });

  it('detects unfinished scaffold copy', () => {
    expect(run('<p>Screenshot coming soon</p>')).toContainEqual(
      expect.objectContaining({ code: 'INCOMPLETE_COPY' }),
    );
    expect(run('<p>TODO: add customer instructions</p>')).toContainEqual(
      expect.objectContaining({ code: 'INCOMPLETE_COPY' }),
    );
    expect(lintStableMarkdown('Run `git clone <repo-url>` to continue.')).toContainEqual(
      expect.objectContaining({ code: 'INCOMPLETE_COPY' }),
    );
  });

  it.each([
    'Ask ROLE-ADMIN for access.',
    'Auto-suggested from scan (high confidence)',
    'Generated from a repository scan.',
  ])('detects internal role and generator provenance copy: %s', (copy) => {
    expect(run(`<p>${copy}</p>`)).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
  });

  it('rejects only known selected Dok IDs and allows ordinary customer references', () => {
    expect(run('<p>Order ORD is ready.</p>')).toEqual([]);
    expect(run('<p>Feature AUTH is available.</p>')).toEqual([]);
    expect(run('<p>Feature AUTH is available.</p>', stableManifest(), {
      knownDokIds: ['AUTH'],
    })).toContainEqual(expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }));
  });

  it('detects isolated camelCase developer identifiers when untranslated', () => {
    expect(run('<p>The editingBanner value is cleared.</p>')).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
    expect(run('<p>Do not expose sourceAnchor, dokId, or termRef fields.</p>')).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
    expect(run('<p>Feature guidance uses user_actions.steps.</p>')).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
  });

  it.each([
    'AccessDenied',
    'FormError',
    'HomeCalendar',
    'HomeMentoringSection',
    'BusinessFormWrapper',
    'InboxList',
    'ManageMentorList',
    'MentorList',
    'MongoDB',
    'MyProjectSection',
    'NewAiChatSessionModal',
    'ObjectId',
    'ProfileSetting',
    'ProjectMilestoneSheet',
    'ReadAllButton',
    'ShareToken',
    'StepsOverlay',
    'UsePrompts',
    'chatId',
    'companyId',
    'hasLogo',
    'isInternalTest',
    'isLoading',
    'isOwner',
    'mentorEmail',
    'programId',
    'programObjectId',
    'projectObjectId',
    'useInvitationsQuery',
    'useMentorsQuery',
    'userId',
  ])('detects implementation identifier: %s', (identifier) => {
    expect(run(`<p>The value ${identifier} is available.</p>`)).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
  });

  it('allows ordinary brand words with internal capitals in titles and body copy', () => {
    expect(run(
      '<h1>Use iPhone with eBay on macOS</h1>',
      stableManifest({ display_name: { en: 'iPhone, eBay, and macOS guide' } }),
    )).toEqual([]);
  });

  it('does not reject ordinary client-facing titles or filenames', () => {
    expect(run('<h1>Account recovery</h1><p>Download the quarterly-report.pdf.</p>')).toEqual([]);
  });

  it('returns deterministic, non-empty excerpts', () => {
    const first = run('<p>Screenshot coming soon</p><p>Always up to date</p>');
    const second = run('<p>Screenshot coming soon</p><p>Always up to date</p>');

    expect(second).toEqual(first);
    expect(first.every((violation) => violation.excerpt.length > 0)).toBe(true);
  });
});

describe('stable lint public-term allowlist', () => {
  it('allows public photo formats together in Korean customer instructions', () => {
    expect(run('<p>첨부 가능한 사진은 JPEG, PNG, WebP, HEIC, HEIF 형식입니다.</p>')).toEqual([]);
  });

  it('does not allow implementation names that contain a public format', () => {
    expect(run('<p>WebPEncoder와 photoId를 사용합니다.</p>')).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
  });

  it('still blocks a public format when it is a selected internal Dok ID', () => {
    expect(run('<p>WebP</p>', stableManifest(), { knownDokIds: ['WebP'] })).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER' }),
    );
  });

  it('keeps non-identifier copy safeguards on public formats', () => {
    const violations = run('<p>WebP 파일은 자동으로 갱신됩니다.</p>');
    expect(violations).toContainEqual(expect.objectContaining({ code: 'FALSE_FRESHNESS' }));
    expect(violations.some((item) => item.code === 'INTERNAL_IDENTIFIER')).toBe(false);
  });

  it('lets listed proper nouns through while still flagging code symbols', () => {
    expect(typeof lint).toBe('function');
    if (!lint) return;
    const html = '<p>ExampleCompany stores the profile with useAuthToken.</p>';
    const flagged = lint({
      html,
      manifest: stableManifest(),
      provenance: { generatedAt: '2026-07-17T00:00:00.000Z' },
    }).filter((violation) => violation.code === 'INTERNAL_IDENTIFIER');
    expect(flagged.map((violation) => violation.excerpt).join(' ')).toContain('ExampleCompany');

    const allowed = lint({
      html,
      manifest: stableManifest(),
      provenance: { generatedAt: '2026-07-17T00:00:00.000Z' },
      allowTerms: ['ExampleCompany'],
    } as Parameters<typeof lint>[0]).filter((violation) => violation.code === 'INTERNAL_IDENTIFIER');
    expect(allowed.map((violation) => violation.excerpt).join(' ')).not.toContain('ExampleCompany');
    expect(allowed.map((violation) => violation.excerpt).join(' ')).toContain('useAuthToken');
  });
});

describe('stable lint identifier rule runs in linear time', () => {
  /**
   * The lint runs under a watchdog, so a pattern that backtracks without bound
   * fails the test instead of hanging the suite.
   */
  function lintWithin(milliseconds: number, input: Parameters<typeof run>): Violation[] {
    return runInNewContext('lintNow()', { lintNow: () => run(...input) }, { timeout: milliseconds }) as Violation[];
  }

  // A capitalised word, a run of capitals, then a character that denies the
  // closing word boundary. A nested quantifier over the capitals tried every
  // way of splitting the run: 2^64 here.
  const hostile = `Aa${'A'.repeat(64)}_`;

  it('finishes on a capital run that cannot end at a word boundary', () => {
    const identifiers = lintWithin(2_000, [`<h1>${hostile} guide</h1>`])
      .filter((violation) => violation.code === 'INTERNAL_IDENTIFIER');
    expect(identifiers).toEqual([]);
  });

  it('finishes on the same word in template metadata and in the source revision', () => {
    expect(lintWithin(2_000, [
      '<p>Account recovery</p>',
      stableManifest({ display_name: { en: `${hostile} guide` } }),
      { sourceRevision: hostile },
    ]).filter((violation) => violation.code === 'INTERNAL_IDENTIFIER')).toEqual([]);
  });

  it('still reports the word once it does end at a word boundary', () => {
    const word = hostile.slice(0, -1);
    expect(lintWithin(2_000, [`<h1>${word} guide</h1>`])).toContainEqual(
      expect.objectContaining({ code: 'INTERNAL_IDENTIFIER', excerpt: `${word} guide` }),
    );
  });

  it('finishes on a long document of hostile words', () => {
    const html = `<p>${Array.from({ length: 2_000 }, () => hostile).join(' ')}</p>`;
    expect(lintWithin(5_000, [html]).filter((violation) => violation.code === 'INTERNAL_IDENTIFIER')).toEqual([]);
  });

  it('finishes on a long whitespace run after "auto-suggested from" in template metadata', () => {
    // Metadata strings reach the lint without whitespace collapsing. Two
    // adjacent whitespace repetitions made this quadratic: seconds at 80,000.
    const description = `Auto-suggested from${' '.repeat(200_000)}x`;
    expect(lintWithin(1_000, [
      '<p>Account recovery</p>',
      stableManifest({ description: { en: description } }),
    ]).filter((violation) => violation.code === 'INTERNAL_IDENTIFIER')).toContainEqual(
      expect.objectContaining({ excerpt: expect.stringContaining('Auto-suggested') }),
    );
  });

  it('matches exactly what the old "auto-suggested … scan" form matched', () => {
    const before = /\b[Aa]uto[- ]suggested(?:\s+from\s+(?:a\s+)?(?:code|repository|workspace)?\s*scan)?\b/gu;
    const tokens = ['Auto-suggested', 'auto suggested', 'from', 'a', 'code', 'workspace', 'scan', 'x', ' ', '  ', '\n'];
    const matches = (pattern: RegExp, text: string) =>
      [...text.matchAll(pattern)].map((match) => `${match.index}:${match[0]}`).join('|');
    const differences: string[] = [];
    const visit = (text: string, depth: number) => {
      if (matches(INTERNAL_IDENTIFIER_PATTERN, text) !== matches(before, text)) differences.push(JSON.stringify(text));
      if (depth === 6) return;
      for (const token of tokens) visit(text + token, depth + 1);
    };
    visit('', 0);
    expect(differences).toEqual([]);
  });

  it('matches exactly what the nested form matched, on every short string', () => {
    // The rule as it was written before, kept as the oracle. Strings this short
    // keep its backtracking small.
    const nested = /\b(?:user_actions(?:\.steps)?|business_rules|acceptance_criteria|source_anchors|topology\.edges|editingBanner|sourceAnchors?|dokId|termRef|userActions|businessRules|acceptanceCriteria|TermRef|Handlebars|DOM|null|Doks?|ROLE-[A-Z0-9_-]+|[Aa]uto[- ]suggested(?:\s+from\s+(?:a\s+)?(?:code|repository|workspace)?\s*scan)?|[Gg]enerated\s+from\s+(?:a\s+)?(?:code|repository|workspace)\s+scan|(?:high|medium|low)\s+confidence|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|(?:use|has|is)[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*(?:Id|Email))\b|_meta\b/gu;
    const matches = (pattern: RegExp, text: string) =>
      [...text.matchAll(pattern)].map((match) => `${match.index}:${match[0]}`).join('|');
    // Every character class the CamelCase branch distinguishes, plus the
    // letters that reach its neighbours ("isA…", "…Id").
    const alphabet = ['A', 'I', 'a', 'd', 'i', 's', '1', '_', ' '];
    const differences: string[] = [];
    let checked = 0;
    const visit = (text: string) => {
      checked += 1;
      if (matches(INTERNAL_IDENTIFIER_PATTERN, text) !== matches(nested, text)) differences.push(text);
      if (text.length === 6) return;
      for (const character of alphabet) visit(text + character);
    };
    visit('');
    expect(checked).toBe((9 ** 7 - 1) / 8);
    expect(differences).toEqual([]);
  });
});

describe('stable lint text extraction runs in linear time', () => {
  // The extraction as written before: three replacements, then entities and spaces.
  const before = (html: string) => html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const tagsBefore = (raw: string) =>
    [...raw.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^>]*>/gu)].map((match) => `${match.index}:${match[0]}:${match[1]}`);
  const tokens = ['<', '>', '<!--', '-->', '-', '<style', '<STYLE', '<script', '<styles', '</style>', '</Script>', '<p>', 'a', ' ', '&lt;', '/'];

  function* sequences(depth: number, prefix = ''): Generator<string> {
    yield prefix;
    if (depth === 0) return;
    for (const token of tokens) yield* sequences(depth - 1, prefix + token);
  }

  function within<T>(milliseconds: number, work: () => T): T {
    return runInNewContext('work()', { work }, { timeout: milliseconds }) as T;
  }

  it('extracts the same visible text as the replacements on every short token sequence', () => {
    const differences: string[] = [];
    for (const html of sequences(5)) {
      if (visibleText(html) !== before(html)) differences.push(JSON.stringify(html));
      if (differences.length > 20) break;
    }
    expect(differences).toEqual([]);
  });

  it('finds the same structural tags on every short token sequence', () => {
    const differences: string[] = [];
    for (const raw of sequences(5)) {
      const found = rawHtmlTags(raw).map((match) => `${match.index}:${match[0]}:${match[1]}`);
      if (JSON.stringify(found) !== JSON.stringify(tagsBefore(raw))) differences.push(JSON.stringify(raw));
      if (differences.length > 20) break;
    }
    expect(differences).toEqual([]);
  });

  it.each([
    ['unclosed comments', (n: number) => '<!--'.repeat(n)],
    ['unclosed style elements', (n: number) => '<style>'.repeat(n)],
    ['unclosed script openers', (n: number) => '<script x'.repeat(n)],
    ['a trailing run of <', (n: number) => `<p>a</p>${'<'.repeat(n)}`],
  ])('extracts visible text from %s', (_name, build) => {
    const html = build(100_000);
    within(2_000, () => visibleText(html));
  });

  it('reads structural tags from one long unterminated html token', () => {
    const markdown = `<div ${'<a '.repeat(100_000)}`;
    within(2_000, () => lintStableMarkdown(markdown));
  });
});

describe('stable help copy rewrites run in linear time', () => {
  const beforePatterns = [
    /\s+via\s+(?:an?\s+)?server[- ]side\s+authenticated\s+form\b/giu,
    /\s*\(pending\)/giu,
    /\s+without a session\b/giu,
  ];
  const tokens = [' ', '\n', 'via', 'a', 'server-side', 'authenticated', 'form', '(pending)', 'without', 'session', 'x'];

  function* sequences(depth: number, prefix = ''): Generator<string> {
    yield prefix;
    if (depth === 0) return;
    for (const token of tokens) yield* sequences(depth - 1, prefix + token);
  }

  it('rewrite exactly what the leading-whitespace forms rewrote', () => {
    expect(LEADING_WHITESPACE_REWRITES).toHaveLength(beforePatterns.length);
    const differences: string[] = [];
    for (const text of sequences(5)) {
      LEADING_WHITESPACE_REWRITES.forEach((pattern, index) => {
        if (text.replace(pattern, '') !== text.replace(beforePatterns[index]!, '')) differences.push(JSON.stringify(text));
      });
      if (differences.length > 20) break;
    }
    expect(differences).toEqual([]);
  });

  it('finish on a long whitespace run that leads nowhere', () => {
    const text = `${' '.repeat(200_000)}x`;
    for (const pattern of LEADING_WHITESPACE_REWRITES) {
      runInNewContext('text.replace(pattern, "")', { text, pattern }, { timeout: 1_000 });
    }
  });
});
