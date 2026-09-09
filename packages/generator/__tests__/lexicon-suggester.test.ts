import { describe, it, expect } from 'vitest';
import {
  buildSuggestPrompt,
  LEXICON_DOK_SNIPPET_MAX_CHARS,
  LEXICON_EXISTING_SNIPPET_MAX_CHARS,
  LEXICON_I18N_SNIPPET_MAX_CHARS,
  parseSuggestions,
  type SuggestCorpus,
} from '../src/lexicon-suggester.js';

const CODE_CORPUS: SuggestCorpus = {
  kind: 'code',
  groups: [
    {
      label: '마일스톤',
      features: [
        { canonical_id: 'milestone-list', label: '마일스톤 목록', primary_route: '/milestones' },
        { canonical_id: 'milestone-detail', label: '마일스톤 상세', primary_route: '/milestones/[id]' },
      ],
    },
  ],
  i18nValues: ['마일스톤', '사업진단 시작'],
};

describe('buildSuggestPrompt', () => {
  it('renders code corpus with groups, routes, and i18n values', () => {
    const p = buildSuggestPrompt({ defaultLocale: 'ko', corpus: CODE_CORPUS });
    expect(p).toContain('마일스톤 목록');
    expect(p).toContain('/milestones/[id]');
    expect(p).toContain('사업진단 시작');
    expect(p).toContain('dok_refs'); // output shape still requested
  });

  it('guides only the two domain categories', () => {
    const p = buildSuggestPrompt({ defaultLocale: 'ko', corpus: CODE_CORPUS });
    expect(p).toContain('`concept`');
    expect(p).not.toContain('`feature`');
    expect(p).toContain('`role`');
    expect(p).not.toContain('`navigation`');
    expect(p).not.toContain('`button`');
  });

  it('still renders the doks corpus', () => {
    const p = buildSuggestPrompt({
      defaultLocale: 'ko',
      corpus: { kind: 'doks', doks: [] },
    });
    expect(p).toContain('Dok');
  });

  it('caps each Dok, i18n, and existing-lexicon snippet before prompt construction', () => {
    const dok = {
      dok_id: 'LONG',
      name: 'Long',
      status: 'active',
      tags: ['long'],
      surfaces: ['web'],
      description: `${'d'.repeat(LEXICON_DOK_SNIPPET_MAX_CHARS)}DOK_CANARY`,
      user_actions: { steps: [] },
      business_rules: { rules: [] },
      acceptance_criteria: { criteria: [] },
    } as never;
    const prompt = buildSuggestPrompt({
      defaultLocale: 'ko',
      corpus: {
        kind: 'doks',
        doks: [dok],
      },
      existingTexts: [
        `${'e'.repeat(LEXICON_EXISTING_SNIPPET_MAX_CHARS)}EXISTING_CANARY`,
      ],
    });
    const codePrompt = buildSuggestPrompt({
      defaultLocale: 'ko',
      corpus: {
        ...CODE_CORPUS,
        i18nValues: [
          `${'i'.repeat(LEXICON_I18N_SNIPPET_MAX_CHARS)}I18N_CANARY`,
        ],
      },
    });

    expect(prompt).not.toContain('DOK_CANARY');
    expect(prompt).not.toContain('EXISTING_CANARY');
    expect(codePrompt).not.toContain('I18N_CANARY');
  });
});

describe('parseSuggestions', () => {
  it('coerces legacy/unknown categories to concept', () => {
    const raw = JSON.stringify({
      suggestions: [
        { text: '마일스톤', category: 'concept', reason: 'r', dok_refs: [] },
        { text: '저장', category: 'button', reason: 'r', dok_refs: [] },
        { text: 'AI 채팅', category: 'feature', reason: 'r', dok_refs: [] },
      ],
    });
    const out = parseSuggestions(raw);
    expect(out.map((s) => s.category)).toEqual(['concept', 'concept', 'concept']);
  });
});
