// `doklo mcp` — serve the Hub to AI agents over a stdio MCP server.
//
// Exposes three read-only tools (search_doks / get_dok / list_doks). This is
// the agent-facing counterpart to `serve` (which is for humans, in a browser).
//
// stdio contract: stdout is the JSON-RPC channel. Every human-facing line —
// the startup banner, the no-workspace warning — goes to stderr, unlike the
// other commands which log to stdout. One stray stdout write breaks the
// protocol, so this command deliberately does NOT follow the serve.ts banner
// pattern.

import type { Command } from 'commander';
import type { CliContext } from '../lib/context.js';
import {
  resolveWorkspaceRoot,
  startStdioServer,
  type McpServerOptions,
} from '../mcp/server.js';

export interface RunMcpOptions {
  /** Value of the --root flag, if provided. */
  root?: string;
  /** CLI version for the MCP handshake. */
  version: string;
}

export async function runMcp(ctx: CliContext, opts: RunMcpOptions): Promise<void> {
  const serverOpts: McpServerOptions = {
    version: opts.version,
    ...(opts.root ? { explicitRoot: opts.root } : {}),
  };

  // Resolve once up front purely for the startup banner. The tools re-resolve
  // and re-load on every call, so a missing workspace here is only a warning.
  const root = await resolveWorkspaceRoot(serverOpts);
  const { default: chalk } = await import('chalk');
  if (root) {
    process.stderr.write(`${chalk.cyan(ctx.t('mcp.started', { root }))}\n`);
  } else {
    process.stderr.write(`${chalk.yellow(ctx.t('mcp.no_workspace'))}\n`);
  }

  // The stdio transport owns its lifecycle. Do not install command-level
  // signal handlers that bypass the CLI's single exit boundary.
  await startStdioServer(serverOpts);
}

export function registerMcpCommand(program: Command, ctx: CliContext): void {
  program
    .command('mcp')
    .description('Serve the Hub to AI agents over a stdio MCP server (read-only)')
    .option('-r, --root <dir>', 'Workspace root (defaults to nearest workspace.json)')
    .action(async (opts) => {
      await runMcp(ctx, {
        version: program.version() ?? '0.0.0',
        ...(opts.root ? { root: opts.root as string } : {}),
      });
    });
}
