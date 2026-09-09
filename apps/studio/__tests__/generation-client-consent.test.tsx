// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneratePanel } from '../components/consolidation/generate-panel';

const roots: Root[] = [];
const eventSourceMock = vi.fn();

function jsonStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}

async function renderPanel(): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<GeneratePanel service="web" onClose={vi.fn()} />);
  });
}

function button(name: string): HTMLButtonElement {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === name);
  if (!target) throw new Error(`Could not find button: ${name}`);
  return target;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  eventSourceMock.mockReset();
  eventSourceMock.mockImplementation(() => ({ close: vi.fn() }));
  vi.stubGlobal('EventSource', eventSourceMock);
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    [{}] as unknown as DOMRectList,
  );
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('GeneratePanel consent transport', () => {
  it('does not request consent or generation before an explicit start click', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(Response.json({ consentToken: 'consent-one' }))
      .mockResolvedValueOnce(new Response(jsonStream([
        { stage: 'error', message: 'stop after transport assertion' },
      ])));

    await renderPanel();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventSourceMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('selected source excerpts');

    await click(button('Start generation'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/consolidation/generate?service=web',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-doklo-generation-action': 'request-consent' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/consolidation/generate?service=web',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'x-doklo-generation-action': 'start-generation',
          'x-doklo-generation-consent': 'consent-one',
        },
      }),
    );
  });

  it('requests a fresh one-time consent token when the user retries', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(Response.json({ consentToken: 'consent-one' }))
      .mockResolvedValueOnce(new Response(jsonStream([
        { stage: 'error', message: 'first attempt failed' },
      ])))
      .mockResolvedValueOnce(Response.json({ consentToken: 'consent-two' }))
      .mockResolvedValueOnce(new Response(jsonStream([
        { stage: 'error', message: 'second attempt failed' },
      ])));

    await renderPanel();
    await click(button('Start generation'));
    await click(button('Retry generation'));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/consolidation/generate?service=web',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-doklo-generation-consent': 'consent-two',
        }),
      }),
    );
  });
});
