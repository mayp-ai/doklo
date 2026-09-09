import { access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join, resolve } from 'node:path';

export class StudioCliBinNotFoundError extends Error {
  constructor(public readonly searched: string[]) {
    super(
      `Could not locate the Doklo CLI entry used for generation. Searched:\n${searched
        .map((path) => `  - ${path}`)
        .join('\n')}`,
    );
    this.name = 'StudioCliBinNotFoundError';
  }
}

export interface ResolveStudioCliBinOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate a real compiled CLI entry in both monorepo-dev and traced standalone
 *  layouts. A serve-provided DOKLO_CLI_BIN wins, but is still verified. */
export async function resolveStudioCliBin(
  options: ResolveStudioCliBinOptions = {},
): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const exists = options.exists ?? pathExists;
  const override = env.DOKLO_CLI_BIN?.trim();
  const candidates = override
    ? [resolve(override)]
    : [
      join(cwd, 'node_modules', '@doklo-beta', 'cli', 'dist', 'index.js'),
      join(cwd, '..', 'cli', 'dist', 'index.js'),
      join(cwd, '..', '..', 'apps', 'cli', 'dist', 'index.js'),
    ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new StudioCliBinNotFoundError(candidates);
}
