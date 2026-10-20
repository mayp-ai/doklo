// The sync judge's role (`resolveLlmForRole('judge', …)` → resolveRuntimeTrustLlm)
// and its runtime-trust plans: Sonnet 5 (default) on the direct Anthropic route,
// or GPT-6 Luna on an OpenAI API key (default endpoint) or the exact Codex OAuth
// route; any other model fails naming the two. Luna binds only a judge-only
// plan; it never generates, and generation never runs on an OpenAI API key.
// No keychain, no network: credentials come from an in-memory store.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeTrustLlm, type DokloConfig } from '../src/lib/config.js';
import { memoryStore } from '../src/lib/credentials.js';
import type { CodexTokens } from '../src/lib/codex-auth.js';
import {
  authorizeLlmRun,
  beginAuthorizedLlmCall,
  buildLlmRunPlan,
  completeAuthorizedLlmCall,
  getAuthorizedJudgeRunModel,
  getAuthorizedLlmRunModel,
  type LlmPlanInput,
} from '../src/lib/llm-preflight.js';

const CODEX = 'https://chatgpt.com/backend-api/codex';
const oauthRecord: CodexTokens = {
  method: 'oauth',
  flavor: 'codex',
  access: 'a',
  refresh: 'r',
  expires: Date.now() + 3_600_000,
  accountId: 'acc',
};
const anthropicStore = () => memoryStore({ 'anthropic:default': 'sk-ant' });
const codexStore = () => memoryStore({ 'openai:default': JSON.stringify(oauthRecord) });

const refusal = (code: string, message?: RegExp) => expect.objectContaining({
  exitCode: 2,
  result: expect.objectContaining({
    diagnostics: [expect.objectContaining({ code, ...(message ? { message: expect.stringMatching(message) } : {}) })],
  }),
});

