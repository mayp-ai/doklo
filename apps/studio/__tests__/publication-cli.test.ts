import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  PublicationCliProtocolError,
  runPublicationCli,
  type PublicationCliChild,
} from '../lib/publication-cli';

describe('runPublicationCli', () => {
  it('spawns the current Node runtime with exact machine arguments and no shell', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const pending = runPublicationCli({
      cliBin: '/tool/cli.js',
      root: '/workspace',
      operation: {
        kind: 'render',
        name: 'public-help',
        overwrite: true,
        dryRun: false,
      },
    }, { spawn });

    emitResult(child, success('live-docs.publication.render'));
    child.emit('close', 0);

    await expect(pending).resolves.toMatchObject({
      status: 'success',
      command: 'live-docs.publication.render',
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        '/tool/cli.js',
        'live-docs',
        'publication',
        'render',
        'public-help',
        '--overwrite',
        '--json',
        '--root',
        '/workspace',
      ],
      {
        cwd: '/workspace',
        env: expect.any(Object),
        shell: false,
      },
    );
  });

  it.each([
    ['human output', 'Created publication\n'],
    ['malformed JSON', '{"stage":"result"\n'],
    ['duplicate results', `${line(success('live-docs.publication.list'))}${line(success('live-docs.publication.list'))}`],
    ['missing result', ''],
  ])('rejects %s', async (_label, stdout) => {
    const child = fakeChild();
    const pending = runPublicationCli({
      cliBin: '/tool/cli.js',
      root: '/workspace',
      operation: { kind: 'list' },
    }, { spawn: () => child });
    if (stdout) child.stdout.emit('data', stdout);
    child.emit('close', 0);

    await expect(pending).rejects.toBeInstanceOf(PublicationCliProtocolError);
  });

  it('returns a structured failed result and truncates stderr diagnostics', async () => {
    const child = fakeChild();
    const pending = runPublicationCli({
      cliBin: '/tool/cli.js',
      root: '/workspace',
      operation: { kind: 'publish', name: 'public-help', dryRun: false },
    }, { spawn: () => child });
    child.stderr.emit('data', `secret-prefix-${'x'.repeat(1_000)}`);
    emitResult(child, {
      schema_version: 1,
      command: 'live-docs.publication.publish',
      status: 'failed',
      data: null,
      diagnostics: [{
        code: 'PUBLICATION_PUBLISH_BLOCKED',
        message: 'Destination conflict.',
        nextCommand: 'rm -rf docs',
      }],
    });
    child.emit('close', 1);

    const result = await pending;
    expect(result.status).toBe('failed');
    expect(result.diagnostics[0]).toEqual({
      code: 'PUBLICATION_PUBLISH_BLOCKED',
      message: 'Destination conflict.',
    });
    expect(result.stderr_tail.length).toBeLessThanOrEqual(800);
    expect(result.stderr_tail).not.toContain('secret-prefix');
  });

  it('interrupts the child once when the request is aborted', async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const pending = runPublicationCli({
      cliBin: '/tool/cli.js',
      root: '/workspace',
      operation: { kind: 'list' },
      signal: controller.signal,
    }, { spawn: () => child });

    controller.abort();
    controller.abort();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    emitResult(child, {
      schema_version: 1,
      command: 'live-docs.publication.list',
      status: 'cancelled',
      data: null,
      diagnostics: [],
    });
    child.emit('close', 130);

    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & PublicationCliChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child as typeof child & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
}

function success(command: string) {
  return {
    schema_version: 1 as const,
    command,
    status: 'success' as const,
    data: {},
    diagnostics: [],
  };
}

function line(result: object): string {
  return `${JSON.stringify({ stage: 'result', result })}\n`;
}

function emitResult(child: ReturnType<typeof fakeChild>, result: object): void {
  child.stdout.emit('data', line(result));
}
