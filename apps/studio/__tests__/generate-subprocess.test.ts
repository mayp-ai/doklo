// @vitest-environment jsdom

import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseProgressLine, streamCliGenerate, type CliChild } from '../lib/generate-subprocess';
import { doneCounters } from '../lib/generate-progress';
import type { ConsolidatedFeatureConfig } from '../lib/consolidation';
import { GeneratePanel } from '../components/consolidation/generate-panel';
import { SaveBar } from '../components/consolidation/save-bar';
import { StudioProvider } from '../components/studio-store';

describe('parseProgressLine', () => {
  it('parses a JSON line with a stage field', () => {
    expect(parseProgressLine('{"stage":"plan","total":2}')).toEqual({ stage: 'plan', total: 2 });
  });
  it('returns null for an empty line', () => {
    expect(parseProgressLine('  ')).toBeNull();
  });
  it('rejects every non-empty malformed line', () => {
    expect(() => parseProgressLine('  \x1b[36mGenerating 2 Dok(s)\x1b[0m')).toThrow(
      'invalid machine output',
    );
    expect(() => parseProgressLine('{"foo":1}')).toThrow('invalid machine output');
  });
});

// A fake child: EventEmitter with stdout/stderr sub-emitters (data events).
function fakeChild() {
  const child = new EventEmitter() as unknown as CliChild & EventEmitter;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { kill: CliChild['kill'] }).kill = vi.fn(() => true);
  return child as unknown as CliChild & EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
}

class FakeGenerationStream {
  static instances: FakeGenerationStream[] = [];

  readonly body: ReadableStream<Uint8Array>;
  closed = false;
  private readonly encoder = new TextEncoder();
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor() {
    this.body = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    FakeGenerationStream.instances.push(this);
  }

  emit(event: Record<string, unknown>): void {
    this.controller.enqueue(
      this.encoder.encode(`${JSON.stringify(event)}\n`),
    );
  }

  fail(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.error(new Error('Generation stream connection error'));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

interface MountedPanel {
  host: HTMLDivElement;
  root: Root;
  unmounted: boolean;
}

const mountedPanels: MountedPanel[] = [];

beforeEach(() => {
  document.body.replaceChildren();
  FakeGenerationStream.instances = [];
  vi.stubGlobal('React', React);
  let consentSequence = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const action = new Headers(init?.headers).get('x-doklo-generation-action');
    if (action === 'request-consent') {
      consentSequence += 1;
      return Response.json({ consentToken: `test-consent-${consentSequence}` });
    }
    if (action === 'start-generation') {
      const source = new FakeGenerationStream();
      return new Response(source.body, {
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      });
    }
    return new Response(null, { status: 400 });
  }));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    [{}] as unknown as DOMRectList,
  );
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const source of FakeGenerationStream.instances) source.close();
    await Promise.resolve();
  });
  for (const panel of [...mountedPanels].reverse()) {
    await unmountPanel(panel);
  }
  mountedPanels.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function renderPanel(onClose = vi.fn()): Promise<MountedPanel> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const panel = { host, root, unmounted: false };
  mountedPanels.push(panel);
  await act(async () => {
    root.render(createElement(GeneratePanel, { service: 'web', onClose }));
  });
  return panel;
}

async function unmountPanel(panel: MountedPanel): Promise<void> {
  if (panel.unmounted) return;
  await act(async () => {
    panel.root.unmount();
  });
  panel.host.remove();
  panel.unmounted = true;
}

async function emitProgress(
  source: FakeGenerationStream,
  event: Record<string, unknown>,
): Promise<void> {
  await act(async () => {
    source.emit(event);
    if (event.stage === 'clean-close' || event.stage === 'error') source.close();
    await Promise.resolve();
  });
}

async function failStream(source: FakeGenerationStream): Promise<void> {
  await act(async () => {
    source.fail();
    await Promise.resolve();
  });
}

