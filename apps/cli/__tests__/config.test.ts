import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig, saveConfig, resolveLlm, resolveRuntimeTrustLlm, providerDefFor,
  type DokloConfig,
} from '../src/lib/config.js';
import { memoryStore } from '../src/lib/credentials.js';
import type { CodexTokens } from '../src/lib/codex-auth.js';

describe('loadConfig / saveConfig', () => {
  it('returns an empty model map when the file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-cfg-'));
    const cfg = await loadConfig(join(dir, 'nope.json'));
    expect(cfg).toEqual({ models: {} });
  });
  it('round-trips through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-cfg-'));
    const file = join(dir, 'sub', 'config.json');
    const cfg: DokloConfig = { models: { default: { primary: 'anthropic/claude-sonnet-4-5' } } };
    await saveConfig(cfg, file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(cfg);
    expect(await loadConfig(file)).toEqual(cfg);
  });
});

describe('providerDefFor', () => {
  it('returns a builtin provider def', () => {
    expect(providerDefFor({ models: {} }, 'anthropic')).toEqual({ kind: 'anthropic' });
    expect(providerDefFor({ models: {} }, 'google')?.kind).toBe('openai-compatible');
  });
  it('lets user config override or add providers', () => {
    const cfg: DokloConfig = {
      models: {},
      providers: { exaone: { kind: 'openai-compatible', baseURL: 'https://x/v1' } },
    };
    expect(providerDefFor(cfg, 'exaone')).toEqual({ kind: 'openai-compatible', baseURL: 'https://x/v1' });
  });
});

describe('resolveLlm – back-compat / BYOK regressions', () => {
  it('C1: empty config with no overrides returns claude-code fallback (does NOT throw)', () => {
    const store = memoryStore();
    const r = resolveLlm({ config: { models: {} }, store, role: 'generate' });
    expect(r.providerKind).toBe('claude-code');
    expect(r.model).toBe('claude-sonnet-4-20250514');
    expect(r.authSource).toBe('claude-code');
  });

  it('I1a: explicit backendOverride="claude-code" wins over a configured default model', () => {
    const cfg: DokloConfig = { models: { default: { primary: 'anthropic/claude-sonnet-4-5' } } };
    const store = memoryStore({ 'anthropic:default': 'sk-ant' });
    const r = resolveLlm({ config: cfg, store, role: 'default', backendOverride: 'claude-code' });
    expect(r.providerKind).toBe('claude-code');
  });

  it('I1b: backendOverride="anthropic-api" + configured model + stored key → providerKind anthropic', () => {
    const cfg: DokloConfig = { models: { default: { primary: 'anthropic/claude-sonnet-4-5' } } };
    const store = memoryStore({ 'anthropic:default': 'sk-ant' });
    const r = resolveLlm({ config: cfg, store, role: 'default', backendOverride: 'anthropic-api' });
    expect(r.providerKind).toBe('anthropic');
    expect(r.apiKey).toBe('sk-ant');
  });
});

