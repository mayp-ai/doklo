import type { writeFileAtomic } from '@doklo-beta/core';
import { DokIdSchema } from '@doklo-beta/core';
import { parseCaptureConfig, type CaptureConfig } from './config.js';

export interface CaptureRunInput {
  workspaceRoot: string;
  config: CaptureConfig;
  dokId: string;
  viewport?: { width: number; height: number };
  noAuth?: boolean;
  verbose?: boolean;
  headed?: boolean;
  overwrite?: boolean;
}

export interface CaptureRunResult {
  outputDir: string;
  files: string[];
  warnings: string[];
}

/**
 * Retained only as a verification seam. A fail-closed run must invoke none of
 * these dependencies while path-pinned publication is unavailable.
 */
export interface CaptureRunDependencies {
  launchBrowser?: (options: { headless: boolean }) => Promise<unknown>;
  writeAtomic?: typeof writeFileAtomic;
  transactionHooks?: {
    beforeWrite?: (index: number, destination: string) => Promise<void>;
  };
}

export class MissingDokRecipeError extends Error {
  constructor(public dokId: string) {
    super(`No capture recipe for Dok '${dokId}' in capture config`);
    this.name = 'MissingDokRecipeError';
  }
}

export class AuthFailedError extends Error {
  constructor(message: string) {
    super(`Auth failed: ${message}`);
    this.name = 'AuthFailedError';
  }
}

export class CaptureOutputExistsError extends Error {
  readonly code = 'CAPTURE_OUTPUT_EXISTS';

  constructor(public path: string) {
    super(`Capture output already exists: ${path}. Re-run with explicit overwrite consent.`);
    this.name = 'CaptureOutputExistsError';
  }
}

export class CapturePublicationUnavailableError extends Error {
  readonly code = 'CAPTURE_PUBLICATION_UNAVAILABLE';

  constructor() {
    super(
      'Experimental capture file publication is unavailable: standard Node does not provide a path-pinned openat/renameat boundary, so Doklo refuses to expose a resolve-to-write symlink race window.',
    );
    this.name = 'CapturePublicationUnavailableError';
  }
}

/**
 * Validate untrusted inputs, then fail closed before browser launch or any
 * filesystem mutation. Capture can be re-enabled only behind a genuinely
 * path-pinned publication boundary and real app→capture→document E2E evidence.
 */
export async function runCapture(
  input: CaptureRunInput,
  _dependencies: CaptureRunDependencies = {},
): Promise<CaptureRunResult> {
  DokIdSchema.parse(input.dokId);
  const parsedConfig = parseCaptureConfig(input.config);
  if (!parsedConfig.doks[input.dokId]) throw new MissingDokRecipeError(input.dokId);
  throw new CapturePublicationUnavailableError();
}
