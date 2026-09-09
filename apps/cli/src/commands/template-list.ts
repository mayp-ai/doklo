// `doklo template list` — print every template across all 3 sources.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import {
  listTemplates,
  type ListEntry,
  type TemplateSource,
} from '@doklo-beta/livedoc-engine';
import type { CliContext } from '../lib/context.js';
import { registerTemplateScaffoldCommand } from './template-scaffold.js';
import { CommandContractError, recordCommandResult } from '../lib/command-result.js';

export interface ListOptions {
  root: string;
  source?: TemplateSource;
  includeExperimental?: boolean;
  json?: boolean;
}

export async function listAction(opts: ListOptions): Promise<ListEntry[]> {
  const entries = await listTemplates({
    workspaceRoot: opts.root,
    ...(opts.source ? { preferredSource: opts.source } : {}),
    ...(opts.includeExperimental ? { includeExperimental: true } : {}),
  });
  const rows = opts.source ? entries.filter((e) => e.source === opts.source) : entries;
  if (opts.json) return rows;
  if (rows.length === 0) {
    process.stdout.write(chalk.dim('No templates found.\n'));
    return rows;
  }
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    ver: Math.max(7, ...rows.map((r) => r.version.length)),
    src: Math.max(6, ...rows.map((r) => r.source.length)),
    stability: Math.max(9, ...rows.map((r) => r.stability.length)),
  };
  process.stdout.write(
    chalk.bold(`${pad('NAME', w.name)}  ${pad('VERSION', w.ver)}  ${pad('SOURCE', w.src)}  ${pad('STABILITY', w.stability)}  OUTPUT\n`),
  );
  for (const r of rows) {
    const marker = r.active ? chalk.green('●') : chalk.dim('○');
    process.stdout.write(
      `${marker} ${pad(r.name, w.name)}  ${pad(r.version, w.ver)}  ${pad(r.source, w.src)}  ${pad(r.stability, w.stability)}  ${r.outputFormats.join(', ')}\n`,
    );
    process.stdout.write(`  audience:       ${formatLocalized(r.audience)}\n`);
    process.stdout.write(`  purpose:        ${formatLocalized(r.purpose)}\n`);
    process.stdout.write(`  job:            ${formatLocalized(r.job)}\n`);
    process.stdout.write(`  required input: ${formatLocalized(r.requiredInput)}\n`);
    process.stdout.write(`  variables:      ${formatVariables(r.variables)}\n`);
    process.stdout.write(chalk.dim(`  path:           ${r.path}\n`));
  }
  return rows;
}

function machineTemplate(entry: ListEntry): Record<string, unknown> {
  return {
    name: entry.name,
    version: entry.version,
    source: entry.source,
    path: entry.path,
    active: entry.active,
    stability: entry.stability,
    audience: entry.audience,
    purpose: entry.purpose,
    job: entry.job,
    required_input: entry.requiredInput,
    variables: entry.variables,
    output_formats: entry.outputFormats,
  };
}

function formatLocalized(value: Record<string, string>): string {
  const entries = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, text]) => `${locale}=${text}`);
  return entries.length === 0 ? 'not declared' : entries.join(' | ');
}

function formatVariables(
  variables: Record<string, { type: string; required: boolean; description: string; default?: unknown }>,
): string {
  const entries = Object.entries(variables).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return 'none';
  return entries.map(([name, definition]) => {
    const requirement = definition.required ? 'required' : 'optional';
    const fallback = definition.default === undefined
      ? ''
      : `, default=${String(definition.default)}`;
    return `${name}:${definition.type} (${requirement}${fallback}) — ${definition.description}`;
  }).join(', ');
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export function registerTemplateCommands(program: Command, _ctx: CliContext): void {
  const tmpl = program.command('template').description('Manage Livedoc templates');

  tmpl
    .command('list')
    .description('List templates across workspace, user, and built-in sources')
    .option('--source <name>', 'restrict to workspace | user | builtin')
    .option('--experimental', 'include experimental templates')
    .option('--json', 'emit one terminal JSONL result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (opts: { source?: string; experimental?: boolean; json?: boolean; root?: string }) => {
      const rows = await listAction({
        root: resolve(opts.root ?? process.cwd()),
        ...(opts.source ? { source: opts.source as TemplateSource } : {}),
        ...(opts.experimental ? { includeExperimental: true } : {}),
        ...(opts.json ? { json: true } : {}),
      });
      if (opts.json) {
        recordCommandResult(program, {
          schema_version: 1,
          command: 'template list',
          status: 'success',
          data: { templates: rows.map(machineTemplate) },
          diagnostics: [],
        });
      }
    });

  tmpl
    .command('info <name>')
    .description('Print a template manifest summary')
    .option('--json', 'emit one terminal JSONL result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (name: string, opts: { json?: boolean; root?: string }) => {
      const { infoAction } = await import('./template-info.js');
      const template = await infoAction({
        name,
        root: resolve(opts.root ?? process.cwd()),
        ...(opts.json ? { json: true } : {}),
      });
      if (opts.json) {
        recordCommandResult(program, {
          schema_version: 1,
          command: 'template info',
          status: 'success',
          data: { template },
          diagnostics: [],
        });
      }
    });

  tmpl
    .command('validate <path>')
    .description('Validate a template directory against the manifest schema')
    .action(async (p: string) => {
      const { validateAction } = await import('./template-validate.js');
      const ok = await validateAction({ path: resolve(p) });
      if (!ok) {
        throw new CommandContractError(
          {
            schema_version: 1,
            command: 'template validate',
            status: 'unsupported',
            data: null,
            diagnostics: [],
          },
          2,
        );
      }
    });

  tmpl
    .command('add <url-or-path>')
    .description('Install a template from a git URL or local directory')
    .option('--name <override>', 'install under a different name')
    .option('--yes', 'skip interactive confirmation')
    .action(async (src: string, opts: { name?: string; yes?: boolean }) => {
      const { addAction } = await import('./template-add.js');
      await addAction({
        src,
        ...(opts.name ? { name: opts.name } : {}),
        yes: opts.yes ?? false,
      });
    });

  tmpl
    .command('remove <name>')
    .description('Remove an installed user template')
    .action(async (name: string) => {
      const { removeAction } = await import('./template-remove.js');
      await removeAction({ name });
    });

  registerTemplateScaffoldCommand(tmpl, _ctx);
}
