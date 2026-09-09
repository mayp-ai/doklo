// MCP server assembly — wires the three read-only tools onto an McpServer and
// serves them over stdio.
//
// stdio transport contract: stdout is the JSON-RPC channel. Nothing here may
// write to stdout (no console.log). Diagnostics go to stderr via the caller.
//
// Data access is `loadHubModel` only, re-run on every tool call so file edits
// are reflected without a restart (MVP: no caching). Workspace resolution also
// happens per call, so the server starts fine even before `doklo init`
// and reports a friendly tool error when a workspace can't be found.

import { dirname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadHubModel, type HubModel } from '@doklo-beta/core';
import { findWorkspaceFile } from '../lib/workspace.js';
import {
  DokNotFoundError,
  getDok,
  listDoksTool,
  searchDoks,
} from './tools.js';

/** How the server was told to find the workspace. `explicitRoot` (from --root)
 *  wins; otherwise resolution walks up from process.cwd() at call time. */
export interface McpServerOptions {
  /** Absolute or relative path from `--root`. Overrides env + cwd search. */
  explicitRoot?: string;
  /** CLI version string for the MCP server handshake. */
  version: string;
}

/** JSON text content, the single content shape all three tools return. */
function jsonContent(payload: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/** A tool error the agent can read and act on. */
function errorContent(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Resolve the workspace root at tool-call time.
 * Order: --root flag > DOKLO_WORKSPACE_ROOT env > upward search from cwd.
 * Returns null when no workspace.json can be found by search.
 */
export async function resolveWorkspaceRoot(
  opts: McpServerOptions,
): Promise<string | null> {
  if (opts.explicitRoot) return opts.explicitRoot;
  const envRoot = process.env['DOKLO_WORKSPACE_ROOT'];
  if (envRoot) return envRoot;
  const found = await findWorkspaceFile(process.cwd());
  return found ? dirname(found) : null;
}

/** Load the Hub for the resolved root, or throw with an agent-actionable
 *  message when the workspace is missing. Keeps the tool handlers tiny. */
async function loadHub(
  opts: McpServerOptions,
): Promise<{ hub: HubModel; root: string }> {
  const root = await resolveWorkspaceRoot(opts);
  if (!root) {
    throw new WorkspaceNotFoundError(process.cwd());
  }
  const hub = await loadHubModel(root);
  return { hub, root };
}

/** Distinct from core's MissingHubError so the message is agent-facing. */
class WorkspaceNotFoundError extends Error {
  constructor(searchedFrom: string) {
    super(
      `workspace.json not found — run \`doklo init\` first (searched from ${searchedFrom}).`,
    );
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Build the McpServer with the three read-only tools registered.
 * The caller connects it to a transport (StdioServerTransport in production).
 */
export function buildMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'doklo', version: opts.version });

  server.registerTool(
    'search_doks',
    {
      title: 'Search Doks',
      description:
        'Search Doklo Hub context by keyword across ids, names, ' +
        'descriptions, user-action intents, tags, and lexicon terms. ' +
        'Each result includes its human-review status and freshness. ' +
        'Deterministic case-insensitive substring match. Returns summaries only. ' +
        'is_stale: true = tracked sources changed or recovered tracking needs review, so prefer ' +
        'the current code; false = sources unchanged, which is not a claim the ' +
        'Dok is correct; "unknown" = no drift hash or unverified source tracking.',
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => {
      try {
        const { hub, root } = await loadHub(opts);
        return jsonContent(searchDoks(hub, root, query));
      } catch (err) {
        return errorContent(messageOf(err));
      }
    },
  );

  server.registerTool(
    'get_dok',
    {
      title: 'Get Dok',
      description:
        'Fetch one Dok in full by id (case-insensitive): user actions, business ' +
        'rules, acceptance criteria, source anchors (provenance), and freshness. ' +
        'Use search_doks or list_doks first to find ids. ' +
        'is_stale: true = tracked source files changed after this Dok was ' +
        'generated, or recovered tracking needs review — treat the Dok as possibly outdated and prefer the current ' +
        'code (`doklo sync` regenerates it). false = tracked sources are ' +
        'byte-identical since generation (not a claim the doc is correct). ' +
        '"unknown" = no drift hash or unverified source tracking, so drift could not be decided.',
      inputSchema: { dok_id: z.string().min(1) },
    },
    async ({ dok_id }) => {
      try {
        const { hub, root } = await loadHub(opts);
        return jsonContent(getDok(hub, root, dok_id));
      } catch (err) {
        // A missing Dok is an expected tool error, not a crash.
        if (err instanceof DokNotFoundError) return errorContent(err.message);
        return errorContent(messageOf(err));
      }
    },
  );

  server.registerTool(
    'list_doks',
    {
      title: 'List Doks',
      description:
        'List Dok summaries, optionally filtered by status, surfacing service, ' +
        'or staleness. Sorted by id. A cheap way to enumerate available context. ' +
        'is_stale: true = tracked sources changed or recovered tracking needs review, so prefer ' +
        'the current code; false = sources unchanged, which is not a claim the ' +
        'Dok is correct; "unknown" = no drift hash or unverified source tracking (matches neither ' +
        'value of the `stale` filter).',
      inputSchema: {
        status: z.string().optional(),
        service: z.string().optional(),
        stale: z.boolean().optional(),
      },
    },
    async ({ status, service, stale }) => {
      try {
        const { hub, root } = await loadHub(opts);
        return jsonContent(listDoksTool(hub, root, { status, service, stale }));
      } catch (err) {
        return errorContent(messageOf(err));
      }
    },
  );

  return server;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start the stdio MCP server. Resolves only when the transport closes
 * (SIGINT/SIGTERM), so the caller can await it to keep the process alive.
 */
export async function startStdioServer(opts: McpServerOptions): Promise<void> {
  const server = buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
