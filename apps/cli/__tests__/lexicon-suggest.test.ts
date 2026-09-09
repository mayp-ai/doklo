import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runLexiconSuggest,
  type CorpusKind,
} from '../src/commands/lexicon-suggest.js';
import { resolveContainedOutputPath, type SuggestLexiconContext } from '@doklo-beta/generator';
import { DokSchema } from '@doklo-beta/core';
import {
  registerLlmRun,
  reserveRegisteredLlmCall,
} from '../src/lib/llm-cost-cap.js';
import {
  authorizeLlmRun,
  buildLlmRunPlan,
} from '../src/lib/llm-preflight.js';

async function paidConsent(root: string, corpus?: CorpusKind) {
  const preview = await runLexiconSuggest({ root, dryRun: true, ...(corpus ? { corpus } : {}) });
  const plan = buildLlmRunPlan({
    llm: {
      providerKind: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'environment',
    },
    candidateFiles: (preview.transmissions ?? []).map((source) => ({
      phase: 'lexicon' as const,
      serviceId: 'workspace',
      file: source.file,
      maxChars: source.maxChars,
    })),
    workItems: [{ phase: 'lexicon', serviceId: 'workspace', id: preview.corpus ?? 'code' }],
    calls: { consolidate: 0, lexicon: 1, generateMax: 0, judgeMax: 0 },
    preparedCalls: [{
      phase: 'lexicon',
      workItem: { phase: 'lexicon', serviceId: 'workspace', id: preview.corpus ?? 'code' },
      prompt: preview.prompt ?? '',
      maxOutputTokens: 4_096,
    }],
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    plan,
    authorizedRun: await authorizeLlmRun(root, plan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false }),
    prepared: preview.prepared,
  };
}

async function codexConsent(root: string, codexFetch: typeof fetch, corpus?: CorpusKind) {
  const preview = await runLexiconSuggest({
    root,
    dryRun: true,
    ...(corpus ? { corpus } : {}),
  });
  const llm = {
    providerKind: 'openai' as const,
    model: 'openai/gpt-5.6-terra',
    authSource: 'oauth' as const,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    fetch: codexFetch,
  };
  const plan = buildLlmRunPlan({
    llm,
    candidateFiles: (preview.transmissions ?? []).map((source) => ({
      phase: 'lexicon' as const,
      serviceId: 'workspace',
      file: source.file,
      maxChars: source.maxChars,
    })),
    workItems: [{ phase: 'lexicon', serviceId: 'workspace', id: preview.corpus ?? 'code' }],
    calls: { consolidate: 0, lexicon: 1, generateMax: 0, judgeMax: 0 },
    preparedCalls: [{
      phase: 'lexicon',
      workItem: {
        phase: 'lexicon',
        serviceId: 'workspace',
        id: preview.corpus ?? 'code',
      },
      prompt: preview.prompt ?? '',
      maxOutputTokens: 4_096,
    }],
    debugDir: await resolveContainedOutputPath(root, '.doklo/debug'),
  });
  return {
    plan,
    authorizedRun: await authorizeLlmRun(
      root,
      plan,
      llm,
      { yes: true, isTTY: false },
    ),
    prepared: preview.prepared,
  };
}

async function tmpInit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-lexsug-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo', name: 'Demo',
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'ko', supported_locales: ['ko'],
    }),
    'utf-8',
  );
  return root;
}

// A valid Dok literal (same shape as generate.test.ts's makeDok) — must pass
// DokSchema so loadAllDoks counts it.
function minimalDok(dokId: string, name = 'Stub'): unknown {
  return {
    dok_id: dokId,
    name,
    status: 'active',
    tags: ['demo'],
    surfaces: ['web'],
    description: 'A stub dok produced by the test fake LLM.',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'system' },
          intent: 'Render',
          outcome: 'Rendered',
          variants: [{ platform: 'all', interaction: 'auto' }],
        },
      ],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
  };
}