async function startPanelGeneration(): Promise<FakeGenerationStream> {
  const start = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.trim() === 'Start generation');
  if (!start) throw new Error('Start generation button was not found');
  await act(async () => {
    start.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  const source = FakeGenerationStream.instances.at(-1);
  if (!source) throw new Error('Generation stream was not started');
  return source;
}

function consolidationConfig(): ConsolidatedFeatureConfig {
  return {
    projectName: 'demo',
    basedOnFeaturesAt: '2026-07-16T00:00:00.000Z',
    generatedAt: '2026-07-16T00:00:00.000Z',
    model: 'test',
    originalFeatureIds: ['sign-in'],
    userReviewed: false,
    stats: {
      originalFeatures: 1,
      consolidatedFeatures: 1,
      merges: 0,
      excluded: 0,
    },
    groups: [
      {
        group_id: 'account',
        label: 'Account',
        excluded: [],
        features: [
          {
            canonical_id: 'sign-in',
            label: 'Sign in',
            decision: 'keep',
            members: ['sign-in'],
            primary_route: '/sign-in',
            reason: '',
            user_reviewed: false,
            dok_id_prefix: 'AUTH',
          },
        ],
      },
    ],
  };
}

const malformedDoneSummaries: Array<{
  label: string;
  summary: Record<string, unknown>;
}> = [
  { label: 'missing succeeded', summary: { failed: 0, layerFailed: 0 } },
  { label: 'missing failed', summary: { succeeded: 1, layerFailed: 0 } },
  { label: 'missing layerFailed', summary: { succeeded: 1, failed: 0 } },
  { label: 'string succeeded', summary: { succeeded: '1', failed: 0, layerFailed: 0 } },
  { label: 'string failed', summary: { succeeded: 1, failed: '0', layerFailed: 0 } },
  { label: 'string layerFailed', summary: { succeeded: 1, failed: 0, layerFailed: '0' } },
  { label: 'NaN-like succeeded', summary: { succeeded: Number.NaN, failed: 0, layerFailed: 0 } },
  { label: 'NaN-like failed', summary: { succeeded: 1, failed: Number.NaN, layerFailed: 0 } },
  { label: 'NaN-like layerFailed', summary: { succeeded: 1, failed: 0, layerFailed: Number.NaN } },
  { label: 'fractional succeeded', summary: { succeeded: 0.5, failed: 0, layerFailed: 0 } },
  { label: 'fractional failed', summary: { succeeded: 1, failed: 0.5, layerFailed: 0 } },
  { label: 'fractional layerFailed', summary: { succeeded: 1, failed: 0, layerFailed: 0.5 } },
  { label: 'negative succeeded', summary: { succeeded: -1, failed: 0, layerFailed: 0 } },
  { label: 'negative failed', summary: { succeeded: 1, failed: -1, layerFailed: 0 } },
  { label: 'negative layerFailed', summary: { succeeded: 1, failed: 0, layerFailed: -1 } },
];

describe('doneCounters', () => {
  it('returns all raw counters when they are nonnegative integers', () => {
    expect(doneCounters({ succeeded: 1, failed: 0, layerFailed: 0 })).toEqual({
      succeeded: 1,
      failed: 0,
      layerFailed: 0,
    });
    expect(doneCounters({ succeeded: 4, failed: 2, layerFailed: 3 })).toEqual({
      succeeded: 4,
      failed: 2,
      layerFailed: 3,
    });
  });

  it.each(malformedDoneSummaries)(
    'rejects a completion summary with $label',
    ({ summary }) => {
      expect(doneCounters(summary)).toBeNull();
    },
  );
});

describe('streamCliGenerate', () => {
  it('spawns the CLI with the current Node executable and exact machine arguments', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      () => undefined,
      { spawn },
    );

    child.stdout.emit(
      'data',
      '{"stage":"done","succeeded":0,"failed":0,"layerFailed":0}\n',
    );
    child.emit('close', 0);
    await p;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        '/x/cli.js',
        'generate',
        '--progress-json',
        '--yes',
        '--service',
        'web',
        '--root',
        '/w',
      ],
      { cwd: '/w' },
    );
  });

  it('consumes the CLI command-result envelope before bridge-owned clean close', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => {
        if (event.stage === 'result') {
          return Promise.reject(new Error('browser rejected command result'));
        }
        events.push(event as { stage: string });
      },
      { spawn: () => child },
    );

    child.stdout.emit(
      'data',
      [
        { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
        {
          stage: 'result',
          result: {
            schema_version: 1,
            command: 'generate',
            status: 'success',
            data: {
              results: [{ serviceId: 'web', dokId: 'AUTH-SIGNIN', outputPath: '/w/.doklo/hub/doks/AUTH-SIGNIN.json' }],
              failures: [],
              skippedExisting: [],
              emptyAnchorDokIds: [],
              plan: [{ serviceId: 'web', dokId: 'AUTH-SIGNIN', featureLabel: 'Sign in', domain: 'auth' }],
              layers: {
                roles: { status: 'updated', added: 1, kept: 0 },
                ia: [],
                codeMapping: [],
              },
              layerFailures: [],
              transmissions: [],
            },
            diagnostics: [],
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    child.emit('close', 0);

    await p;

    expect(events.map((event) => event.stage)).toEqual(['done', 'clean-close']);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('accepts a real CLI-style zero-work success result', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string }),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      [
        { stage: 'plan', total: 0, skippedExisting: [] },
        { stage: 'done', succeeded: 0, failed: 0, layerFailed: 0 },
        {
          stage: 'result',
          result: {
            schema_version: 1,
            command: 'generate',
            status: 'success',
            data: {
              results: [],
              failures: [],
              skippedExisting: [],
              emptyAnchorDokIds: [],
              plan: [],
              layers: {
                roles: { status: 'unchanged', added: 0, kept: 0 },
                ia: [],
                codeMapping: [],
              },
              layerFailures: [],
              transmissions: [],
            },
            diagnostics: [],
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    child.emit('close', 0);
    await p;

    expect(events.map((event) => event.stage)).toEqual([
      'plan',
      'done',
      'clean-close',
    ]);
  });

  it('keeps a real CLI-style partial result out of progress and preserves its diagnostics', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );
    const failure = {
      serviceId: 'web',
      dokId: 'AUTH-SIGNIN',
      reason: 'provider rate limit',
      code: 'RATE_LIMIT',
      retryable: true,
      nextCommand: 'doklo generate --yes',
    };
    child.stdout.emit(
      'data',
      [
        { stage: 'plan', total: 1, skippedExisting: [] },
        {
          stage: 'dok-done',
          index: 1,
          total: 1,
          serviceId: 'web',
          dokId: 'AUTH-SIGNIN',
          success: false,
          elapsedMs: 12,
          error: failure.reason,
        },
        { stage: 'done', succeeded: 0, failed: 1, layerFailed: 0 },
        {
          stage: 'result',
          result: {
            schema_version: 1,
            command: 'generate',
            status: 'partial',
            data: {
              results: [],
              failures: [failure],
              skippedExisting: [],
              emptyAnchorDokIds: [],
              plan: [{ serviceId: 'web', dokId: 'AUTH-SIGNIN', featureLabel: 'Sign in', domain: 'auth' }],
              layers: { ia: [], codeMapping: [] },
              layerFailures: [],
              transmissions: [],
            },
            diagnostics: [{
              code: 'RATE_LIMIT',
              message: 'AUTH-SIGNIN: provider rate limit',
              retryable: true,
              serviceId: 'web',
              nextCommand: 'doklo generate --yes',
            }],
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    child.emit('close', 1);
    await p;

    expect(events.map((event) => event.stage)).toEqual([
      'plan',
      'dok-done',
      'done',
      'error',
    ]);
    expect(events.at(-1)).toEqual({
      stage: 'error',
      message: 'AUTH-SIGNIN: provider rate limit Run `doklo generate --yes` and retry.',
      code: 'RATE_LIMIT',
      retryable: true,
      serviceId: 'web',
      nextCommand: 'doklo generate --yes',
      diagnostics: [{
        code: 'RATE_LIMIT',
        message: 'AUTH-SIGNIN: provider rate limit',
        retryable: true,
        serviceId: 'web',
        nextCommand: 'doklo generate --yes',
      }],
    });
  });

  it('keeps a real CLI-style command failure result out of progress and preserves safe recovery', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        stage: 'result',
        result: {
          schema_version: 1,
          command: 'generate',
          status: 'failed',
          data: null,
          diagnostics: [{
            code: 'MISSING_CREDENTIALS',
            message: 'No Anthropic API key is configured.',
            retryable: true,
            nextCommand: 'doklo auth anthropic',
          }],
        },
      })}\n`,
    );
    child.emit('close', 1);
    await p;

    expect(events).toEqual([{
      stage: 'error',
      message: 'No Anthropic API key is configured. Run `doklo auth` and retry.',
      code: 'MISSING_CREDENTIALS',
      retryable: true,
      nextCommand: 'doklo auth',
      diagnostics: [{
        code: 'MISSING_CREDENTIALS',
        message: 'No Anthropic API key is configured.',
        retryable: true,
        nextCommand: 'doklo auth',
      }],
    }]);
  });

  it('accepts the nested LLM credential failure emitted by generate and adds safe recovery', async () => {
    const child = fakeChild();
    const events: Array<Record<string, unknown>> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        stage: 'result',
        result: {
          schema_version: 1,
          command: 'llm',
          status: 'cancelled',
          data: null,
          diagnostics: [{
            code: 'RUNTIME_TRUST_CREDENTIAL_REQUIRED',
            message: 'Runtime trust requires an Anthropic API credential from the keychain or environment.',
          }],
        },
      })}\n`,
    );
    child.emit('close', 2);
    await p;

    expect(events).toEqual([{
      stage: 'error',
      message: 'Runtime trust requires an Anthropic API credential from the keychain or environment. Run `doklo auth` and retry.',
      code: 'RUNTIME_TRUST_CREDENTIAL_REQUIRED',
      nextCommand: 'doklo auth',
      diagnostics: [{
        code: 'RUNTIME_TRUST_CREDENTIAL_REQUIRED',
        message: 'Runtime trust requires an Anthropic API credential from the keychain or environment.',
        nextCommand: 'doklo auth',
      }],
    }]);
  });

  it('fails closed when the CLI emits more than one command-result envelope', async () => {
    const child = fakeChild();
    const events: Array<Record<string, unknown>> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event),
      { spawn: () => child },
    );
    const result = JSON.stringify({
      stage: 'result',
      result: {
        schema_version: 1,
        command: 'generate',
        status: 'failed',
        data: null,
        diagnostics: [{ code: 'COMMAND_FAILED', message: 'Generation failed.' }],
      },
    });

    child.stdout.emit('data', `${result}\n${result}\n`);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    child.emit('close', 1);
    await p;

    expect(events).toEqual([{
      stage: 'error',
      message: 'generate produced invalid machine output',
    }]);
  });

  it.each([
    ['non-JSON output', 'Generating 1 Dok'],
    ['malformed JSON', '{"stage":"plan"'],
    ['a JSON object without stage', '{"total":1}'],
    ['a non-object JSON value', 'null'],
    ['an empty stage', '{"stage":""}'],
    [
      'an invalid command-result envelope',
      JSON.stringify({
        stage: 'result',
        result: {
          schema_version: 1,
          command: 'generate',
          status: 'success',
          data: null,
        },
      }),
    ],
  ])('fails closed on %s', async (_label, line) => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );

    child.stdout.emit(
      'data',
      `${line}\n{"stage":"done","succeeded":1,"failed":0,"layerFailed":0}\n`,
    );

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(events).toEqual([]);

    child.emit('close', 0);
    await p;

    expect(events).toEqual([
      { stage: 'error', message: 'generate produced invalid machine output' },
    ]);
  });

  it('forwards JSONL events split across chunks', async () => {
    const child = fakeChild();
    const events: unknown[] = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (e) => events.push(e),
      { spawn: () => child },
    );
    child.stdout.emit('data', '{"stage":"plan","tot');
    child.stdout.emit(
      'data',
      'al":1,"skippedExisting":[]}\n{"stage":"done","succeeded":1,"failed":0,"layerFailed":0}\n',
    );
    expect(events).toEqual([
      { stage: 'plan', total: 1, skippedExisting: [] },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
    ]);
    child.emit('close', 0);
    await p;
    expect(events).toEqual([
      { stage: 'plan', total: 1, skippedExisting: [] },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ]);
  });

  it('decodes a multibyte UTF-8 progress value split across Buffer chunks', async () => {
    const child = fakeChild();
    const events: unknown[] = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event),
      { spawn: () => child },
    );
    const progress = {
      stage: 'dok-start',
      index: 1,
      total: 1,
      serviceId: 'web',
      dokId: 'AUTH-SIGNIN',
      featureLabel: '로그인',
    };
    const encoded = Buffer.from(`${JSON.stringify(progress)}\n`, 'utf8');
    const multibyteStart = encoded.indexOf(Buffer.from('로그인', 'utf8'));
    const splitAt = multibyteStart + 1;

    expect(multibyteStart).toBeGreaterThanOrEqual(0);
    child.stdout.emit('data', encoded.subarray(0, splitAt));
    child.stdout.emit('data', encoded.subarray(splitAt));
    child.stdout.emit(
      'data',
      '{"stage":"done","succeeded":1,"failed":0,"layerFailed":0}\n',
    );
    child.emit('close', 0);
    await p;

    expect(events).toEqual([
      progress,
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ]);
  });

  it('fails closed on invalid UTF-8 instead of forwarding replacement characters', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );
    const invalidLine = Buffer.concat([
      Buffer.from('{"stage":"plan","label":"', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('"}\n', 'utf8'),
    ]);

    child.stdout.emit('data', invalidLine);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    child.emit('close', 0);
    await p;

    expect(events).toEqual([
      { stage: 'error', message: 'generate produced invalid machine output' },
    ]);
  });

  it('waits for close and emits one error after a child error', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );

    child.emit('error', new Error('spawn failed'));
    const resolvedBeforeClose = await Promise.race([
      p.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);

    expect(resolvedBeforeClose).toBe(false);
    expect(events).toEqual([]);

    child.emit('close', -2);
    await p;

    expect(events).toEqual([{ stage: 'error', message: 'spawn failed' }]);
  });

  it('does not emit clean-close when exit zero has no done event', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );

    child.emit('close', 0);
    await p;

    expect(events).toEqual([
      { stage: 'error', message: 'generate produced no output' },
    ]);
  });

  it('interrupts an aborted request once, waits for close, and never emits clean-close', async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web', signal: controller.signal },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );

    controller.abort();
    controller.abort();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    const settledBeforeClose = await Promise.race([
      p.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0)),
    ]);
    expect(settledBeforeClose).toBe(false);

    child.emit('close', null);
    await p;

    expect(events).not.toContainEqual({ stage: 'clean-close' });
  });

  it('rejects after an async delivery failure, interrupts once, and never emits clean-close', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => {
        events.push(event as { stage: string });
        if (event.stage === 'done') return Promise.reject(new Error('writer closed'));
      },
      { spawn: () => child },
    );
    child.stdout.emit('data', '{"stage":"done","succeeded":1,"failed":0,"layerFailed":0}\n');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    child.emit('close', 0);
    await expect(p).rejects.toThrow('writer closed');
    expect(events).not.toContainEqual({ stage: 'clean-close' });
  });

  it('drops later stdout after delivery failure without an unhandled rejection', async () => {
    const child = fakeChild();
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => event.stage === 'done'
        ? Promise.reject(new Error('writer closed'))
        : undefined,
      { spawn: () => child },
    );
    child.stdout.emit('data', '{"stage":"done","succeeded":1,"failed":0,"layerFailed":0}\n');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    child.stdout.emit('data', '{"stage":"plan","total":2}\n');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    child.emit('close', 0);
    await expect(p).rejects.toThrow('writer closed');
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
  });

  it('serializes delayed async delivery before later events and close', async () => {
    const child = fakeChild();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      async (event) => {
        if (event.stage === 'plan') await first;
        events.push(event.stage as string);
      },
      { spawn: () => child },
    );
    child.stdout.emit('data', [
      { stage: 'plan' },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    child.emit('close', 0);
    expect(events).toEqual([]);
    releaseFirst();
    await p;

    expect(events).toEqual(['plan', 'done', 'clean-close']);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
  });

  it('emits an error event when the child exits nonzero without a done event', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (e) => events.push(e as { stage: string }),
      { spawn: () => child },
    );
    child.stderr.emit('data', 'boom: no model configured\n');
    child.emit('close', 1);
    await p;
    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe('error');
    expect(events[0].message).toContain('no model configured');
  });

  it('forwards deterministic layer events before done', async () => {
    const child = fakeChild();
    const events: unknown[] = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      [
        { stage: 'roles', status: 'updated', added: 2, kept: 1 },
        { stage: 'ia', serviceId: 'web', status: 'written', count: 8 },
        { stage: 'code-mapping', serviceId: 'web', status: 'unchanged', count: 5 },
        { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    );
    expect(events.at(-1)).toEqual({
      stage: 'done',
      succeeded: 1,
      failed: 0,
      layerFailed: 0,
    });
    child.emit('close', 0);
    await p;

    expect(events).toEqual([
      { stage: 'roles', status: 'updated', added: 2, kept: 1 },
      { stage: 'ia', serviceId: 'web', status: 'written', count: 8 },
      { stage: 'code-mapping', serviceId: 'web', status: 'unchanged', count: 5 },
      { stage: 'done', succeeded: 1, failed: 0, layerFailed: 0 },
      { stage: 'clean-close' },
    ]);
  });

  it('emits a terminal error when done reports a layer failure', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      '{"stage":"done","succeeded":1,"failed":0,"layerFailed":1}\n',
    );
    expect(events.map((event) => event.stage)).toEqual(['done']);
    child.emit('close', 0);
    await p;

    expect(events.map((event) => event.stage)).toEqual(['done', 'error']);
    expect(events[1]?.message).toContain('1 layer failed');
  });

  it('emits one terminal error when failed done is followed by nonzero close', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      '{"stage":"done","succeeded":0,"failed":1,"layerFailed":0}\n',
    );
    child.stderr.emit('data', 'cleanup failed\n');
    child.emit('close', 2);
    await p;

    expect(events.map((event) => event.stage)).toEqual(['done', 'error']);
    expect(events[1]?.message).toContain('generate exited 2');
    expect(events[1]?.message).toContain('cleanup failed');
  });

  it('surfaces a nonzero close even after done was emitted', async () => {
    const child = fakeChild();
    const events: Array<{ stage: string; message?: string }> = [];
    const p = streamCliGenerate(
      { cliBin: '/x/cli.js', root: '/w', service: 'web' },
      (event) => events.push(event as { stage: string; message?: string }),
      { spawn: () => child },
    );
    child.stdout.emit(
      'data',
      '{"stage":"done","succeeded":1,"failed":0,"layerFailed":0}\n',
    );
    child.stderr.emit('data', 'post-run cleanup failed\n');
    child.emit('close', 2);
    await p;

    expect(events.map((event) => event.stage)).toEqual(['done', 'error']);
    expect(events[1]?.message).toContain('generate exited 2');
    expect(events[1]?.message).toContain('post-run cleanup failed');
  });

  it.each(malformedDoneSummaries)(
    'fails closed for a done summary with $label',
    async ({ summary }) => {
      const child = fakeChild();
      const events: Array<{ stage: string; message?: string }> = [];
      const p = streamCliGenerate(
        { cliBin: '/x/cli.js', root: '/w', service: 'web' },
        (event) => events.push(event as { stage: string; message?: string }),
        { spawn: () => child },
      );
      child.stdout.emit(
        'data',
        `${JSON.stringify({ stage: 'done', ...summary })}\n`,
      );

      expect(events.map((event) => event.stage)).toEqual(['done']);

      child.emit('close', 0);
      await p;

      expect(events.map((event) => event.stage)).toEqual(['done', 'error']);
      expect(events[1]?.message).toContain('invalid completion summary');
    },
  );
});

