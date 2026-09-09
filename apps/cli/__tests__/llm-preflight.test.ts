import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveLlmRunPlan,
  assertLlmConsent,
  authorizeLlmRun,
  beginAuthorizedLlmCall,
  buildLlmRunPlan,
  completeAuthorizedLlmCall,
  formatLlmRunPlan,
  type LlmPlanInput,
} from '../src/lib/llm-preflight.js';

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-preflight-'));
  await mkdir(join(root, '.doklo/cache'), { recursive: true });
  return root;
}

const input: LlmPlanInput = {
  llm: {
    providerKind: 'anthropic',
    model: 'anthropic/claude-sonnet-5',
    apiKey: 'secret-canary',
    authSource: 'keychain',
  },
  previews: [
    {
      serviceId: 'web',
      sourceFeatureCount: 2,
      transmittedFiles: ['app/page.tsx', '.env', 'certs/private.pem'],
      estimatedInputTokens: 400,
      estimatedOutputTokens: 160,
    },
  ],
  candidateFiles: [
    { phase: 'generate', serviceId: 'web', file: 'app/page.tsx', maxChars: 2_000 },
    { phase: 'generate', serviceId: 'web', file: 'src/auth.test.ts', maxChars: 2_000 },
    { phase: 'generate', serviceId: 'web', file: 'node_modules/pkg/index.js', maxChars: 2_000 },
    { phase: 'generate', serviceId: 'web', file: 'types/generated.d.ts', maxChars: 2_000 },
  ],
  workItems: [
    { phase: 'consolidate', serviceId: 'web', id: 'web' },
    { phase: 'generate', serviceId: 'web', id: 'AUTH' },
  ],
  calls: { consolidate: 1, lexicon: 0, generateMax: 2, judgeMax: 0 },
  reservedTokensMax: 420,
  debugDir: '/repo/.doklo/debug',
  maxTokensPerRun: 1_000_000,
  maxTokensTotal: 5_000_000,
};

