// Capture is intentionally fail-closed. Standard Node does not expose the
// directory-relative openat/renameat primitives needed to publish screenshots
// without a parent-symlink swap window. Keep direct help truthful, hide the
// unavailable command from the parent surface, and perform no browser or file
// operation until a path-pinned boundary and real E2E evidence exist.

import type { Command } from 'commander';
import { DokIdSchema } from '@doklo-beta/core';
import type { CliContext } from '../lib/context.js';
import { ensureLiveDocsCommand } from './live-docs-render.js';
import { CommandContractError } from '../lib/command-result.js';

const EXPERIMENTAL_CAPTURE_MESSAGE =
  '[experimental] Capture is not stable release evidence and app→capture→document E2E validation remains pending.';
const CAPTURE_UNAVAILABLE_MESSAGE =
  'Capture file publication is unavailable because standard Node cannot provide the path-pinned openat/renameat boundary required to eliminate resolve-to-write symlink races.';

interface Opts {
  viewport?: string;
  json?: boolean;
}

function validateViewport(value: string | undefined): void {
  if (!value) return;
  const match = /^(\d+)x(\d+)$/.exec(value);
  const width = match ? Number(match[1]) : 0;
  const height = match ? Number(match[2]) : 0;
  if (
    !match
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
  ) {
    throw captureError(
      'failed',
      'INVALID_VIEWPORT',
      `Invalid viewport '${value}': expected positive integer dimensions such as 1280x720.`,
      1,
    );
  }
}

export function registerLiveDocsCaptureCommand(program: Command, _ctx: CliContext): void {
  const liveDocs = ensureLiveDocsCommand(program);
  liveDocs
    .command('capture <dokId>', { hidden: true })
    .description('[experimental] unavailable — capture publication requires a path-pinned writer')
    .option('--root <path>', 'reserved for compatibility; no filesystem access while unavailable')
    .option('--viewport <WxH>', 'validate a future capture viewport, e.g. 1280x720')
    .option('--no-auth', 'reserved for compatibility; no browser starts while unavailable')
    .option('--headed', 'reserved for compatibility; no browser starts while unavailable')
    .option('--verbose', 'reserved for compatibility; no capture run starts while unavailable')
    .option('--overwrite', 'reserved; cannot enable publication while unavailable')
    .option('--json', 'emit one terminal JSONL result envelope')
    .action((dokId: string, opts: Opts) => {
      if (!DokIdSchema.safeParse(dokId).success) {
        throw captureError(
          'failed',
          'INVALID_DOK_ID',
          `Invalid Dok ID '${dokId}': expected a semantic Dok id (1-3 UPPERCASE segments, e.g. AUTH-SIGNIN).`,
          1,
        );
      }
      validateViewport(opts.viewport);
      throw captureError(
        'unsupported',
        'CAPTURE_PUBLICATION_UNAVAILABLE',
        CAPTURE_UNAVAILABLE_MESSAGE,
        2,
      );
    });
}

function captureError(
  status: 'failed' | 'unsupported',
  code: string,
  message: string,
  exitCode: 1 | 2,
): CommandContractError {
  return new CommandContractError(
    {
      schema_version: 1,
      command: 'live-docs capture',
      status,
      data: null,
      diagnostics: [
        { code, message },
        { code: 'CAPTURE_EXPERIMENTAL', message: EXPERIMENTAL_CAPTURE_MESSAGE },
      ],
    },
    exitCode,
  );
}