describe('GeneratePanel terminal transport', () => {
  it('shows success only after clean-close follows a successful done', async () => {
    await renderPanel();
    const source = await startPanelGeneration();

    await emitProgress(source, {
      stage: 'done',
      succeeded: 1,
      failed: 0,
      layerFailed: 0,
    });

    expect(document.querySelector('a[href="/doks"]')).toBeNull();

    await emitProgress(source, { stage: 'clean-close' });

    const openHub = document.querySelector('a[href="/doks"]');
    expect(openHub).not.toBeNull();
    expect(openHub?.textContent).toContain('Open Hub');
    expect(source.closed).toBe(true);
  });

  it('treats a transport error before clean-close as failure after done', async () => {
    await renderPanel();
    const source = await startPanelGeneration();

    await emitProgress(source, {
      stage: 'done',
      succeeded: 1,
      failed: 0,
      layerFailed: 0,
    });
    await failStream(source);

    expect(document.querySelector('a[href="/doks"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Generation stream connection error',
    );
  });

  it.each(malformedDoneSummaries)(
    'fails closed for a done summary with $label',
    async ({ summary }) => {
      await renderPanel();
      const source = await startPanelGeneration();

      await emitProgress(source, {
        stage: 'done',
        ...summary,
      });

      expect(source.closed).toBe(false);
      expect(document.querySelector('a[href="/doks"]')).toBeNull();
      expect(
        document.querySelector('[role="alert"]')?.textContent ?? '',
      ).toContain('invalid completion summary');

      await emitProgress(source, { stage: 'clean-close' });

      expect(source.closed).toBe(true);
      expect(document.querySelector('a[href="/doks"]')).toBeNull();
      expect(
        document.querySelector('[role="alert"]')?.textContent ?? '',
      ).toContain('invalid completion summary');
    },
  );

  it('keeps failed done provisional until a close-owned error becomes authoritative', async () => {
    await renderPanel();
    const source = await startPanelGeneration();

    await emitProgress(source, {
      stage: 'done',
      succeeded: 0,
      failed: 1,
      layerFailed: 0,
    });

    expect(source.closed).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '1 Dok failed',
    );

    await emitProgress(source, {
      stage: 'error',
      message: 'generate exited 2: cleanup failed',
    });

    expect(source.closed).toBe(true);
    expect(document.querySelector('a[href="/doks"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'generate exited 2: cleanup failed',
    );
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain(
      'Generation completed with',
    );
  });
});

describe('GeneratePanel layer progress', () => {
  it('renders roles, IA, and code-mapping counts with textual statuses', async () => {
    await renderPanel();
    const source = await startPanelGeneration();

    await emitProgress(source, {
      stage: 'roles',
      status: 'updated',
      added: 2,
      kept: 1,
    });
    await emitProgress(source, {
      stage: 'ia',
      serviceId: 'web',
      status: 'written',
      count: 8,
    });
    await emitProgress(source, {
      stage: 'code-mapping',
      serviceId: 'web',
      status: 'unchanged',
      count: 5,
    });

    const rows = Array.from(
      document.querySelectorAll<HTMLLIElement>('ul[aria-live="polite"] > li'),
    );
    const rowWithTitle = (title: string) =>
      rows.find((row) => row.querySelector('span')?.textContent === title);

    expect(rowWithTitle('Roles')?.textContent).toContain('2 added · 1 kept');
    expect(rowWithTitle('Roles')?.textContent).toContain('Updated');
    expect(rowWithTitle('IA')?.textContent).toContain('web · 8 routes');
    expect(rowWithTitle('IA')?.textContent).toContain('Written');
    expect(rowWithTitle('Code mapping')?.textContent).toContain('web · 5 entries');
    expect(rowWithTitle('Code mapping')?.textContent).toContain('Unchanged');
  });
});

describe('GeneratePanel modal focus lifecycle', () => {
  it('initially focuses the static title without making the dialog focusable', async () => {
    await renderPanel();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = dialog.querySelector<HTMLHeadingElement>(
      '#generate-panel-title',
    )!;

    expect(dialog.hasAttribute('tabindex')).toBe(false);
    expect(title.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(title);
  });

  it('links the real trigger to the generate dialog', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const mounted = { host, root, unmounted: false };
    mountedPanels.push(mounted);

    await act(async () => {
      root.render(
        createElement(
          StudioProvider,
          {
            layerCounts: { doks: 0, lexicon: 0, ia: 0, roles: 0 },
            children: createElement(SaveBar, {
              service: 'web',
              config: consolidationConfig(),
              dirty: false,
              editVersion: 0,
              initialRevision: 'web-revision',
              path: '/workspace/.doklo/cache/web.consolidated.json',
              onSaved: vi.fn(() => true),
            }),
          },
        ),
      );
    });

    const trigger = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Save & generate'),
    )!;

    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-controls')).toBe('generate-panel-dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('restores a linked trigger when the panel mounts with body focused', async () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-controls', 'generate-panel-dialog');
    trigger.textContent = 'Save & generate';
    document.body.append(trigger);
    expect(document.activeElement).toBe(document.body);

    const panel = await renderPanel();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;

    await unmountPanel(panel);

    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
  });

  it('focuses inside, traps Tab in both directions, closes on Escape, and restores state', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Generate';
    const alreadyInert = document.createElement('aside');
    alreadyInert.setAttribute('inert', '');
    document.body.append(opener, alreadyInert);
    opener.focus();

    const initialClose = vi.fn();
    const panel = await renderPanel(initialClose);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const title = dialog.querySelector<HTMLHeadingElement>(
      '#generate-panel-title',
    )!;
    const closeButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Close',
    )!;
    const startButton = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Start generation',
    )!;

    expect(document.activeElement).toBe(title);
    expect(opener.hasAttribute('inert')).toBe(true);
    expect(panel.host.hasAttribute('inert')).toBe(true);

    const firstTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(firstTab);
    expect(firstTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(startButton);

    const onlyShiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(onlyShiftTab);
    expect(onlyShiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton);

    startButton.disabled = true;
    closeButton.disabled = true;
    title.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(title);
    startButton.disabled = false;
    closeButton.disabled = false;

    const source = await startPanelGeneration();
    await emitProgress(source, {
      stage: 'done',
      succeeded: 1,
      failed: 0,
      layerFailed: 0,
    });
    await emitProgress(source, { stage: 'clean-close' });
    const openHub = dialog.querySelector<HTMLAnchorElement>('a[href="/doks"]')!;

    closeButton.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(openHub);

    openHub.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(closeButton);

    const latestClose = vi.fn();
    await act(async () => {
      panel.root.render(
        createElement(GeneratePanel, { service: 'web', onClose: latestClose }),
      );
    });
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(initialClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);

    await unmountPanel(panel);

    expect(document.activeElement).toBe(opener);
    expect(opener.hasAttribute('inert')).toBe(false);
    expect(alreadyInert.hasAttribute('inert')).toBe(true);
  });

  it('keeps shared background inert until nested modal leases are released', async () => {
    const background = document.createElement('main');
    const alreadyInert = document.createElement('aside');
    alreadyInert.setAttribute('inert', '');
    document.body.append(background, alreadyInert);

    const first = await renderPanel();
    const second = await renderPanel();
    expect(background.hasAttribute('inert')).toBe(true);

    await unmountPanel(first);
    expect(background.hasAttribute('inert')).toBe(true);

    await unmountPanel(second);
    expect(background.hasAttribute('inert')).toBe(false);
    expect(alreadyInert.hasAttribute('inert')).toBe(true);
  });
});
