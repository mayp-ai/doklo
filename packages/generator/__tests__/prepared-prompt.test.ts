import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModelMock } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
}));

vi.mock('../src/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm-client.js')>();
  return { ...actual, callModel: callModelMock };
});

import { consolidateFeatures, buildConsolidationPromptForFeatures } from '../src/consolidator.js';
import { generateDokForFeature } from '../src/dok-generator.js';
import { suggestLexiconTerms } from '../src/lexicon-suggester.js';

describe('prepared provider prompt boundary', () => {
  beforeEach(() => {
    callModelMock.mockReset();
    callModelMock.mockResolvedValue({
      success: false,
      content: null,
      usage: null,
      processingTime: 0,
      error: new Error('stop after prompt capture'),
    });
  });

  it('uses the caller-authorized prompt for consolidation', async () => {
    await consolidateFeatures({ projectName: 'demo', featureGroups: [] } as never, {
      preparedPrompt: {
        systemPrompt: 'AUTHORIZED_CONSOLIDATE_SYSTEM',
        userPrompt: 'AUTHORIZED_CONSOLIDATE',
      },
    } as never);
    expect(callModelMock.mock.calls[0]![0].systemPrompt).toBe('AUTHORIZED_CONSOLIDATE_SYSTEM');
    expect(callModelMock.mock.calls[0]![0].userPrompt).toBe('AUTHORIZED_CONSOLIDATE');
  });

  it('uses the caller-authorized prompt for lexicon suggestion', async () => {
    await suggestLexiconTerms({
      defaultLocale: 'en',
      corpus: { kind: 'code', groups: [], i18nValues: [] },
    }, { preparedPrompt: 'AUTHORIZED_LEXICON' } as never);
    expect(callModelMock.mock.calls[0]![0].userPrompt).toBe('AUTHORIZED_LEXICON');
  });

  it('uses the caller-authorized prompt for Dok generation', async () => {
    await generateDokForFeature({
      canonical_id: 'auth', label: 'Auth', dok_id_prefix: 'AUTH', primary_route: '/auth',
      members: [], files: [],
    }, {
      defaultLocale: 'en', knownRoles: [], fileContext: {}, dokId: 'AUTH',
    }, {
      preparedPrompt: {
        systemPrompt: 'AUTHORIZED_GENERATE_SYSTEM',
        userPrompt: 'AUTHORIZED_GENERATE',
      },
    } as never);
    expect(callModelMock.mock.calls[0]![0].systemPrompt).toBe('AUTHORIZED_GENERATE_SYSTEM');
    expect(callModelMock.mock.calls[0]![0].userPrompt).toBe('AUTHORIZED_GENERATE');
  });

  it('propagates the structured provider failure kind without discarding raw detail', async () => {
    callModelMock.mockResolvedValueOnce({
      success: false,
      content: null,
      usage: null,
      processingTime: 0,
      error: {
        type: 'rate_limit',
        message: 'claude -p exited 1: HTTP 429 rate limit; retry the unfinished Dok',
      },
    });

    const result = await generateDokForFeature({
      canonical_id: 'auth', label: 'Auth', dok_id_prefix: 'AUTH', primary_route: '/auth',
      members: [], files: [],
    }, {
      defaultLocale: 'en', knownRoles: [], fileContext: {}, dokId: 'AUTH',
    }, {
      preparedPrompt: { systemPrompt: 'AUTHORIZED_SYSTEM', userPrompt: 'AUTHORIZED_GENERATE' },
    } as never);

    expect(result).toMatchObject({
      success: false,
      failureKind: 'rate_limit',
      error: expect.stringContaining('HTTP 429 rate limit'),
    });
  });

  it('classifies an unclosed provider JSON object as a truncated response', async () => {
    callModelMock.mockResolvedValueOnce({
      success: true,
      content: '{"dok_id":"AUTH","name":"Sign in"',
      usage: { input_tokens: 10, output_tokens: 20 },
      processingTime: 0,
      error: null,
    });

    const result = await generateDokForFeature({
      canonical_id: 'auth', label: 'Auth', dok_id_prefix: 'AUTH', primary_route: '/auth',
      members: [], files: [],
    }, {
      defaultLocale: 'en', knownRoles: [], fileContext: {}, dokId: 'AUTH',
    }, {
      preparedPrompt: { systemPrompt: 'AUTHORIZED_SYSTEM', userPrompt: 'AUTHORIZED_GENERATE' },
    } as never);

    expect(result).toMatchObject({
      success: false,
      failureKind: 'truncated_response',
      error: expect.stringMatching(/incomplete|truncated/i),
    });
  });

  it('does not classify balanced malformed JSON as a truncated response', async () => {
    callModelMock.mockResolvedValueOnce({
      success: true,
      content: '{"dok_id":}',
      usage: { input_tokens: 10, output_tokens: 20 },
      processingTime: 0,
      error: null,
    });

    const result = await generateDokForFeature({
      canonical_id: 'auth', label: 'Auth', dok_id_prefix: 'AUTH', primary_route: '/auth',
      members: [], files: [],
    }, {
      defaultLocale: 'en', knownRoles: [], fileContext: {}, dokId: 'AUTH',
    }, {
      preparedPrompt: { systemPrompt: 'AUTHORIZED_SYSTEM', userPrompt: 'AUTHORIZED_GENERATE' },
    } as never);

    expect(result.success).toBe(false);
    expect(result.failureKind).toBeUndefined();
    expect(result.error).toMatch(/JSON parse failed/i);
  });
});

describe('consolidation prompt content (semantic dok_id contract)', () => {
  it('describes semantic ids without serials', () => {
    // buildConsolidationPromptForFeatures is the exported entry point; the
    // static Rules prose it emits doesn't depend on any feature groups being
    // present, so an empty FeatureConfig is enough to exercise the contract.
    const prompt = buildConsolidationPromptForFeatures({
      projectName: 'demo',
      featureGroups: [],
    } as never);
    expect(prompt).not.toContain('{prefix}-001');
    expect(prompt).toContain('the prefix IS the final dok_id');
    expect(prompt).toContain('must not start with BR or AC');
  });
});
