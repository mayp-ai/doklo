// `doklo serve` — launches Doklo Studio for the current workspace.
//
// Two run modes, tried in order (see resolveStudio):
//   1. packaged standalone — the published @mayp/doklo package ships a
//      self-contained Next.js production build at <packageRoot>/studio/. We
//      boot its server.js directly (no monorepo, no `next` install needed).
//   2. monorepo dev — apps/studio with an installed `next` binary. Spawns
//      `next dev`, same as before.
//
// Either way the workspace root is passed via DOKLO_WORKSPACE_ROOT; Studio
// reads it on every request to find workspace.json and .doklo/hub/doks/.
// Press Ctrl+C to stop.

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import {
  loadWorkspaceWithPaths,
  WorkspaceNotInitializedError,
} from '../lib/workspace.js';
import {
  DEFAULT_STUDIO_PORT,
  pickStudioPort,
  waitForStudioReady,
} from '../lib/studio-port.js';
import type { CliContext } from '../lib/context.js';

export interface RunServeOptions {
  root: string;
  port: number;
  /** When true, open the browser (at `openPath`) once the server is
   *  confirmed to answer HTTP on the port. */
  open?: boolean;
  /** Path to open when `open` is true. Defaults to the workspace Hub;
   *  the generate gate's `[s]` passes '/consolidation'. */
  openPath?: string;
}

/** Build the URL `serve --open` (and the generate gate's `[s]`) opens. */
export function studioOpenUrl(port: number, openPath = '/doks'): string {
  return `http://localhost:${port}${openPath}`;
}

/** Open a URL in the OS default browser. Best-effort, non-blocking — the
 *  demo still works if this no-ops (the URL is printed regardless). */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore — URL was already printed for the user to click.
  }
}

/** Raised when neither a packaged standalone build nor a monorepo dev
 *  checkout can be located. Lists every path probed so the failure is
 *  self-diagnosing. Merges the old StudioNotFound/StudioNextNotFound errors. */
export class StudioNotFoundError extends Error {
  constructor(public readonly searched: string[]) {
    super(
      `Could not locate Doklo web to serve. Looked for a packaged standalone ` +
        `build and a monorepo dev checkout, but found neither.\nSearched:\n` +
        searched.map((p) => `  - ${p}`).join('\n') +
        `\n\nIf you installed @mayp/doklo globally, its bundled studio/ build may be ` +
        `missing. Inside the monorepo, run \`pnpm install\` (dev mode) or ` +
        `\`pnpm -C apps/studio build:standalone\` (packaged mode).`,
    );
    this.name = 'StudioNotFoundError';
  }
}

// Resolve paths relative to this compiled module. Dev layout:
//   <repo>/apps/cli/dist/commands/serve.js → ../../../studio = <repo>/apps/studio
const HERE = dirname(fileURLToPath(import.meta.url));
export const STUDIO_DIR = resolve(HERE, '..', '..', '..', 'studio');

export function studioNextBin(
  studioDir = STUDIO_DIR,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(
    studioDir,
    'node_modules',
    '.bin',
    platform === 'win32' ? 'next.cmd' : 'next',
  );
}

export interface ResolveCliEntryOptions {
  here?: string;
}

/** Resolve the compiled CLI entry that Studio must spawn for `generate`.
 *  This is deliberately independent of Studio's cwd, which differs between
 *  monorepo dev and Next's traced standalone server. */
export async function resolveCliEntry(
  options: ResolveCliEntryOptions = {},
): Promise<string> {
  const here = options.here ?? HERE;
  const candidates = [
    // Esbuild release: dist/index.js imports this bundled command directly.
    resolve(here, 'index.js'),
    // Built CLI: dist/commands/serve.js -> dist/index.js.
    resolve(here, '..', 'index.js'),
    // `pnpm dev` loads src/commands/serve.ts through tsx, but Studio still
    // needs a Node-runnable built entry rather than the TypeScript source.
    resolve(here, '..', '..', 'dist', 'index.js'),
  ];
  for (const entry of candidates) {
    if (await exists(entry)) return entry;
  }
  throw new Error(
    `Could not locate Doklo CLI entry for web. Searched:\n${candidates
      .map((entry) => `  - ${entry}`)
      .join('\n')}`,
  );
}