describe('LLM runtime-trust preflight', () => {
  it('exposes only the one-shot authorized-run capability boundary', async () => {
    const api = await import('../src/lib/llm-preflight.js');
    expect(api).toHaveProperty('authorizeLlmRun');
    expect(api).not.toHaveProperty('createLlmExecution');
  });

  it('builds a stable, fixed-model plan without credentials or sensitive files', () => {
    const plan = buildLlmRunPlan(input);
    const same = buildLlmRunPlan({ ...input, candidateFiles: [...input.candidateFiles] });

    expect(plan.model).toBe('anthropic/claude-sonnet-5');
    expect(plan.providerKind).toBe('anthropic');
    expect(plan.route).toBe('anthropic-default');
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(same.digest).toBe(plan.digest);
    expect(JSON.stringify(plan)).not.toContain('secret-canary');
    expect(plan.transmissions).toEqual([
      { phase: 'consolidate', serviceId: 'web', file: 'app/page.tsx', maxChars: 0 },
      { phase: 'generate', serviceId: 'web', file: 'app/page.tsx', maxChars: 2_000 },
    ]);
    expect(plan.calls).toEqual({
      consolidate: 1,
      lexicon: 0,
      generateMax: 2,
      judgeMax: 0,
      totalMax: 3,
    });
  });

  it('is immutable in behavior and changes the digest when approved fields change', () => {
    const plan = buildLlmRunPlan(input);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.calls)).toBe(true);
    expect(Object.isFrozen(plan.transmissions)).toBe(true);

    const changed = buildLlmRunPlan({ ...input, debugDir: '/repo/.doklo/other-debug' });
    expect(changed.digest).not.toBe(plan.digest);
  });

  it('shows each contained transmission in the human consent plan', () => {
    const output = formatLlmRunPlan(buildLlmRunPlan(input));

    expect(output).toContain('consolidate web app/page.tsx maxChars=0');
    expect(output).toContain('generate web app/page.tsx maxChars=2000');
    expect(output).not.toContain('.env');
    expect(output).not.toContain('private.pem');
  });

  it('fails with the structured runtime contract for any other model', () => {
    expect(() => buildLlmRunPlan({
      ...input,
      llm: { ...input.llm, model: 'anthropic/claude-sonnet-4-5' },
    })).toThrow(expect.objectContaining({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'RUNTIME_TRUST_MODEL_REQUIRED' })],
      }),
    }));
  });

  it('rejects non-Anthropic and custom provider routes before approval', () => {
    for (const llm of [
      { ...input.llm, providerKind: 'openai' },
      { ...input.llm, baseURL: 'https://proxy.example/v1' },
      { ...input.llm, fetch: (async () => new Response()) as typeof fetch },
    ]) {
      expect(() => buildLlmRunPlan({ ...input, llm })).toThrow(expect.objectContaining({
        exitCode: 2,
        result: expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'RUNTIME_TRUST_ROUTE_REQUIRED' })],
        }),
      }));
    }
  });

  it('binds Codex OAuth Terra to its exact immutable route and transport', async () => {
    const root = await runtimeRoot();
    const debugDir = join(root, '.doklo/debug');
    const prompt = 'exact Codex OAuth prompt';
    const codexFetch = (async () => new Response()) as typeof fetch;
    const codexInput: LlmPlanInput = {
      llm: {
        providerKind: 'openai',
        model: 'openai/gpt-5.6-terra',
        authSource: 'oauth',
        baseURL: 'https://chatgpt.com/backend-api/codex',
        fetch: codexFetch,
      },
      previews: [],
      candidateFiles: [{
        phase: 'generate',
        serviceId: 'web',
        file: 'app/page.tsx',
        maxChars: 2_000,
        dokId: 'AUTH',
      }],
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      workItems: [{ phase: 'generate', serviceId: 'web', id: 'AUTH' }],
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
        prompt,
        maxOutputTokens: 8_192,
      }],
      debugDir,
    };

    const plan = buildLlmRunPlan(codexInput);
    expect(plan).toMatchObject({
      providerKind: 'openai',
      route: 'openai-codex-oauth',
      model: 'openai/gpt-5.6-terra',
      authSource: 'oauth',
    });

    const run = await authorizeLlmRun(root, plan, codexInput.llm, {
      yes: true,
      isTTY: false,
    });
    const call = await beginAuthorizedLlmCall(run, root, {
      phase: 'generate',
      workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
      debugDir,
      prompt,
      transmissions: [{
        phase: 'generate',
        serviceId: 'web',
        file: 'app/page.tsx',
        actualChars: 100,
      }],
    });

    expect(call).toMatchObject({
      providerKind: 'openai',
      model: 'openai/gpt-5.6-terra',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      prompt,
    });
    expect(call.fetch).toBe(codexFetch);
    expect(call).not.toHaveProperty('apiKey');
    await completeAuthorizedLlmCall(run, root, call, null);
  });

  it('rejects near-miss OpenAI routes before approval', () => {
    const codexFetch = (async () => new Response()) as typeof fetch;
    const base = {
      providerKind: 'openai',
      model: 'openai/gpt-5.6-terra',
      authSource: 'oauth' as const,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      fetch: codexFetch,
    };
    for (const llm of [
      { ...base, model: 'openai/gpt-5.5' },
      { ...base, authSource: 'keychain' as const, apiKey: 'must-not-pass' },
      { ...base, baseURL: 'https://proxy.example/v1' },
      { ...base, fetch: undefined },
      { ...base, apiKey: 'must-not-pass' },
    ]) {
      expect(() => buildLlmRunPlan({ ...input, llm })).toThrow(expect.objectContaining({
        exitCode: 2,
        result: expect.objectContaining({
          diagnostics: [expect.objectContaining({
            code: llm.model === 'openai/gpt-5.5'
              ? 'RUNTIME_TRUST_MODEL_REQUIRED'
              : 'RUNTIME_TRUST_ROUTE_REQUIRED',
          })],
        }),
      }));
    }
  });

  it('binds claude-code to a distinct immutable route and the same consent and token ledger', async () => {
    const root = await runtimeRoot();
    const debugDir = join(root, '.doklo/debug');
    const prompt = 'exact local subprocess prompt';
    const claudeInput: LlmPlanInput = {
      llm: {
        providerKind: 'claude-code',
        model: 'anthropic/claude-sonnet-5',
        authSource: 'claude-code',
      },
      previews: [],
      candidateFiles: [{
        phase: 'generate',
        serviceId: 'web',
        file: 'app/page.tsx',
        maxChars: 2_000,
        dokId: 'AUTH',
      }],
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      workItems: [{ phase: 'generate', serviceId: 'web', id: 'AUTH' }],
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
        prompt,
        maxOutputTokens: 8_192,
      }],
      debugDir,
    };
    const plan = buildLlmRunPlan(claudeInput);
    const anthropicPlan = buildLlmRunPlan({
      ...claudeInput,
      llm: {
        providerKind: 'anthropic',
        model: 'anthropic/claude-sonnet-5',
        authSource: 'keychain',
      },
    });

    expect(plan).toMatchObject({
      providerKind: 'claude-code',
      route: 'claude-code-local',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'claude-code',
      maxTokensPerRun: 1_000_000,
      maxTokensTotal: 5_000_000,
    });
    expect(plan.digest).not.toBe(anthropicPlan.digest);
    const run = await authorizeLlmRun(root, plan, claudeInput.llm, {
      yes: true,
      isTTY: false,
    });
    const call = await beginAuthorizedLlmCall(run, root, {
      phase: 'generate',
      workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
      debugDir,
      prompt,
      transmissions: [{
        phase: 'generate',
        serviceId: 'web',
        file: 'app/page.tsx',
        actualChars: 2_000,
      }],
    });
    expect(call).toMatchObject({
      providerKind: 'claude-code',
      model: 'anthropic/claude-sonnet-5',
      prompt,
    });
    expect(call).not.toHaveProperty('apiKey');
    await completeAuthorizedLlmCall(run, root, call, null);
    const costLedger = JSON.parse(await readFile(
      join(root, '.doklo/cache/llm-token-ledger.json'),
      'utf8',
    )) as { calls: { state: string; reservedTokens: number }[] };
    expect(costLedger.calls).toEqual([
      expect.objectContaining({ state: 'retained', reservedTokens: expect.any(Number) }),
    ]);
    expect(costLedger.calls[0]!.reservedTokens).toBeGreaterThan(0);
  });

  it('rejects credentials and custom transports on the claude-code route', () => {
    const base = {
      providerKind: 'claude-code',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'claude-code' as const,
    };
    for (const llm of [
      { ...base, apiKey: 'must-not-pass' },
      { ...base, baseURL: 'https://proxy.example/v1' },
      { ...base, fetch: (async () => new Response()) as typeof fetch },
      { ...base, authSource: 'environment' as const },
      { ...base, providerKind: 'anthropic-api' },
    ]) {
      expect(() => buildLlmRunPlan({ ...input, llm })).toThrow(expect.objectContaining({
        exitCode: 2,
        result: expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'RUNTIME_TRUST_ROUTE_REQUIRED' })],
        }),
      }));
    }
  });

  it('rejects an empty zero-call plan as an authorized run', async () => {
    const plan = buildLlmRunPlan({
      ...input,
      previews: [],
      candidateFiles: [],
      workItems: [],
      calls: { consolidate: 0, lexicon: 0, generateMax: 0, judgeMax: 0 },
    });
    await expect(authorizeLlmRun(await runtimeRoot(), plan, input.llm, {
      yes: true,
      isTTY: false,
    })).rejects.toMatchObject({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'LLM_PLAN_INVALID' })],
      }),
    });
  });

  it('binds a one-shot run to the exact prompt, work item, debug directory, and transmission cap', async () => {
    const root = await runtimeRoot();
    const prompt = 'exact prompt';
    const debugDir = join(root, '.doklo/debug');
    const plan = buildLlmRunPlan({
      ...input,
      debugDir,
      previews: [],
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      workItems: [{ phase: 'generate', serviceId: 'web', id: 'AUTH' }],
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
        prompt,
        maxOutputTokens: 8_192,
      }],
    });
    const run = await authorizeLlmRun(root, plan, input.llm, { yes: true, isTTY: false });
    const actual = {
      phase: 'generate' as const,
      workItem: { phase: 'generate' as const, serviceId: 'web', id: 'AUTH' },
      debugDir,
      prompt,
      transmissions: [
        { phase: 'generate' as const, serviceId: 'web', file: 'app/page.tsx', actualChars: 2_000 },
      ],
    };

    await expect(beginAuthorizedLlmCall(run, root, actual)).resolves.toMatchObject({
      providerKind: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      prompt,
    });
    await expect(beginAuthorizedLlmCall(run, root, actual)).rejects.toMatchObject({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })],
      }),
    });
  });

  it('requires exact source coverage and rejects duplicate entries that aggregate past a cap', async () => {
    const root = await runtimeRoot();
    const debugDir = join(root, '.doklo/debug');
    const plan = buildLlmRunPlan({
      ...input,
      debugDir,
      previews: [],
      candidateFiles: [
        { phase: 'generate', serviceId: 'web', file: 'src/a.ts', maxChars: 2_000, dokId: 'A-001' },
        { phase: 'generate', serviceId: 'web', file: 'src/b.ts', maxChars: 2_000, dokId: 'B-001' },
      ],
      calls: { consolidate: 0, lexicon: 0, generateMax: 2, judgeMax: 0 },
      workItems: [
        { phase: 'generate', serviceId: 'web', id: 'A-001' },
        { phase: 'generate', serviceId: 'web', id: 'B-001' },
      ],
      preparedCalls: [
        {
          phase: 'generate',
          workItem: { phase: 'generate', serviceId: 'web', id: 'A-001' },
          prompt: 'prompt-a',
          maxOutputTokens: 1,
        },
        {
          phase: 'generate',
          workItem: { phase: 'generate', serviceId: 'web', id: 'B-001' },
          prompt: 'prompt-b',
          maxOutputTokens: 1,
        },
      ],
    });
    const run = await authorizeLlmRun(root, plan, input.llm, { yes: true, isTTY: false });

    await expect(beginAuthorizedLlmCall(run, root, {
      phase: 'generate',
      workItem: { phase: 'generate', serviceId: 'web', id: 'A-001' },
      debugDir,
      prompt: 'prompt-a',
      transmissions: [],
    })).rejects.toMatchObject({
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })] },
    });
    await expect(beginAuthorizedLlmCall(run, root, {
      phase: 'generate',
      workItem: { phase: 'generate', serviceId: 'web', id: 'B-001' },
      debugDir,
      prompt: 'prompt-b',
      transmissions: [
        { phase: 'generate', serviceId: 'web', file: 'src/b.ts', actualChars: 1_200 },
        { phase: 'generate', serviceId: 'web', file: 'src/b.ts', actualChars: 1_200 },
      ],
    })).rejects.toMatchObject({
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })] },
    });
  });

  it('signs source origin metadata and rejects an operation that changes it', async () => {
    const root = await runtimeRoot();
    const debugDir = join(root, '.doklo/debug');
    const plan = buildLlmRunPlan({
      ...input,
      debugDir,
      previews: [],
      candidateFiles: [{
        phase: 'generate',
        serviceId: 'service-b',
        originServiceId: 'service-a',
        codeRoot: 'apps/a',
        file: 'apps/a/src/roles.ts',
        maxChars: 12_000,
        dokId: 'BETA',
      }],
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      workItems: [{ phase: 'generate', serviceId: 'service-b', id: 'BETA' }],
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'service-b', id: 'BETA' },
        prompt: 'prompt-b',
        maxOutputTokens: 1,
      }],
    });
    expect(plan.transmissions).toEqual([expect.objectContaining({
      serviceId: 'service-b',
      originServiceId: 'service-a',
      codeRoot: 'apps/a',
      file: 'apps/a/src/roles.ts',
      workItemId: 'BETA',
    })]);
    const run = await authorizeLlmRun(root, plan, input.llm, { yes: true, isTTY: false });

    await expect(beginAuthorizedLlmCall(run, root, {
      phase: 'generate',
      workItem: { phase: 'generate', serviceId: 'service-b', id: 'BETA' },
      debugDir,
      prompt: 'prompt-b',
      transmissions: [{
        phase: 'generate',
        serviceId: 'service-b',
        originServiceId: 'service-b',
        codeRoot: 'apps/b',
        file: 'apps/a/src/roles.ts',
        actualChars: 16,
      }],
    })).rejects.toMatchObject({
      result: { diagnostics: [expect.objectContaining({ code: 'LLM_OPERATION_NOT_AUTHORIZED' })] },
    });
  });

  it('derives the displayed maximum from the exact UTF-8 prompt bytes and output allowances', () => {
    const plan = buildLlmRunPlan({
      ...input,
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      reservedTokensMax: 0,
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
        prompt: '한',
        maxOutputTokens: 32_768,
      }],
    } as LlmPlanInput);

    expect(plan.reservedTokensMax).toBeCloseTo(3 + 32_768, 12);
    expect(plan).toMatchObject({
      preparedCalls: [{
        phase: 'generate',
        promptBytes: 3,
        maxOutputTokens: 32_768,
      }],
    });
  });

  it('fails before approval when the exact prepared run cannot fit the configured run cap', () => {
    expect(() => buildLlmRunPlan({
      ...input,
      calls: { consolidate: 0, lexicon: 0, generateMax: 1, judgeMax: 0 },
      reservedTokensMax: 0,
      preparedCalls: [{
        phase: 'generate',
        workItem: { phase: 'generate', serviceId: 'web', id: 'AUTH' },
        prompt: 'x'.repeat(1_700_000),
        maxOutputTokens: 1,
      }],
    } as LlmPlanInput)).toThrow(expect.objectContaining({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'LLM_RUN_TOKEN_CAP' })],
      }),
    }));
  });

  it('issues a receipt for the exact digest and fails closed when the plan changes', async () => {
    const plan = buildLlmRunPlan(input);
    const receipt = await approveLlmRunPlan(plan, {
      yes: true,
      isTTY: false,
      now: () => '2026-07-16T12:00:00.000Z',
    });

    expect(receipt).toMatchObject({
      schema_version: 1,
      planDigest: plan.digest,
      mode: 'yes',
      approvedAt: '2026-07-16T12:00:00.000Z',
    });
    expect(receipt.receiptId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => assertLlmConsent(plan, receipt)).not.toThrow();

    const changed = buildLlmRunPlan({ ...input, reservedTokensMax: 430 });
    expect(() => assertLlmConsent(changed, receipt)).toThrow(expect.objectContaining({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'CONSENT_PLAN_CHANGED' })],
      }),
    }));

    expect(() => assertLlmConsent(plan, {
      ...receipt,
      mode: 'implicit',
    } as never)).toThrow(expect.objectContaining({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'CONSENT_PLAN_CHANGED' })],
      }),
    }));
  });
});

describe('token limit consent binding', () => {
  it('changes the consent digest when either adjustable limit changes', () => {
    const original = buildLlmRunPlan(input);
    expect(buildLlmRunPlan({ ...input, maxTokensPerRun: 2_000_000 }).digest).not.toBe(original.digest);
    expect(buildLlmRunPlan({ ...input, maxTokensTotal: 6_000_000 }).digest).not.toBe(original.digest);
  });
});
