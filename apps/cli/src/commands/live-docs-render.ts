// `doklo live-docs render <template>` — render a Livedoc against the
// current workspace's Hub. Spec §11 surface; exit codes per spec §12.

import type { Command } from 'commander';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadHubModel } from '@doklo-beta/core';
import {
  EngineError,
  StableLintError,
  loadWorkspaceAudienceDictionary,
  renderLivedoc,
  type PublicationFormat,
  type TemplateSource,
} from '@doklo-beta/livedoc-engine';
import type { CliContext } from '../lib/context.js';
import {
  CommandContractError,
  recordCommandResult,
  toCommandContractError,
} from '../lib/command-result.js';
import { stabilityDiagnostics } from '../lib/livedoc-stability.js';

function parseVars(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pairs) return out;
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 1) continue;
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

interface Opts {
  locale?: string;
  primaryLocale?: string;
  outDir?: string;
  dok?: string[];
  source?: string;
  var?: string[];
  dryRun?: boolean;
  preview?: boolean;
  overwrite?: boolean;
  format?: PublicationFormat;
  allFormats?: boolean;
  noHtml?: boolean;
  html?: boolean;
  json?: boolean;
  strict?: boolean;
  root?: string;
}

/**
 * Get-or-create the `live-docs` parent command so multiple register*Command
 * functions can attach sibling subcommands without clobbering each other.
 */
export function ensureLiveDocsCommand(program: Command): Command {
  const existing = program.commands.find((c) => c.name() === 'live-docs');
  if (existing) return existing;
  return program
    .command('live-docs')
    .description('Render Live Docs from the workspace Hub');
}

export function registerLiveDocsRenderCommand(program: Command, _ctx: CliContext): void {
  const liveDocs = ensureLiveDocsCommand(program);

  liveDocs
    .command('render <template>')
    .description('Render a Livedoc from the workspace Hub')
    .option('--locale <code>', 'output locale (e.g., ko, en)')
    .option('--primary-locale <code>', 'fallback chain head locale')
    .option('--out-dir <path>', 'output directory (default: .doklo/output; preview: .doklo/output/preview)')
    .option('--dok <id>', 'restrict to specific Dok id (repeatable)', collect, [])
    .option('--source <name>', 'workspace | user | builtin')
    .option('--var <key=value>', 'extra Handlebars context var (repeatable)', collect, [])
    .option('--preview', 'review draft Doks with a persistent watermark (stable Markdown/HTML only)')
    .option('--dry-run', 'report selector matches + planned outputs without writing')
    .option('--overwrite', 'replace existing planned outputs')
    .option('--format <format>', 'render one declared template output format')
    .option('--all-formats', 'render every declared template output format')
    .option('--no-html', 'deprecated compatibility fan-out excluding HTML')
    .option('--json', 'emit one terminal JSONL result envelope')
    .option('--strict', 'treat empty selector match as a hard error')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (template: string, opts: Opts) => {
      const workspaceRoot = resolve(opts.root ?? process.cwd());
      const outDir = resolve(workspaceRoot, opts.outDir ?? (opts.preview ? '.doklo/output/preview' : '.doklo/output'));
      const locale = opts.locale ?? process.env['DOKLO_LOCALE'] ?? 'en';
      const machine = opts.json === true;
      const legacyNoHtml = opts.noHtml === true || opts.html === false;

      try {
        const primaryLocale = opts.primaryLocale
          ?? (await loadHubModel(workspaceRoot)).workspace.default_locale;
        const audience = await loadWorkspaceAudienceDictionary(
          workspaceRoot,
          locale,
          primaryLocale,
        );
        const result = await renderLivedoc({
          workspaceRoot,
          templateRef: template,
          locale,
          primaryLocale,
          outDir,
          outputRoot: workspaceRoot,
          ...(opts.dok && opts.dok.length > 0 ? { dokIds: opts.dok } : {}),
          ...(opts.source ? { source: opts.source as TemplateSource } : {}),
          variables: parseVars(opts.var),
          ...(opts.overwrite ? { overwrite: true } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
          ...(opts.preview ? { preview: true } : {}),
          ...(opts.format ? { format: opts.format } : {}),
          ...(opts.allFormats ? { allFormats: true } : {}),
          ...(legacyNoHtml ? { noHtml: true } : {}),
          ...(opts.strict ? { strict: true } : {}),
          ...(audience.dictionary ? { audienceDictionary: audience.dictionary } : {}),
        });
        if (!machine && opts.dryRun) {
          process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
        } else if (!machine) {
          const n = result.outputs.length;
          process.stdout.write(
            chalk.green(`✓ Rendered ${n} file${n === 1 ? '' : 's'} → ${outDir}\n`),
          );
        }
        recordCommandResult(program, {
          schema_version: 1,
          command: 'live-docs render',
          status: 'success',
          data: { plan: result.plan, manifest: result.manifest },
          diagnostics: [
            ...stabilityDiagnostics(
              result.manifest.template.name,
              result.manifest.template.stability,
            ),
            ...(audience.malformed ? [{
              code: 'AUDIENCE_TEXT_MALFORMED',
              message: '.doklo/audience-text.json is malformed — skipping audience buffering.',
            }] : []),
            ...(audience.rejected ? [{
              code: 'AUDIENCE_TEXT_REJECTED',
              message:
                '.doklo/audience-text.json was not read because it escapes the workspace or is '
                + 'not a regular file — skipping audience buffering.',
            }] : []),
            ...(legacyNoHtml ? [{
              code: 'DEPRECATED_NO_HTML',
              message: '--no-html is deprecated; use --format <format> or --all-formats for explicit render intent.',
            }] : []),
            ...result.manifest.warnings.map((warning) => ({
              code: warning.code,
              message: warning.message,
            })),
          ],
        });
      } catch (err) {
        handleEngineError(err);
      }
    });

  liveDocs
    .command('list')
    .description('Alias for `doklo template list`')
    .action(async () => {
      const { listAction } = await import('./template-list.js');
      await listAction({ root: process.cwd() });
    });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function handleEngineError(err: unknown): never {
  if (err instanceof StableLintError) {
    throw new CommandContractError(
      {
        schema_version: 1,
        command: 'live-docs render',
        status: 'failed',
        data: null,
        diagnostics: err.violations.map((violation) => ({
          code: violation.code,
          message: `${violation.message} Excerpt: ${violation.excerpt}`,
        })),
      },
      1,
    );
  }
  if (err instanceof EngineError) {
    const exitCode = errorExitCode(err.code);
    throw new CommandContractError(
      {
        schema_version: 1,
        command: 'live-docs render',
        status: exitCode === 2 ? 'unsupported' : 'failed',
        data: null,
        diagnostics: [{ code: err.code, message: err.message }],
      },
      exitCode,
    );
  }
  throw toCommandContractError(err, 'live-docs render');
}

function errorExitCode(code: string): 1 | 2 {
  switch (code) {
    case 'TEMPLATE_NOT_FOUND':
    case 'SELECTOR_EMPTY':
      return 1;
    case 'INVALID_MANIFEST':
    case 'MISSING_HUB_LAYER':
    case 'ENGINE_VERSION_MISMATCH':
    case 'OUTPUT_FORMAT_REQUIRED':
    case 'OUTPUT_FORMAT_REJECTED':
      return 2;
    default:
      return 1;
  }
}