describe('resolveLlm', () => {
  const config: DokloConfig = {
    models: {
      default: { primary: 'anthropic/claude-sonnet-4-5' },
      consolidate: { primary: 'openai/gpt-4o' },
    },
  };
  it('uses the per-role model and the stored key for that provider', () => {
    const store = memoryStore({ 'openai:default': 'sk-oai' });
    const r = resolveLlm({ config, store, role: 'consolidate' });
    expect(r).toEqual({
      providerKind: 'openai', model: 'openai/gpt-4o', apiKey: 'sk-oai', authSource: 'keychain',
    });
  });
  it('falls back to the default role when the role is unset', () => {
    const store = memoryStore({ 'anthropic:default': 'sk-ant' });
    const r = resolveLlm({ config, store, role: 'lexicon' });
    expect(r.model).toBe('anthropic/claude-sonnet-4-5');
    expect(r.providerKind).toBe('anthropic');
    expect(r.authSource).toBe('keychain');
  });
  it('honors a model override while resolving its key from the keychain', () => {
    const store = memoryStore({ 'openrouter:default': 'sk-or' });
    const r = resolveLlm({
      config, store, role: 'default',
      modelOverride: 'openrouter/anthropic/claude-sonnet-4-5',
    });
    expect(r).toEqual({
      providerKind: 'openrouter', model: 'openrouter/anthropic/claude-sonnet-4-5', apiKey: 'sk-or', authSource: 'keychain',
    });
  });
  it('carries baseURL for openai-compatible providers (google)', () => {
    const store = memoryStore({ 'google:default': 'sk-gem' });
    const r = resolveLlm({ config: { models: { default: { primary: 'google/gemini-2.5-pro' } } }, store, role: 'default' });
    expect(r.providerKind).toBe('openai-compatible');
    expect(r.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
  });
});

describe('resolveLlm – OAuth detection (O3)', () => {
  const oauthConfig: DokloConfig = {
    models: { default: { primary: 'openai/gpt-5.5' } },
  };

  const oauthRecord: CodexTokens = {
    method: 'oauth',
    flavor: 'codex',
    access: 'a',
    refresh: 'r',
    expires: Date.now() + 3_600_000,
    accountId: 'acc',
  };

  it('O3-1: OAuth record → providerKind=openai, codex baseURL, fetch is a function', () => {
    const store = memoryStore({ 'openai:default': JSON.stringify(oauthRecord) });
    const r = resolveLlm({ config: oauthConfig, store, role: 'default' });
    expect(r.providerKind).toBe('openai');
    expect(r.baseURL).toBe('https://chatgpt.com/backend-api/codex');
    expect(typeof r.fetch).toBe('function');
    expect(r.apiKey).toBeUndefined();
    expect(r.authSource).toBe('oauth');
  });

  it('O3-2: raw API key string → api-key path, fetch undefined, apiKey set', () => {
    const store = memoryStore({ 'openai:default': 'sk-oai-rawkey' });
    const r = resolveLlm({ config: oauthConfig, store, role: 'default' });
    expect(r.providerKind).toBe('openai');
    expect(r.apiKey).toBe('sk-oai-rawkey');
    expect(r.authSource).toBe('keychain');
    expect(r.fetch).toBeUndefined();
    expect(r.baseURL).toBeUndefined();
  });

  it('O3-3: malformed JSON / plain key never throws', () => {
    const candidates = [
      'not-json',
      '{"no_method": true}',
      '',
      '{"method":"apikey"}',
      '42',
    ];
    for (const val of candidates) {
      const store = memoryStore({ 'openai:default': val });
      expect(() => resolveLlm({ config: oauthConfig, store, role: 'default' })).not.toThrow();
    }
  });

  it('O3-4: non-openai providers with JSON-looking values are not affected', () => {
    const anthropicConfig: DokloConfig = {
      models: { default: { primary: 'anthropic/claude-sonnet-4-5' } },
    };
    // Store a JSON string under anthropic — should be treated as api-key string
    const store = memoryStore({ 'anthropic:default': '{"method":"oauth","flavor":"codex","access":"a","refresh":"r","expires":9999999999999}' });
    const r = resolveLlm({ config: anthropicConfig, store, role: 'default' });
    expect(r.providerKind).toBe('anthropic');
    // The stored JSON string is used as the raw api key (provider !== openai)
    expect(r.fetch).toBeUndefined();
  });
});

describe('resolveLlm auth source metadata', () => {
  it('defaults a fresh runtime-trust config to direct Anthropic Sonnet 5', () => {
    const resolved = resolveRuntimeTrustLlm({
      config: { models: {} },
      store: memoryStore({ 'anthropic:default': 'sk-ant' }),
      role: 'generate',
    });

    expect(resolved).toMatchObject({
      providerKind: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'keychain',
      apiKey: 'sk-ant',
    });
    expect(resolved.baseURL).toBeUndefined();
    expect(resolved.fetch).toBeUndefined();
  });

  it('fails accurately when the fresh runtime-trust route has no credential', () => {
    const previous = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => resolveRuntimeTrustLlm({
        config: { models: {} },
        store: memoryStore(),
        role: 'generate',
      })).toThrow(expect.objectContaining({
        exitCode: 2,
        result: expect.objectContaining({
          diagnostics: [expect.objectContaining({ code: 'RUNTIME_TRUST_CREDENTIAL_REQUIRED' })],
        }),
      }));
    } finally {
      if (previous !== undefined) process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('reports environment credentials without exposing their value in metadata', () => {
    const previous = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'secret-from-env';
    try {
      const r = resolveLlm({
        config: { models: { default: { primary: 'anthropic/claude-sonnet-5' } } },
        store: memoryStore(),
        role: 'default',
      });
      expect(r.authSource).toBe('environment');
      expect(JSON.stringify({ authSource: r.authSource })).not.toContain('secret-from-env');
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('accepts the exact Codex OAuth Terra runtime-trust route', () => {
    const oauthRecord: CodexTokens = {
      method: 'oauth',
      flavor: 'codex',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 3_600_000,
      accountId: 'acc',
    };
    const resolved = resolveRuntimeTrustLlm({
      config: { models: { default: { primary: 'openai/gpt-5.6-terra' } } },
      store: memoryStore({ 'openai:default': JSON.stringify(oauthRecord) }),
      role: 'generate',
    });

    expect(resolved).toMatchObject({
      providerKind: 'openai',
      model: 'openai/gpt-5.6-terra',
      authSource: 'oauth',
      baseURL: 'https://chatgpt.com/backend-api/codex',
    });
    expect(typeof resolved.fetch).toBe('function');
    expect(resolved.apiKey).toBeUndefined();
  });

  it('fails closed when runtime trust resolves a model outside the exact allowlist', () => {
    expect(() => resolveRuntimeTrustLlm({
      config: { models: { default: { primary: 'anthropic/claude-sonnet-4-5' } } },
      store: memoryStore({ 'anthropic:default': 'key' }),
      role: 'default',
    })).toThrow(expect.objectContaining({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'RUNTIME_TRUST_MODEL_REQUIRED' })],
      }),
    }));
  });

  it('fails closed when Sonnet 5 resolves through a non-default route', () => {
    const store = memoryStore({ 'anthropic:default': 'key' });
    expect(() => resolveRuntimeTrustLlm({
      config: {
        models: { default: { primary: 'anthropic/claude-sonnet-5' } },
        providers: { anthropic: { kind: 'anthropic' as const, baseURL: 'https://proxy.example/v1' } },
      },
      store,
      role: 'default',
    })).toThrow(expect.objectContaining({
      exitCode: 2,
      result: expect.objectContaining({
        diagnostics: [expect.objectContaining({ code: 'RUNTIME_TRUST_ROUTE_REQUIRED' })],
      }),
    }));
  });

  it('authorizes an explicit credential-free claude-code runtime-trust route', () => {
    const resolved = resolveRuntimeTrustLlm({
      config: { models: {} },
      store: memoryStore(),
      role: 'generate',
      backendOverride: 'claude-code',
    });

    expect(resolved).toEqual({
      providerKind: 'claude-code',
      model: 'anthropic/claude-sonnet-5',
      authSource: 'claude-code',
    });
  });
});
