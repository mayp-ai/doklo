// `doklo evaluate` — read every Dok under .doklo/hub/doks (or doks.json
// for legacy/golden fixtures) and produce a ScoreReport via the
// @doklo-beta/evaluator package.

import type { Command } from 'commander';
import { readdir, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { join } from 'node:path';
import { runScore, type ScoreReport } from '@doklo-beta/evaluator';
import { DokSchema, type Dok, type DokStatus } from '@doklo-beta/core';
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
  review: EvaluateReviewSummary;
  /** Files that were skipped (schema fails, JSON parse fails, etc.). */
  problems: DokLoadProblem[];
}

export interface EvaluateReviewSummary {
  scope: 'recorded_metadata';
  notice: string;
  writing: {
    assessed_doks: number;
    missing_doks: number;
    doks_with_concerns: number;
    concerns: number;
  };
  content: {
    reported_doks: number;
    unreported_doks: number;
    missing_doks: number;
    unknown_doks: number;
    doks_with_concerns: number;
    concerns: number;
  };
  status: Record<DokStatus, number>;
}

const DOK_STATUSES: readonly DokStatus[] = [
  'draft', 'review', 'active', 'planned', 'deprecated', 'archived',
];

export async function runEvaluate(opts: RunEvaluateOptions): Promise<RunEvaluateResult> {
  const { paths } = await loadWorkspaceWithPaths(opts.root);

  const { doks, problems } = await loadDoks(paths.doksDir, join(paths.hubRoot, 'doks.json'));

  if (doks.length === 0) {
    throw new NoDoksFoundError(paths.doksDir);
  }

  const report = await runScore({ doks, projectRoot: paths.root });
  return { report, review: summarizeReview(doks), problems };
}

export function summarizeReview(doks: readonly Dok[]): EvaluateReviewSummary {
  const summary: EvaluateReviewSummary = {
    scope: 'recorded_metadata',
    notice: 'Recorded review signals may predate manual prose edits; they are not fresh findings or content approval.',
    writing: { assessed_doks: 0, missing_doks: 0, doks_with_concerns: 0, concerns: 0 },
    content: {
      reported_doks: 0,
      unreported_doks: 0,
      missing_doks: 0,
      unknown_doks: 0,
      doks_with_concerns: 0,
      concerns: 0,
    },
    status: Object.fromEntries(DOK_STATUSES.map((status) => [status, 0])) as Record<DokStatus, number>,
  };

  for (const dok of doks) {
    summary.status[dok.status] += 1;

    const writingReview = dok._meta.writing_review;
    if (writingReview === undefined) {
      summary.writing.missing_doks += 1;
    } else {
      summary.writing.assessed_doks += 1;
      summary.writing.concerns += writingReview.concerns.length;
      if (writingReview.concerns.length > 0) summary.writing.doks_with_concerns += 1;
    }

    const contentReview = dok._meta['content_review'];
    if (contentReview === undefined) {
      summary.content.missing_doks += 1;
      continue;
    }
    if (!isRecord(contentReview) || !Array.isArray(contentReview['concerns'])) {
      summary.content.unknown_doks += 1;
      continue;
    }

    const concerns = contentReview['concerns'].length;
    summary.content.concerns += concerns;
    if (concerns > 0) summary.content.doks_with_concerns += 1;
    if (contentReview['reported'] === true) summary.content.reported_doks += 1;
    else if (contentReview['reported'] === false) summary.content.unreported_doks += 1;
    else summary.content.unknown_doks += 1;
  }

  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      const { report, review, problems } = await runEvaluate({ root: opts.root as string });

      if (opts.json !== true) {
        console.log(`\n  ${chalk.cyan('Structural score:')} ${report.total}/${report.maxTotal} (${report.totalDoks} Dok${report.totalDoks === 1 ? '' : 's'})\n`);
        for (const [name, cat] of Object.entries(report.categories)) {
          const pad = name.padEnd(24);
          console.log(`    ${pad} ${cat.score}/${cat.max}`);
        }
        console.log(`\n  ${chalk.cyan('Review signals:')}`);
        console.log('    Counts are recorded metadata and may predate manual prose edits.');
        console.log(`    writing concerns: ${review.writing.concerns} across ${review.writing.doks_with_concerns} Dok(s); assessed: ${review.writing.assessed_doks}; missing: ${review.writing.missing_doks}`);
        console.log(`    content concerns: ${review.content.concerns} across ${review.content.doks_with_concerns} Dok(s); reported: ${review.content.reported_doks}; unreported: ${review.content.unreported_doks}; content review missing: ${review.content.missing_doks}; unknown: ${review.content.unknown_doks}`);
        console.log(`    status: ${DOK_STATUSES.map((status) => `${status} ${review.status[status]}`).join('; ')}`);
        console.log('    This score is not content approval.');
      }
      recordCommandResult(program, {
        schema_version: 1,
        command: 'evaluate',
        status: problems.length > 0 ? 'partial' : 'success',
        data: { report, review, problems },
        diagnostics: problems.map((problem) => ({
          code: 'VALIDATION_FAILED',
          message: problem.reason,
          file: problem.file,
        })),
      });
      void ctx;
    });
}