const okSuggest = (captured: SuggestLexiconContext[]) =>
  vi.fn(async (ctx: SuggestLexiconContext) => {
    captured.push(ctx);
    return {
      success: true,
      suggestions: [{ text: '마일스톤', category: 'concept' as const, reason: 'core domain noun', dok_refs: [] }],
      prompt: 'p', rawResponse: '{}', usage: null,
    };
  });

async function writeConsolidated(root: string): Promise<void> {
  await writeFile(
    join(root, '.doklo/cache/web.consolidated.json'),
    JSON.stringify({
      projectName: 'demo', basedOnFeaturesAt: 't', generatedAt: 't', model: 'm', userReviewed: false,
      originalFeatureIds: ['milestone-list'],
      stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
      groups: [{
        group_id: 'g1', label: '마일스톤', excluded: [],
        features: [{
          canonical_id: 'milestone-list', label: '마일스톤 목록', decision: 'keep',
          members: ['milestone-list'], primary_route: '/milestones', reason: '', user_reviewed: false,
          dok_id_prefix: 'MILE',
        }],
      }],
    }),
    'utf-8',
  );
}

describe('runLexiconSuggest corpus selection', () => {
  it('uses code corpus when no Doks exist (consolidated cache + i18n values)', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    await mkdir(join(root, 'messages'), { recursive: true });
    await writeFile(join(root, 'messages/ko.json'), JSON.stringify({ m: { title: '마일스톤' } }), 'utf-8');

    const captured: SuggestLexiconContext[] = [];
    const result = await runLexiconSuggest({ root, ...await paidConsent(root) }, { suggest: okSuggest(captured) });

    expect(result.error).toBeUndefined();
    expect(result.corpus).toBe('code');
    expect(captured[0]!.corpus.kind).toBe('code');
    if (captured[0]!.corpus.kind === 'code') {
      expect(captured[0]!.corpus.groups[0]!.features[0]!.label).toBe('마일스톤 목록');
      expect(captured[0]!.corpus.i18nValues).toContain('마일스톤');
    }
    const cache = JSON.parse(await readFile(result.cacheFile, 'utf-8'));
    expect(cache.suggestions).toHaveLength(1);
  });

  it('errors when neither Doks nor consolidated cache exist', async () => {
    const root = await tmpInit();
    const result = await runLexiconSuggest({ root }, { suggest: okSuggest([]) });
    expect(result.error).toMatch(/consolidate/i);
  });

  it('honors --corpus doks even when explicitly forced', async () => {
    const root = await tmpInit();
    await writeFile(
      join(root, '.doklo/hub/doks/MILE.json'),
      JSON.stringify(minimalDok('MILE')),
      'utf-8',
    );
    const captured: SuggestLexiconContext[] = [];
    const result = await runLexiconSuggest({
      root,
      corpus: 'doks',
      ...await paidConsent(root, 'doks'),
    }, { suggest: okSuggest(captured) });
    expect(result.corpus).toBe('doks');
    expect(captured[0]!.corpus.kind).toBe('doks');
  });

  it('dry-run builds the prompt without calling the LLM or writing cache', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const suggest = okSuggest([]);
    const result = await runLexiconSuggest({ root, dryRun: true }, { suggest });
    expect(suggest).not.toHaveBeenCalled();
    expect(result.written).toBe(false);
    expect(result.prompt).toContain('마일스톤 목록');
    expect(result.transmittedFiles).toContain('.doklo/cache/web.consolidated.json');
  });

  it('attributes the exact rendered consolidated group fragment to its cache', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });
    const source = result.transmissions?.find((item) =>
      item.file === '.doklo/cache/web.consolidated.json');
    const rendered = '## 마일스톤\n- 마일스톤 목록 (`milestone-list`, /milestones)';

    expect(source?.actualChars).toBe(rendered.length);
  });

  it('attributes the exact rendered i18n line to its source file', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    await mkdir(join(root, 'messages'), { recursive: true });
    await writeFile(join(root, 'messages/ko.json'), JSON.stringify({ title: '마일스톤' }));

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });
    const source = result.transmissions?.find((item) => item.file === 'messages/ko.json');

    expect(source?.actualChars).toBe('- 마일스톤'.length);
  });

  it('filters a sensitive service consolidated cache before reading its canary', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    await writeFile(join(root, 'workspace.json'), JSON.stringify({
      workspace_id: 'demo', name: 'Demo',
      services: [
        { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
        { service_id: 'secrets', type: 'frontend', framework: 'nextjs', code_root: '.' },
      ],
      default_locale: 'ko', supported_locales: ['ko'],
    }));
    await writeFile(join(root, '.doklo/cache/secrets.consolidated.json'), JSON.stringify({
      projectName: 'secret', basedOnFeaturesAt: 't', generatedAt: 't', model: 'm', userReviewed: false,
      originalFeatureIds: ['secret'],
      stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
      groups: [{
        group_id: 'secret', label: 'CONSOLIDATED_SECRET_CANARY', excluded: [],
        features: [{
          canonical_id: 'secret', label: 'CONSOLIDATED_SECRET_CANARY', decision: 'keep',
          members: ['secret'], primary_route: '/secret', reason: '', user_reviewed: false,
        }],
      }],
    }));

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });

    expect(result.prompt).not.toContain('CONSOLIDATED_SECRET_CANARY');
    expect(result.transmittedFiles).not.toContain('.doklo/cache/secrets.consolidated.json');
  });

  it('rejects a service code_root that physically escapes the workspace', async () => {
    const root = await tmpInit();
    const outside = await mkdtemp(join(tmpdir(), 'doklo-lex-outside-'));
    await mkdir(join(outside, 'messages'), { recursive: true });
    await writeFile(join(outside, 'messages/ko.json'), JSON.stringify({ secret: 'OUTSIDE_CANARY' }));
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo', name: 'Demo',
        services: [{
          service_id: 'web', type: 'frontend', framework: 'nextjs',
          code_root: 'service',
        }],
        default_locale: 'ko', supported_locales: ['ko'],
      }),
    );
    await symlink(outside, join(root, 'service'), 'dir');
    await writeConsolidated(root);

    await expect(runLexiconSuggest({ root, corpus: 'code', dryRun: true })).rejects.toMatchObject({
      name: 'PathOutsideRootError',
    });
  });

  it('filters sensitive i18n paths before reading their values', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo', name: 'Demo',
        services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'keys' }],
        default_locale: 'ko', supported_locales: ['ko'],
      }),
    );
    await mkdir(join(root, 'keys/messages'), { recursive: true });
    await writeFile(
      join(root, 'keys/messages/ko.json'),
      JSON.stringify({ secret: 'SENSITIVE_I18N_CANARY' }),
    );

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });

    expect(result.prompt).not.toContain('SENSITIVE_I18N_CANARY');
    expect(result.transmittedFiles).not.toContain('keys/messages/ko.json');
  });

  it('filters a sensitive Dok filename before reading its body', async () => {
    const root = await tmpInit();
    await writeFile(
      join(root, '.doklo/hub/doks/SAFE.json'),
      JSON.stringify(minimalDok('SAFE', 'Safe Dok')),
    );
    await writeFile(
      join(root, '.doklo/hub/doks/.env.secret.json'),
      JSON.stringify(minimalDok('SECRET', 'SECRET_DOK_CANARY')),
    );

    const result = await runLexiconSuggest({ root, corpus: 'doks', dryRun: true });

    expect(result.prompt).toContain('Safe Dok');
    expect(result.prompt).not.toContain('SECRET_DOK_CANARY');
    expect(result.transmittedFiles).not.toContain('.doklo/hub/doks/.env.secret.json');
  });

  it('attributes each Dok contribution to the file that supplied those exact characters', async () => {
    const root = await tmpInit();
    const largeDok = minimalDok('ZZZZ', 'x'.repeat(5_000));
    const smallDok = minimalDok('AAAA', 'small');
    await writeFile(
      join(root, '.doklo/hub/doks/A-file.json'),
      JSON.stringify(largeDok),
    );
    await writeFile(
      join(root, '.doklo/hub/doks/Z-file.json'),
      JSON.stringify(smallDok),
    );

    const result = await runLexiconSuggest({ root, corpus: 'doks', dryRun: true });
    const transmissions = (result as RunLexiconSuggestResultWithSources).transmissions;
    const parsedLarge = DokSchema.parse(largeDok);
    const parsedSmall = DokSchema.parse(smallDok);
    const render = (dok: typeof parsedLarge) => [
      `## ${dok.dok_id} — ${dok.name}`,
      dok.description,
      '  • Render',
      '    → Rendered',
    ].join('\n');

    expect(transmissions).toContainEqual({
      file: '.doklo/hub/doks/A-file.json',
      maxChars: 12_000,
      actualChars: render(parsedLarge).length + 2,
    });
    expect(transmissions).toContainEqual({
      file: '.doklo/hub/doks/Z-file.json',
      maxChars: 12_000,
      actualChars: render(parsedSmall).length,
    });
  });

  it('caps the cumulative contribution of each i18n source file at its signed maxChars', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    await mkdir(join(root, 'messages'), { recursive: true });
    const values = Object.fromEntries([
      ...Array.from({ length: 80 }, (_, index) => [`value_${index}`, `${index}-` + 'x'.repeat(190)]),
      ['after_cap', 'I18N_AFTER_12K_CANARY'],
    ]);
    await writeFile(join(root, 'messages/ko.json'), JSON.stringify(values));

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });
    const transmissions = (result as RunLexiconSuggestResultWithSources).transmissions;

    expect(result.prompt).not.toContain('I18N_AFTER_12K_CANARY');
    expect(transmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'messages/ko.json', maxChars: 12_000 }),
    ]));
    expect(transmissions.every((source) => source.actualChars <= source.maxChars)).toBe(true);
  });

  it('contains the existing lexicon before reading it', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const outside = join(await mkdtemp(join(tmpdir(), 'doklo-lex-file-')), 'lexicon.json');
    await writeFile(outside, JSON.stringify({
      version: 1,
      terms: [{
        term_id: 'TERM-SECRET', category: 'concept', binding: { type: 'owned' }, locales: { ko: 'OUTSIDE_LEXICON_CANARY' },
      }],
    }));
    await mkdir(join(root, '.doklo/hub'), { recursive: true });
    await symlink(outside, join(root, '.doklo/hub/lexicon.json'));

    await expect(runLexiconSuggest({ root, corpus: 'code', dryRun: true })).rejects.toBeDefined();
  });

  it('includes a contained existing lexicon in the exact transmission manifest', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    await mkdir(join(root, '.doklo/hub'), { recursive: true });
    await writeFile(join(root, '.doklo/hub/lexicon.json'), JSON.stringify({
      version: 1,
      terms: [{
        term_id: 'TERM-MILESTONE', category: 'concept', binding: { type: 'owned' }, locales: { ko: '마일스톤' },
      }],
    }));

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });

    expect(result.transmittedFiles).toContain('.doklo/hub/lexicon.json');
    expect(result.transmissions?.find((source) => source.file === '.doklo/hub/lexicon.json')
      ?.actualChars).toBe('- 마일스톤'.length);
  });

  it('caps the cumulative existing-lexicon contribution and attributes it to its source', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const terms = [
      ...Array.from({ length: 80 }, (_, index) => ({
        term_id: `TERM-${index}`,
        category: 'concept',
        binding: { type: 'owned' }, locales: { ko: `${index}-` + 'x'.repeat(190) },
      })),
      {
        term_id: 'TERM-AFTER-CAP',
        category: 'concept',
        binding: { type: 'owned' }, locales: { ko: 'LEXICON_AFTER_12K_CANARY' },
      },
    ];
    await writeFile(join(root, '.doklo/hub/lexicon.json'), JSON.stringify({ version: 1, terms }));

    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });
    const transmissions = (result as RunLexiconSuggestResultWithSources).transmissions;

    expect(result.prompt).not.toContain('LEXICON_AFTER_12K_CANARY');
    expect(transmissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: '.doklo/hub/lexicon.json', maxChars: 12_000 }),
    ]));
    expect(transmissions.every((source) => source.actualChars <= source.maxChars)).toBe(true);
  });

  it('deep-freezes the prepared payload so post-approval mutation cannot change provider bytes', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const result = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });
    const prepared = result.prepared!;
    const prompt = prepared.prompt;

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.ctx)).toBe(true);
    expect(Object.isFrozen(prepared.ctx.corpus)).toBe(true);
    if (prepared.ctx.corpus.kind === 'code') {
      expect(Object.isFrozen(prepared.ctx.corpus.groups)).toBe(true);
      expect(Object.isFrozen(prepared.ctx.corpus.i18nValues)).toBe(true);
      expect(() => prepared.ctx.corpus.i18nValues.push('MUTATION_CANARY')).toThrow();
    }
    expect(prepared.prompt).toBe(prompt);
    expect(prepared.prompt).not.toContain('MUTATION_CANARY');
  });

  it('forwards the authorized exact prompt to the provider helper', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const preview = await runLexiconSuggest({ root, corpus: 'code', dryRun: true });
    const suggest = vi.fn(async (_ctx, options) => ({
      success: true,
      suggestions: [],
      prompt: options.preparedPrompt,
      rawResponse: '{}',
      usage: null,
    }));

    await runLexiconSuggest({
      root,
      corpus: 'code',
      ...await paidConsent(root, 'code'),
    }, { suggest });

    expect(suggest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparedPrompt: preview.prompt }),
    );
  });

  it('forwards the exact approved Codex OAuth transport to lexicon suggestion', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const codexFetch = (async () => new Response()) as typeof fetch;
    const suggest = okSuggest([]);

    await runLexiconSuggest({
      root,
      ...await codexConsent(root, codexFetch, 'code'),
    }, { suggest });

    expect(suggest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        providerKind: 'openai',
        model: 'openai/gpt-5.6-terra',
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetch: codexFetch,
      }),
    );
  });

  it('rejects a direct paid suggestion without consent before the worker or cache write', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const suggest = okSuggest([]);

    await expect(runLexiconSuggest({ root }, { suggest })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        diagnostics: [expect.objectContaining({ code: 'LLM_CONSENT_REQUIRED' })],
      },
    });
    expect(suggest).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/cache/lexicon-suggestions.json'), 'utf-8')).rejects.toThrow();
  });

  it('rejects a valid receipt whose plan authorizes generation rather than lexicon', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    const plan = buildLlmRunPlan({
      llm: { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' },
      candidateFiles: [],
      workItems: [{ phase: 'generate', serviceId: 'web', id: 'AUTH' }],
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
        prompt: 'unrelated',
        maxOutputTokens: 1,
      }],
      debugDir: join(root, '.doklo/debug'),
    });
    const authorizedRun = await authorizeLlmRun(root, plan, {
      providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: 'test-key',
    }, { yes: true, isTTY: false });
    const suggest = okSuggest([]);

    await expect(runLexiconSuggest(
      {
        root,
        authorizedRun,
      },
      { suggest },
    )).rejects.toMatchObject({
      exitCode: 2,
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })] },
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it('checks the cap before the suggestion worker', async () => {
    const root = await tmpInit();
    await writeConsolidated(root);
    for (let index = 0; index < 5; index++) {
      const prior = await registerLlmRun(root, {
        receiptId: `prior-${index}`, planDigest: `prior-plan-${index}`, maxCalls: 1,
      });
      await reserveRegisteredLlmCall(prior, {
        callKey: `prior/${index}`,
        reservedTokens: 999_999,
      });
    }
    const auth = await paidConsent(root);
    const suggest = okSuggest([]);

    await expect(runLexiconSuggest({ root, ...auth }, { suggest })).rejects.toMatchObject({
      code: 'LLM_TOTAL_TOKEN_CAP',
    });
    expect(suggest).not.toHaveBeenCalled();
  });
});

type RunLexiconSuggestResultWithSources = {
  transmissions: Array<{ file: string; maxChars: number; actualChars: number }>;
};