export function studioServeEnv(input: {
  mode: StudioResolution['mode'];
  baseEnv: NodeJS.ProcessEnv;
  workspaceRoot: string;
  cliBin: string;
  port: number;
}): NodeJS.ProcessEnv {
  return {
    ...input.baseEnv,
    DOKLO_WORKSPACE_ROOT: input.workspaceRoot,
    DOKLO_CLI_BIN: input.cliBin,
    ...(input.mode === 'standalone'
      ? { PORT: String(input.port), HOSTNAME: '127.0.0.1' }
      : { DOKLO_STUDIO_PORT: String(input.port) }),
  };
}

/** The outcome of locating Studio: either a packaged standalone server.js to
 *  boot with `node`, or a monorepo dev studio dir to run `next dev` in. */
export type StudioResolution =
  | { mode: 'standalone'; serverJs: string }
  | { mode: 'dev'; studioDir: string };

export interface ResolveStudioOptions {
  /** Base dir the packaged-standalone candidates are resolved against.
   *  Defaults to this module's dir. Injected in tests. */
  here?: string;
  /** Monorepo dev studio dir. Defaults to STUDIO_DIR. Injected in tests. */
  devStudioDir?: string;
  /** Platform, for the dev-mode `next` binary name. Defaults to the host. */
  platform?: NodeJS.Platform;
}

/** Locate Studio, preferring a packaged standalone build over a monorepo dev
 *  checkout. Pure/async and dependency-light: pass `here`/`devStudioDir` to
 *  point it at temp-dir fixtures in tests. Throws StudioNotFoundError (listing
 *  every probed path) when neither is present. */
export async function resolveStudio(
  opts: ResolveStudioOptions = {},
): Promise<StudioResolution> {
  const here = opts.here ?? HERE;
  const devStudioDir = opts.devStudioDir ?? STUDIO_DIR;
  const platform = opts.platform ?? process.platform;

  const searched: string[] = [];

  // 1. Packaged standalone. The published package copies .next/standalone/ to
  //    <packageRoot>/studio/. This module sits 1–3 dirs under <packageRoot>
  //    depending on the dist layout (dist/index.js bundle vs dist/commands/
  //    serve.js), so probe each candidate root. Within a root the entry is at
  //    apps/studio/server.js (monorepo trace layout) or server.js (flat).
  const standaloneRoots = [
    resolve(here, '..', 'studio'),
    resolve(here, '..', '..', 'studio'),
    resolve(here, '..', '..', '..', 'studio'),
  ];
  for (const root of standaloneRoots) {
    for (const serverJs of [
      join(root, 'apps', 'studio', 'server.js'),
      join(root, 'server.js'),
    ]) {
      searched.push(serverJs);
      if (await exists(serverJs)) {
        return { mode: 'standalone', serverJs };
      }
    }
  }

  // 2. Monorepo dev: apps/studio present with an installed `next` binary.
  const nextBin = studioNextBin(devStudioDir, platform);
  searched.push(devStudioDir, nextBin);
  if ((await exists(devStudioDir)) && (await exists(nextBin))) {
    return { mode: 'dev', studioDir: devStudioDir };
  }

  // 3. Neither.
  throw new StudioNotFoundError(searched);
}

/** Studio can only ever show a workspace that exists on disk. Check for one
 *  before anything is printed: the startup banner carries a live URL, and a
 *  URL for a server that never starts is worse than no URL at all — the user
 *  opens it, sees a dead port, and has no idea which of the two of them
 *  failed. Replaces the bare "run `doklo init`" line with the whole path from
 *  an untouched project directory to a Hub with Doks in it.
 *
 *  Studio used to fill this silence with its bundled demo workspace. It no
 *  longer does (the release bundle drops demo/ entirely), so the empty case
 *  has to answer for itself. */
export async function requireWorkspaceForStudio(root: string): Promise<void> {
  try {
    await loadWorkspaceWithPaths(root);
  } catch (error) {
    if (!(error instanceof WorkspaceNotInitializedError)) throw error;
    throw new WorkspaceNotInitializedError(
      error.searchedFrom,
      `There is no Doklo workspace at or above ${error.searchedFrom}, ` +
        `so web has nothing to show.\n` +
        `  1. cd into the project you want to document\n` +
        `  2. doklo init      — set up the workspace\n` +
        `  3. doklo generate  — read your code into Doks\n` +
        `  4. doklo serve     — open them in web`,
    );
  }
}

