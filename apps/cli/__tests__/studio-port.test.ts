import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { pickStudioPort, waitForStudioReady } from '../src/lib/studio-port.js';

// Every server opened through the helpers below is tracked and torn down
// after each test so a failing assertion can never leak a listener.
const openServers: Array<{ close: (cb?: () => void) => unknown }> = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

function listeningPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

/** Bind a plain TCP server on 127.0.0.1 (port 0 → OS-assigned). */
function occupy(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      openServers.push(server);
      resolve(server);
    });
  });
}

/** An OS-assigned port that was free a moment ago (bound, then released). */
async function freePort(): Promise<number> {
  const server = await occupy(0);
  const port = listeningPort(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Occupy an OS-assigned port whose next-door neighbor is currently free, so
 *  fallback assertions on `preferred + 1` are deterministic. */
async function occupyWithFreeNeighbor(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const server = await occupy(0);
    const port = listeningPort(server);
    try {
      const neighbor = await occupy(port + 1); // prove the neighbor is free…
      await new Promise<void>((resolve) => neighbor.close(() => resolve()));
      return port; // …and release it for the code under test.
    } catch {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  throw new Error('could not find two adjacent free ports on 127.0.0.1');
}

describe('pickStudioPort', () => {
  it('keeps the preferred port when it is free', async () => {
    const preferred = await freePort();
    await expect(pickStudioPort(preferred)).resolves.toEqual({
      port: preferred,
      fallback: false,
    });
  });

  it('falls back to preferred+1 when the preferred port is busy', async () => {
    const preferred = await occupyWithFreeNeighbor();
    await expect(pickStudioPort(preferred)).resolves.toEqual({
      port: preferred + 1,
      fallback: true,
    });
  });

  it('rejects with an actionable message in strict mode when the port is busy', async () => {
    const holder = await occupy(0);
    const preferred = listeningPort(holder);
    let caught: unknown;
    try {
      await pickStudioPort(preferred, { strict: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(String(preferred)); // names the busy port
    expect(message).toContain('--port'); // suggests the way out
  });

  it('rejects when every candidate within the attempt budget is busy', async () => {
    const preferred = await occupyWithFreeNeighbor();
    await occupy(preferred + 1); // now preferred AND preferred+1 are busy
    let caught: unknown;
    try {
      await pickStudioPort(preferred, { attempts: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(String(preferred));
    expect(message).toContain(String(preferred + 1));
    expect(message).toContain('--port');
  });
});

describe('waitForStudioReady', () => {
  it('resolves true as soon as the server answers, even with a 404', async () => {
    const server = createHttpServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) =>
      server.listen({ port: 0, host: '127.0.0.1' }, resolve),
    );
    openServers.push(server);
    const port = (server.address() as AddressInfo).port;

    await expect(
      waitForStudioReady(`http://127.0.0.1:${port}/no-such-page`, {
        timeoutMs: 5000,
        intervalMs: 25,
      }),
    ).resolves.toBe(true);
  });

  it('resolves false quickly when nothing listens and the timeout elapses', async () => {
    const port = await freePort();
    const started = Date.now();
    await expect(
      waitForStudioReady(`http://127.0.0.1:${port}/`, {
        timeoutMs: 250,
        intervalMs: 25,
      }),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops polling and resolves false when the signal aborts mid-poll', async () => {
    const port = await freePort();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await expect(
      waitForStudioReady(`http://127.0.0.1:${port}/`, {
        timeoutMs: 10_000,
        intervalMs: 25,
        signal: controller.signal,
      }),
    ).resolves.toBe(false);
    // Resolving far below the 10s timeout proves the abort stopped the loop.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
