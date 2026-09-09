// A failed provider call must leave enough behind to diagnose it. The AI SDK's
// APICallError carries the HTTP status and the provider's response body — for
// Anthropic that body is what distinguishes "unknown model" from "key lacks
// access to this model", two failures with completely different fixes. The
// record is written to an explicitly authorized debug dir, so it must never
// carry a credential.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel } from '../src/llm-client.js';

const SECRET = 'sk-ant-DEBUG_CANARY_0123456789';

function apiCallError(): Error {
  return Object.assign(new Error('Not Found'), {
    name: 'AI_APICallError',
    statusCode: 404,
    url: 'https://api.anthropic.com/v1/messages',
    responseBody:
      '{"type":"error","error":{"type":"not_found_error","message":"model: claude-bogus"}}',
    responseHeaders: {
      'x-api-key': SECRET,
      authorization: `Bearer ${SECRET}`,
      'request-id': 'req_0123456789',
    },
  });
}

const config = {
  model: 'anthropic/claude-bogus',
  maxTokens: 8,
  timeout: 1_000,
  providerKind: 'anthropic' as const,
  apiKey: 'sk-test',
};

describe('AI SDK provider failure (debug artifact)', () => {
  it('persists the provider status code and response body', async () => {
    const debugDir = await mkdtemp(join(tmpdir(), 'doklo-ai-sdk-debug-'));
    try {
      const result = await callModel(
        { userPrompt: 'hi', label: 'dok-BOOKS' },
        { ...config, debugDir },
        { generateText: (async () => { throw apiCallError(); }) as never },
      );

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('ai_sdk_error');
      // The debug channel stays out of the public result (ledgers, diagnostics).
      expect(result.debug).toBeUndefined();

      const [file] = await readdir(debugDir);
      const record = JSON.parse(await readFile(join(debugDir, file!), 'utf8'));
      const http = record.output.debug.providerHttp;
      expect(http.statusCode).toBe(404);
      expect(http.url).toBe('https://api.anthropic.com/v1/messages');
      expect(http.responseBody).toContain('not_found_error');
      expect(http.responseBody).toContain('model: claude-bogus');
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it('redacts credential-bearing response headers before writing', async () => {
    const debugDir = await mkdtemp(join(tmpdir(), 'doklo-ai-sdk-debug-'));
    try {
      await callModel(
        { userPrompt: 'hi' },
        { ...config, debugDir },
        { generateText: (async () => { throw apiCallError(); }) as never },
      );

      const [file] = await readdir(debugDir);
      const raw = await readFile(join(debugDir, file!), 'utf8');
      const headers = JSON.parse(raw).output.debug.providerHttp.responseHeaders;
      expect(headers['x-api-key']).toBe('[REDACTED]');
      expect(headers['authorization']).toBe('[REDACTED]');
      expect(headers['request-id']).toBe('req_0123456789');
      expect(raw).not.toContain(SECRET);
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });

  it('surfaces the provider body in the error message so the CLI can show it', async () => {
    const result = await callModel(
      { userPrompt: 'hi' },
      config,
      { generateText: (async () => { throw apiCallError(); }) as never },
    );
    expect(result.error?.message).toContain('HTTP 404');
    expect(result.error?.message).toContain('not_found_error');
  });

  it('omits providerHttp when no debug dir is authorized', async () => {
    const result = await callModel(
      { userPrompt: 'hi' },
      config,
      { generateText: (async () => { throw apiCallError(); }) as never },
    );
    expect(result.debug).toBeUndefined();
  });
});