export async function runServe(opts: RunServeOptions): Promise<void> {
  // Validate workspace exists before launching Studio (better error UX).
  const { paths } = await loadWorkspaceWithPaths(opts.root);

  const studio = await resolveStudio();
  const cliBin = await resolveCliEntry();

  await new Promise<void>((resolveP, reject) => {
    const child =
      studio.mode === 'standalone'
        ? // Next standalone server.js reads PORT/HOSTNAME from env. Run it with
          // the current node binary, cwd at its own dir so relative requires
          // (./.next, ./node_modules) resolve.
          spawn(process.execPath, [studio.serverJs], {
            cwd: dirname(studio.serverJs),
            env: studioServeEnv({
              mode: 'standalone',
              baseEnv: process.env,
              workspaceRoot: paths.root,
              cliBin,
              port: opts.port,
            }),
            stdio: 'inherit',
          })
        : spawn(
            studioNextBin(studio.studioDir),
            ['dev', '-H', '127.0.0.1', '-p', String(opts.port)],
            {
              cwd: studio.studioDir,
              env: studioServeEnv({
                mode: 'dev',
                baseEnv: process.env,
                workspaceRoot: paths.root,
                cliBin,
                port: opts.port,
              }),
              stdio: 'inherit',
            },
          );

    // Open the browser only once the server actually answers HTTP on the
    // port. Polling is aborted if the child dies first, so we never open a
    // dead port — or a foreign server that happens to hold it. On timeout we
    // silently skip the auto-open; the URL was already printed for the user.
    const openAbort = new AbortController();
    if (opts.open) {
      const target = studioOpenUrl(opts.port, opts.openPath);
      void waitForStudioReady(target, { signal: openAbort.signal }).then(
        (ready) => {
          if (ready && !openAbort.signal.aborted) openBrowser(target);
        },
      );
    }

    const cleanup = () => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    child.on('error', (err) => {
      openAbort.abort();
      reject(
        new Error(
          `Failed to spawn Doklo web (${studio.mode} mode): ${err.message}`,
        ),
      );
    });
    child.on('exit', (code) => {
      openAbort.abort();
      // SIGTERM is the expected shutdown path (Ctrl+C). Don't treat it as error.
      if (code === 0 || code === null) resolveP();
      else reject(new Error(`web exited with code ${code}`));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerServeCommand(program: Command, ctx: CliContext): void {
  program
    .command('serve')
    .description('Launch Doklo web (packaged build or dev server) for the workspace')
    .option('-r, --root <dir>', 'Workspace root', process.cwd())
    .option('-p, --port <number>', 'Port', String(DEFAULT_STUDIO_PORT))
    .option('--open', 'Open the real workspace Hub in your browser', false)
    .action(async (opts, cmd: Command) => {
      const { default: chalk } = await import('chalk');
      const preferred = Number(opts.port);
      const open = opts.open as boolean;
      // An explicit --port is a promise to the user — fail rather than drift
      // to a neighbor. The default port is ours to move when it is busy.
      const strict = cmd.getOptionValueSource('port') === 'cli';
      // Order matters: every check that can fail runs before the first line
      // of output. "This is not a workspace" comes first because it is the
      // one the user can act on without knowing anything about Studio.
      await requireWorkspaceForStudio(opts.root as string);
      // Resolve up front so an unfound Studio fails before the banner, and so
      // the banner can drop the dev-only "compiling" note in standalone mode.
      const studio = await resolveStudio();
      // Pick the port before the banner so the printed URL is truthful.
      const { port, fallback } = await pickStudioPort(preferred, { strict });
      const startupNote =
        studio.mode === 'dev'
          ? chalk.dim('First request takes ~5s while Next.js compiles. Ctrl+C to stop.')
          : chalk.dim('Ctrl+C to stop.');
      const fallbackNote = fallback
        ? `  ${chalk.dim(`Port ${preferred} is in use — using ${port} instead.`)}\n`
        : '';
      console.log(
        `\n  ${chalk.cyan('Starting Doklo web')} ${chalk.dim(`for ${opts.root}`)}\n` +
          fallbackNote +
          `  ${chalk.bold(`http://localhost:${port}/doks`)}` +
          `  ${chalk.dim('— workspace Hub')}\n` +
          `  ${startupNote}\n`,
      );
      await runServe({ root: opts.root as string, port, open });
      void ctx;
    });
}
