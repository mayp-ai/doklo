// `doklo evaluate` — read every Dok under .doklo/hub/doks (or doks.json
// for legacy/golden fixtures) and produce a ScoreReport via the
// @doklo-beta/evaluator package.

import type { Command } from 'commander';
import { readdir, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import { runScore, type ScoreReport } from '@doklo-beta/evaluator';
import { DokSchema, type Dok } from '@doklo-beta/core';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import type { CliContext } from '../lib/context.js';
import { recordCommandResult } from '../lib/command-result.js';

export class NoDoksFoundError extends Error {
  constructor(public readonly hubDir: string) {
    super(
      `No Dok files found under ${hubDir}. Run \`doklo generate\` first or migrate a doks.json fixture.`,
    );
    this.name = 'NoDoksFoundError';
  }
}

export interface DokLoadProblem {
  file: string;
  reason: string;
}

export interface RunEvaluateOptions {
  root: string;
  /** Limit to one criterion category — reserved for future flag wiring. */
  category?: string;
}

export interface RunEvaluateResult {
  report: ScoreReport;
  /** Files that were skipped (schema fails, JSON parse fails, etc.). */
  problems: DokLoadProblem[];
}

export async function runEvaluate(opts: RunEvaluateOptions): Promise<RunEvaluateResult> {
  const { paths } = await loadWorkspaceWithPaths(opts.root);

  const { doks, problems } = await loadDoks(paths.doksDir, join(paths.hubRoot, 'doks.json'));

  if (doks.length === 0) {
    throw new NoDoksFoundError(paths.doksDir);
  }

  const report = await runScore({ doks, projectRoot: paths.root });
  return { report, problems };
}

async function loadDoks(
  doksDir: string,
  legacyDoksFile: string,
): Promise<{ doks: Dok[]; problems: DokLoadProblem[] }> {
  const doks: Dok[] = [];
  const problems: DokLoadProblem[] = [];

  // Per-Dok files first.
  if (await exists(doksDir)) {
    const entries = await readdir(doksDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = join(doksDir, entry);
      try {
        const raw = JSON.parse(await readFile(file, 'utf-8'));
        const parsed = DokSchema.safeParse(raw);
        if (parsed.success) {
          doks.push(parsed.data);
        } else {
          problems.push({ file, reason: parsed.error.message });
        }
      } catch (err) {
        problems.push({ file, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Legacy/golden compat — single doks.json with an array.
  if (doks.length === 0 && (await exists(legacyDoksFile))) {
    try {
      const raw = JSON.parse(await readFile(legacyDoksFile, 'utf-8')) as unknown;
      if (Array.isArray(raw)) {
        for (const [i, item] of raw.entries()) {
          const parsed = DokSchema.safeParse(item);
          if (parsed.success) {
            doks.push(parsed.data);
          } else {
            problems.push({
              file: `${legacyDoksFile}#${i}`,
              reason: parsed.error.message,
            });
          }
        }
      }
    } catch (err) {
      problems.push({
        file: legacyDoksFile,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { doks, problems };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ───────── commander wiring ─────────────────────────────────────────

export function registerEvaluateCommand(program: Command, ctx: CliContext): void {
  program
    .command('evaluate')
    .alias('eval')
    .description('Score the generated Doks against the v5 quality criteria')
    .option('-r, --root <dir>', 'Workspace root', process.cwd())
    .option('--json', 'Emit JSONL only', false)
    .action(async (opts) => {
      const { default: chalk } = await import('chalk');
      const { report, problems } = await runEvaluate({ root: opts.root as string });

      if (opts.json !== true) {
        console.log(`\n  ${chalk.cyan('Score:')} ${report.total}/${report.maxTotal} (${report.totalDoks} Dok${report.totalDoks === 1 ? '' : 's'})\n`);
        for (const [name, cat] of Object.entries(report.categories)) {
          const pad = name.padEnd(24);
          console.log(`    ${pad} ${cat.score}/${cat.max}`);
        }
      }
      recordCommandResult(program, {
        schema_version: 1,
        command: 'evaluate',
        status: problems.length > 0 ? 'partial' : 'success',
        data: { report, problems },
        diagnostics: problems.map((problem) => ({
          code: 'VALIDATION_FAILED',
          message: problem.reason,
          file: problem.file,
        })),
      });
      void ctx;
    });
}
