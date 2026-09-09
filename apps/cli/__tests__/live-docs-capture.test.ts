import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerLiveDocsCaptureCommand } from '../src/commands/live-docs-capture.js';

describe('experimental capture command boundary', () => {
  it('hides unavailable capture from parent help while direct help stays truthful', () => {
    const program = new Command();
    registerLiveDocsCaptureCommand(program, {} as never);
    const liveDocs = program.commands.find((command) => command.name() === 'live-docs')!;
    const capture = liveDocs.commands.find((command) => command.name() === 'capture')!;

    expect(liveDocs.helpInformation()).not.toContain('capture');
    expect(capture.helpInformation()).toContain('[experimental]');
    expect(capture.helpInformation()).toContain('unavailable');
  });

  it.each(['../outside', '/tmp/outside', 'AUTH\\001', 'AUTH/001', 'AUTH\0-001'])
    ('rejects unsafe Dok input %j at the disabled boundary', async (dokId) => {
      const program = new Command().exitOverride();
      registerLiveDocsCaptureCommand(program, {} as never);

      await expect(program.parseAsync([
        'live-docs', 'capture', dokId, '--json',
      ], { from: 'user' })).rejects.toMatchObject({
        result: {
          command: 'live-docs capture',
          status: 'failed',
          diagnostics: [
            { code: 'INVALID_DOK_ID' },
            { code: 'CAPTURE_EXPERIMENTAL' },
          ],
        },
      });
    });

  it.each(['wide', '1280', '0x720', '1280x0', '-1x720'])
    ('rejects invalid viewport %j at the disabled boundary', async (viewport) => {
      const program = new Command().exitOverride();
      registerLiveDocsCaptureCommand(program, {} as never);

      await expect(program.parseAsync([
        'live-docs', 'capture', 'DOK', '--viewport', viewport, '--json',
      ], { from: 'user' })).rejects.toMatchObject({
        result: {
          command: 'live-docs capture',
          status: 'failed',
          diagnostics: [
            { code: 'INVALID_VIEWPORT' },
            { code: 'CAPTURE_EXPERIMENTAL' },
          ],
        },
      });
    });

  it('fails a valid capture closed before loading Playwright or touching a workspace', async () => {
    const program = new Command().exitOverride();
    registerLiveDocsCaptureCommand(program, {} as never);

    await expect(program.parseAsync([
      'live-docs', 'capture', 'DOK', '--root', '/workspace', '--overwrite', '--json',
    ], { from: 'user' })).rejects.toMatchObject({
      exitCode: 2,
      result: {
        command: 'live-docs capture',
        status: 'unsupported',
        data: null,
        diagnostics: [
          { code: 'CAPTURE_PUBLICATION_UNAVAILABLE', message: expect.stringContaining('path-pinned') },
          { code: 'CAPTURE_EXPERIMENTAL', message: expect.stringContaining('[experimental]') },
        ],
      },
    });
  });

  it('validates a usable viewport before returning the unavailable boundary', async () => {
    const program = new Command().exitOverride();
    registerLiveDocsCaptureCommand(program, {} as never);

    await expect(program.parseAsync([
      'live-docs', 'capture', 'DOK', '--viewport', '1280x720', '--json',
    ], { from: 'user' })).rejects.toMatchObject({
      result: {
        status: 'unsupported',
        diagnostics: [
          { code: 'CAPTURE_PUBLICATION_UNAVAILABLE' },
          { code: 'CAPTURE_EXPERIMENTAL', message: expect.stringContaining('[experimental]') },
        ],
      },
    });
  });
});
