import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.js';
import { lintStableMarkdown } from '../src/stable-lint.js';
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
