import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { generationStreamResponse } from '../lib/generation-response';
import { streamCliGenerate, type CliChild } from '../lib/generate-subprocess';

describe('generationStreamResponse', () => {
  it('aborts the local run when the response body is cancelled', async () => {
    const request = new AbortController();
    let observedAbort = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const response = generationStreamResponse({
      requestSignal: request.signal,
      headers: {},
      encode: (event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`),
      run: async (signal) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          finish();
        }, { once: true });
        await finished;
      },
    });

    await response.body!.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(observedAbort).toBe(true);
  });

  it('cancels a bridged child once and waits for close without post-cancel terminal output', async () => {
    const child = new EventEmitter() as CliChild & EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    const request = new AbortController();
    let completed = false;
    const response = generationStreamResponse({
      requestSignal: request.signal,
      headers: {},
      encode: (event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`),
      run: async (signal, emit) => {
        await streamCliGenerate(
          { cliBin: '/cli.js', root: '/workspace', service: 'web', signal },
          emit,
          { spawn: () => child },
        );
        completed = true;
      },
    });

    await response.body!.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);

    child.emit('close', null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(true);
  });
});
