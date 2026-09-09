// Port preflight + readiness probing for Doklo Studio.
//
// `doklo serve`, the init browser handoff, and the generate gate's [s] option
// all boot Studio on 127.0.0.1. Before these helpers, a stale server (or any
// other process) already bound to the preferred port crashed the spawned
// Next.js child with a raw EADDRINUSE stack trace — after the CLI had already
// promised a URL. Callers now pick a truthful port up front and delay the
// browser open until the server actually answers HTTP.

import { createServer } from 'node:net';

/** The port Studio prefers everywhere (serve default, init handoff, generate
 *  gate). Callers fall back to neighbors via pickStudioPort when it is busy. */
export const DEFAULT_STUDIO_PORT = 4321;

export interface PickStudioPortOptions {
  /** Fail instead of falling back when the preferred port is busy. Used when
   *  the user asked for an exact port (e.g. an explicit `--port`). */
  strict?: boolean;
  /** How many consecutive ports to try: preferred … preferred+attempts-1. */
  attempts?: number;
}

export interface PickedStudioPort {
  port: number;
  /** True when the preferred port was busy and a neighbor was chosen. */
  fallback: boolean;
}

/** Find a bindable port for Studio, starting at `preferred`. Probes by
 *  binding a throwaway net.Server on 127.0.0.1 (the host Studio binds).
 *  Free → { port: preferred, fallback: false }. Busy in strict mode → throws
 *  with an actionable message. Busy otherwise → first free neighbor wins with
 *  fallback: true; throws when the whole attempt budget is busy. */
export async function pickStudioPort(
  preferred: number,
  opts: PickStudioPortOptions = {},
): Promise<PickedStudioPort> {
  const attempts = opts.attempts ?? 10;
  if (await isPortFree(preferred)) return { port: preferred, fallback: false };
  if (opts.strict) {
    throw new Error(
      `Port ${preferred} is already in use. Stop the process using it, ` +
        `or pass --port to choose another port.`,
    );
  }
  for (let offset = 1; offset < attempts; offset++) {
    const candidate = preferred + offset;
    if (await isPortFree(candidate)) return { port: candidate, fallback: true };
  }
  throw new Error(
    `Ports ${preferred}-${preferred + attempts - 1} are all in use. Stop one ` +
      `of the processes using them, or pass --port to choose another port.`,
  );
}

/** Can we bind 127.0.0.1:port right now? (Bind + release, never throws.) */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

export interface WaitForStudioReadyOptions {
  /** Give up after this long. Default 30s (Next dev can be slow to boot). */
  timeoutMs?: number;
  /** Delay between polls. Default 250ms. */
  intervalMs?: number;
  /** Abort polling early (e.g. the Studio child died). */
  signal?: AbortSignal;
}

/** Poll `url` until the server answers with ANY http response — a 404 counts,
 *  it proves something is serving HTTP there. Network errors keep polling.
 *  Resolves false on timeout or abort. Never throws. */
export async function waitForStudioReady(
  url: string,
  opts: WaitForStudioReadyOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 250;
  const signal = opts.signal;
  const deadline = Date.now() + timeoutMs;

  while (!signal?.aborted && Date.now() < deadline) {
    // Cap each attempt at the remaining budget so a connection that hangs
    // (accepted but never answered) cannot outlive the overall timeout.
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    signal?.addEventListener('abort', abortAttempt, { once: true });
    const attemptTimer = setTimeout(
      abortAttempt,
      Math.max(1, deadline - Date.now()),
    );
    try {
      const response = await fetch(url, { signal: attempt.signal });
      response.body?.cancel().catch(() => {});
      return true;
    } catch {
      // Refused/reset/aborted — the server is not up (yet). Keep polling.
    } finally {
      clearTimeout(attemptTimer);
      signal?.removeEventListener('abort', abortAttempt);
    }
    if (signal?.aborted || Date.now() >= deadline) return false;
    await sleep(intervalMs, signal);
  }
  return false;
}

/** setTimeout as a promise that resolves early (not rejects) on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
