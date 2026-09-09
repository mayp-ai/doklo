import { describe, expect, it } from 'vitest';
import { readJsonLines } from '../lib/parse-json-lines';

function stream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(
        typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
      );
      controller.close();
    },
  });
}

describe('readJsonLines', () => {
  it('reads events split across transport chunks', async () => {
    const events: Record<string, unknown>[] = [];

    await readJsonLines(
      stream(['{"stage":"plan",', '"total":1}\n{"stage":"done"}\n']),
      (event) => events.push(event),
    );

    expect(events).toEqual([{ stage: 'plan', total: 1 }, { stage: 'done' }]);
  });

  it('fails closed on a partial terminal event', async () => {
    await expect(
      readJsonLines(stream(['{"stage":"done"']), () => {}),
    ).rejects.toThrow('Generation stream ended with a partial event.');
  });

  it('flushes and accepts a multibyte UTF-8 code point split across every byte', async () => {
    const bytes = new TextEncoder().encode('{"stage":"roles","note":"한"}\n');
    for (let index = 1; index < bytes.length; index += 1) {
      const events: Record<string, unknown>[] = [];
      await readJsonLines(stream([bytes.slice(0, index), bytes.slice(index)]), (event) => events.push(event));
      expect(events).toEqual([{ stage: 'roles', note: '한' }]);
    }
  });

  it('rejects invalid and incomplete trailing UTF-8 bytes', async () => {
    await expect(
      readJsonLines(stream([new TextEncoder().encode('{"stage":"done"}\n'), new Uint8Array([0xe2])]), () => {}),
    ).rejects.toThrow('Generation returned an unreadable progress event.');
    await expect(
      readJsonLines(stream([new Uint8Array([0xff])]), () => {}),
    ).rejects.toThrow('Generation returned an unreadable progress event.');
  });

  it('cancels the underlying body after malformed progress', async () => {
    let cancelled = false;
    const malformed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readJsonLines(malformed, () => {})).rejects.toThrow('unreadable');
    expect(cancelled).toBe(true);
  });
});