describe('the judge role', () => {
  it('defaults to Sonnet 5 on the direct Anthropic route', () => {
    const resolved = resolveRuntimeTrustLlm({ config: { models: {} }, store: anthropicStore(), role: 'judge' });
    expect(resolved).toMatchObject({ providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain', apiKey: 'sk-ant' });
    expect(resolved.baseURL).toBeUndefined();
    expect(resolved.fetch).toBeUndefined();
  });

  it('follows the user’s provider: an OpenAI regeneration model means GPT-6 Luna on Codex OAuth', () => {
    const config: DokloConfig = { models: { default: { primary: 'openai/gpt-5.6-terra' } } };
    const resolved = resolveRuntimeTrustLlm({ config, store: codexStore(), role: 'judge' });
    expect(resolved).toMatchObject({ providerKind: 'openai', model: 'openai/gpt-6-luna', authSource: 'oauth', baseURL: CODEX });
    expect(typeof resolved.fetch).toBe('function');
    // sync's --model names the regeneration model; the judge follows its provider.
    const followed = resolveRuntimeTrustLlm({ config: { models: {} }, store: codexStore(), role: 'judge', followModel: 'openai/gpt-5.6-terra' });
    expect(followed.model).toBe('openai/gpt-6-luna');
    const anthropic = resolveRuntimeTrustLlm({ config, store: anthropicStore(), role: 'judge', followModel: 'anthropic/claude-sonnet-5' });
    expect(anthropic.model).toBe('anthropic/claude-sonnet-5');
  });

  it('honours an explicit judge model (override, then `doklo model --task judge`) over the provider rule', () => {
    const config: DokloConfig = { models: { judge: { primary: 'openai/gpt-6-luna' }, default: { primary: 'anthropic/claude-sonnet-5' } } };
    expect(resolveRuntimeTrustLlm({ config, store: codexStore(), role: 'judge' }).model).toBe('openai/gpt-6-luna');
    expect(resolveRuntimeTrustLlm({ config, store: anthropicStore(), role: 'judge', modelOverride: 'anthropic/claude-sonnet-5' }).model)
      .toBe('anthropic/claude-sonnet-5');
  });

  it('refuses any other model with a message naming the two judge models', () => {
    const naming = /"anthropic\/claude-sonnet-5" \(default\) or "openai\/gpt-6-luna"; resolved "openai\/gpt-5\.6-terra"/;
    expect(() => resolveRuntimeTrustLlm({ config: { models: {} }, store: codexStore(), role: 'judge', modelOverride: 'openai/gpt-5.6-terra' }))
      .toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED', naming));
    expect(() => resolveRuntimeTrustLlm({ config: { models: { judge: { primary: 'anthropic/claude-sonnet-4-5' } } }, store: anthropicStore(), role: 'judge' }))
      .toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED', /The sync judge requires model/));
  });

  it('admits GPT-6 Luna on an OpenAI API key from the keychain when the judge role is pinned', () => {
    const resolved = resolveRuntimeTrustLlm({
      config: { models: { judge: { primary: 'openai/gpt-6-luna' } } },
      store: memoryStore({ 'openai:default': 'sk-openai' }),
      role: 'judge',
    });
    expect(resolved).toMatchObject({ providerKind: 'openai', model: 'openai/gpt-6-luna', authSource: 'keychain', apiKey: 'sk-openai' });
    expect(resolved.baseURL).toBeUndefined();
    expect(resolved.fetch).toBeUndefined();
  });

  it('admits GPT-6 Luna on OPENAI_API_KEY when nothing is stored (a headless runner)', () => {
    const previous = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-env';
    try {
      const resolved = resolveRuntimeTrustLlm({
        config: { models: { judge: { primary: 'openai/gpt-6-luna' } } },
        store: memoryStore(),
        role: 'judge',
      });
      expect(resolved).toMatchObject({ providerKind: 'openai', model: 'openai/gpt-6-luna', authSource: 'environment', apiKey: 'sk-env' });
      expect(resolved.baseURL).toBeUndefined();
      expect(resolved.fetch).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('refuses a GPT-6 Luna judge without an OpenAI API credential', () => {
    const previous = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      expect(() => resolveRuntimeTrustLlm({
        config: { models: { judge: { primary: 'openai/gpt-6-luna' } } },
        store: memoryStore(),
        role: 'judge',
      })).toThrow(refusal(
        'RUNTIME_TRUST_CREDENTIAL_REQUIRED',
        /^The sync judge requires an Anthropic or OpenAI API credential from the keychain or environment\.$/,
      ));
    } finally {
      if (previous !== undefined) process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('refuses the local Claude Code route, naming the three judge routes', () => {
    expect(() => resolveRuntimeTrustLlm({
      config: { models: {} },
      store: memoryStore(),
      role: 'judge',
      backendOverride: 'claude-code',
    })).toThrow(refusal(
      'RUNTIME_TRUST_ROUTE_REQUIRED',
      /^The sync judge requires direct Anthropic \(Sonnet 5\), an OpenAI API key \(GPT-6 Luna\), or exact OpenAI Codex OAuth \(GPT-6 Luna\)\.$/,
    ));
  });

  it('never lets generation run on an OpenAI API key', () => {
    expect(() => resolveRuntimeTrustLlm({
      config: { models: { default: { primary: 'openai/gpt-5.6-terra' } } },
      store: memoryStore({ 'openai:default': 'sk-openai' }),
      role: 'generate',
    })).toThrow(refusal('RUNTIME_TRUST_ROUTE_REQUIRED', /^Runtime trust requires direct Anthropic, credential-free local Claude Code, or exact OpenAI Codex OAuth\.$/));
  });

  it('never lets generation resolve GPT-6 Luna', () => {
    expect(() => resolveRuntimeTrustLlm({
      config: { models: { default: { primary: 'openai/gpt-6-luna' } } },
      store: codexStore(),
      role: 'generate',
    })).toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED', /"anthropic\/claude-sonnet-5", "openai\/gpt-5\.6-terra", or "openai\/gpt-5\.6-luna"/));
  });
});

describe('judge plans under runtime trust', () => {
  const codexFetch = (async () => new Response()) as typeof fetch;
  const luna = { providerKind: 'openai', model: 'openai/gpt-6-luna', authSource: 'oauth' as const, baseURL: CODEX, fetch: codexFetch };
  const lunaKey = { providerKind: 'openai', model: 'openai/gpt-6-luna', authSource: 'keychain' as const, apiKey: 'sk-openai' };
  const sonnet = { providerKind: 'anthropic', model: 'anthropic/claude-sonnet-5', authSource: 'keychain' as const, apiKey: 'test-key' };

  async function runtimeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'doklo-judge-trust-'));
    await mkdir(join(root, '.doklo/cache'), { recursive: true });
    return root;
  }

  const judgeInput = (llm: LlmPlanInput['llm'], debugDir: string, phase: 'judge' | 'generate' = 'judge'): LlmPlanInput => ({
    llm,
    candidateFiles: [{ phase, serviceId: 'web', file: 'src/auth.ts', maxChars: 120, dokId: 'AUTH' }],
    workItems: [{ phase, serviceId: 'web', id: 'AUTH' }],
    calls: { consolidate: 0, lexicon: 0, generateMax: phase === 'generate' ? 1 : 0, judgeMax: phase === 'judge' ? 1 : 0 },
    preparedCalls: [{ phase, workItem: { phase, serviceId: 'web', id: 'AUTH' }, prompt: 'exact judge prompt', maxOutputTokens: 8_192 }],
    debugDir,
  });

  it('binds GPT-6 Luna to a judge-only plan on the exact Codex route, through consent and the token ledger', async () => {
    const root = await runtimeRoot();
    const debugDir = join(root, '.doklo/debug');
    const plan = buildLlmRunPlan(judgeInput(luna, debugDir));
    expect(plan).toMatchObject({ model: 'openai/gpt-6-luna', route: 'openai-codex-oauth', calls: { judgeMax: 1, totalMax: 1 } });
    expect(plan.preparedCalls[0]).toMatchObject({ phase: 'judge', maxOutputTokens: 8_192 });

    const run = await authorizeLlmRun(root, plan, luna, { yes: true, isTTY: false });
    expect(await getAuthorizedJudgeRunModel(run, root)).toBe('openai/gpt-6-luna');
    await expect(getAuthorizedLlmRunModel(run, root)).rejects.toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED'));
    const call = await beginAuthorizedLlmCall(run, root, {
      phase: 'judge',
      workItem: { phase: 'judge', serviceId: 'web', id: 'AUTH' },
      debugDir,
      prompt: 'exact judge prompt',
      transmissions: [{ phase: 'judge', serviceId: 'web', file: 'src/auth.ts', actualChars: 120 }],
    });
    expect(call).toMatchObject({ providerKind: 'openai', model: 'openai/gpt-6-luna', baseURL: CODEX });
    expect(call.fetch).toBe(codexFetch);
    await completeAuthorizedLlmCall(run, root, call, { input_tokens: 10, output_tokens: 5 });
  });

  it.each(['keychain', 'environment'] as const)(
    'binds GPT-6 Luna to a judge-only plan on an OpenAI API key (%s), through consent and the token ledger',
    async (authSource) => {
      const root = await runtimeRoot();
      const debugDir = join(root, '.doklo/debug');
      const llm = { ...lunaKey, authSource };
      const plan = buildLlmRunPlan(judgeInput(llm, debugDir));
      expect(plan).toMatchObject({
        providerKind: 'openai',
        model: 'openai/gpt-6-luna',
        route: 'openai-api-key',
        authSource,
        calls: { judgeMax: 1, totalMax: 1 },
      });
      expect(JSON.stringify(plan)).not.toContain('sk-openai');

      const run = await authorizeLlmRun(root, plan, llm, { yes: true, isTTY: false });
      expect(await getAuthorizedJudgeRunModel(run, root)).toBe('openai/gpt-6-luna');
      await expect(getAuthorizedLlmRunModel(run, root)).rejects.toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED'));
      const call = await beginAuthorizedLlmCall(run, root, {
        phase: 'judge',
        workItem: { phase: 'judge', serviceId: 'web', id: 'AUTH' },
        debugDir,
        prompt: 'exact judge prompt',
        transmissions: [{ phase: 'judge', serviceId: 'web', file: 'src/auth.ts', actualChars: 120 }],
      });
      expect(call).toMatchObject({ providerKind: 'openai', model: 'openai/gpt-6-luna', apiKey: 'sk-openai', prompt: 'exact judge prompt' });
      // No custom transport: the generator uses the default api.openai.com endpoint.
      expect(call).not.toHaveProperty('baseURL');
      expect(call).not.toHaveProperty('fetch');
      await completeAuthorizedLlmCall(run, root, call, { input_tokens: 10, output_tokens: 5 });
    },
  );

  it('binds Sonnet 5 to a judge plan on the direct Anthropic route', async () => {
    const root = await runtimeRoot();
    const plan = buildLlmRunPlan(judgeInput(sonnet, join(root, '.doklo/debug')));
    expect(plan).toMatchObject({ model: 'anthropic/claude-sonnet-5', route: 'anthropic-default' });
    const run = await authorizeLlmRun(root, plan, sonnet, { yes: true, isTTY: false });
    expect(await getAuthorizedJudgeRunModel(run, root)).toBe('anthropic/claude-sonnet-5');
  });

  it('refuses GPT-6 Luna in a generation plan and Terra in a judge plan', () => {
    expect(() => buildLlmRunPlan(judgeInput(luna, '/repo/.doklo/debug', 'generate')))
      .toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED'));
    expect(() => buildLlmRunPlan(judgeInput({ ...luna, model: 'openai/gpt-5.6-terra' }, '/repo/.doklo/debug')))
      .toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED', /The sync judge requires model/));
  });

  it('refuses an OpenAI API key for generation: Terra on the route, Luna as a model', () => {
    expect(() => buildLlmRunPlan(judgeInput({ ...lunaKey, model: 'openai/gpt-5.6-terra' }, '/repo/.doklo/debug', 'generate')))
      .toThrow(refusal('RUNTIME_TRUST_ROUTE_REQUIRED'));
    expect(() => buildLlmRunPlan(judgeInput(lunaKey, '/repo/.doklo/debug', 'generate')))
      .toThrow(refusal('RUNTIME_TRUST_MODEL_REQUIRED'));
  });

  it('refuses near-miss OpenAI API-key judge routes: a custom base URL, a custom fetch, an OAuth auth source', () => {
    for (const llm of [
      { ...lunaKey, baseURL: 'https://proxy.example/v1' },
      { ...lunaKey, fetch: codexFetch },
      { ...lunaKey, authSource: 'oauth' as const },
    ]) {
      expect(() => buildLlmRunPlan(judgeInput(llm, '/repo/.doklo/debug')))
        .toThrow(refusal('RUNTIME_TRUST_ROUTE_REQUIRED', /^The sync judge requires direct Anthropic/));
    }
  });

  it('refuses a judge plan on the OpenAI API-key route without a key', () => {
    for (const apiKey of [undefined, '']) {
      expect(() => buildLlmRunPlan(judgeInput({ ...lunaKey, authSource: 'environment', apiKey }, '/repo/.doklo/debug')))
        .toThrow(refusal('RUNTIME_TRUST_CREDENTIAL_REQUIRED', /The sync judge requires an Anthropic or OpenAI API credential/));
    }
  });

  it('refuses the local Claude Code route for a judge plan', () => {
    expect(() => buildLlmRunPlan(judgeInput({ providerKind: 'claude-code', model: 'anthropic/claude-sonnet-5', authSource: 'claude-code' }, '/repo/.doklo/debug')))
      .toThrow(refusal('RUNTIME_TRUST_ROUTE_REQUIRED', /sync judge/));
  });

  it('a generation run is not a judge run', async () => {
    const root = await runtimeRoot();
    const plan = buildLlmRunPlan(judgeInput(sonnet, join(root, '.doklo/debug'), 'generate'));
    const run = await authorizeLlmRun(root, plan, sonnet, { yes: true, isTTY: false });
    await expect(getAuthorizedJudgeRunModel(run, root)).rejects.toThrow(refusal('LLM_OPERATION_NOT_AUTHORIZED'));
    await expect(beginAuthorizedLlmCall(run, root, {
      phase: 'judge',
      workItem: { phase: 'judge', serviceId: 'web', id: 'AUTH' },
      debugDir: join(root, '.doklo/debug'),
      prompt: 'exact judge prompt',
      transmissions: [{ phase: 'judge', serviceId: 'web', file: 'src/auth.ts', actualChars: 120 }],
    })).rejects.toThrow(refusal('LLM_OPERATION_NOT_AUTHORIZED'));
  });
});
