// `doklo show <DOK-ID>` — pretty-print a single Dok in the terminal.
// `doklo show`           — list every generated Dok with name preview.
//
// Read-only: no LLM calls, no network. Just walks .doklo/hub/doks/ and
// formats the JSON in a way that's pleasant to scan in a terminal.

import type { Command } from 'commander';
import { readFile, readdir, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import {
  DokSchema,
  derivePriorityTier,
  dokProjectRoot,
  isDokStale,
  type Actor,
  type Dok,
  type PriorityTier,
  type StaleResult,
  type Translatable,
} from '@doklo-beta/core';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import type { CliContext } from '../lib/context.js';
import { recordCommandResult } from '../lib/command-result.js';

export class DokNotFoundError extends Error {
  constructor(public readonly dokId: string, public readonly hubDir: string) {
    super(`Dok "${dokId}" not found under ${hubDir}`);
    this.name = 'DokNotFoundError';
  }
}

export interface LoadDokOptions {
  root: string;
  dokId: string;
}

export async function loadDok(opts: LoadDokOptions): Promise<Dok> {
  const { paths } = await loadWorkspaceWithPaths(opts.root);
  // Try the id as given first, then upper, then lower — robust to user
  // shell auto-completion that may have lowercased the prefix.
  const candidates = [opts.dokId, opts.dokId.toUpperCase(), opts.dokId.toLowerCase()];
  for (const id of candidates) {
    const file = paths.dokFile(id);
    if (await exists(file)) {
      const raw = JSON.parse(await readFile(file, 'utf-8'));
      return DokSchema.parse(raw);
    }
  }
  throw new DokNotFoundError(opts.dokId, paths.doksDir);
}

/**
 * Resolve a Dok's freshness against the code on disk (drift-spec §4.5).
 *
 * Re-reads the workspace to resolve the anchor base — anchor paths are stored
 * relative to the owning service's `code_root`, so `dokProjectRoot` must map the
 * Dok back to that base before the stored `logic_hash` can be compared with a
 * hash recomputed from the source files. Synchronous drift judgment lives in
 * core; this only wires the workspace context in. Read-only, safe on the show
 * path (`no-hash` ⇒ undecidable ⇒ reported as not stale).
 */
export async function dokStaleness(root: string, dok: Dok): Promise<StaleResult> {
  const { workspace, paths } = await loadWorkspaceWithPaths(root);
  return isDokStale(dok, dokProjectRoot(dok, workspace, paths.root));
}

export interface DokSummary {
  dok_id: string;
  name: string;
  status: Dok['status'];
}

export async function listDoks(opts: { root: string }): Promise<DokSummary[]> {
  const { paths } = await loadWorkspaceWithPaths(opts.root);
  if (!(await exists(paths.doksDir))) return [];
  const entries = await readdir(paths.doksDir);
  const out: DokSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(paths.dokFile(entry.replace(/\.json$/, '')), 'utf-8'));
      const parsed = DokSchema.safeParse(raw);
      if (parsed.success) {
        out.push({
          dok_id: parsed.data.dok_id,
          name: translatableToString(parsed.data.name),
          status: parsed.data.status,
        });
      }
    } catch {
      // Skip unreadable files silently — listDoks is best-effort.
    }
  }
  out.sort((a, b) => a.dok_id.localeCompare(b.dok_id));
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

function translatableToString(t: Translatable | undefined): string {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  // TermRef — show the term_id as a placeholder until lexicon resolution lands.
  return `{${t.term_ref}}`;
}

// ───────── commander wiring ─────────────────────────────────────────

export function registerShowCommand(program: Command, ctx: CliContext): void {
  program
    .command('show [dokId]')
    .description('Pretty-print a Dok by id, or list all Doks when no id is given')
    .option('-r, --root <dir>', 'Workspace root', process.cwd())
    .option('--json', 'Emit one terminal JSONL result envelope', false)
    .action(async (dokId: string | undefined, opts) => {
      const { default: chalk } = await import('chalk');
      const root = opts.root as string;
      const machine = opts.json === true;

      if (!dokId) {
        const list = await listDoks({ root });
        if (list.length === 0) {
          if (!machine) {
            console.log(
              `\n  ${chalk.yellow('No Doks found.')} Run \`doklo generate\` first.\n`,
            );
          }
          recordShowResult(program, list);
          return;
        }
        if (!machine) {
          console.log(`\n  ${chalk.cyan(`${list.length} Dok(s)`)}\n`);
          const idWidth = Math.max(...list.map((d) => d.dok_id.length));
          for (const d of list) {
            const dim = d.status === 'active' ? '' : chalk.dim(` [${d.status}]`);
            console.log(`    ${chalk.bold(d.dok_id.padEnd(idWidth))}  ${d.name}${dim}`);
          }
          console.log();
        }
        recordShowResult(program, list);
        return;
      }

      const dok = await loadDok({ root, dokId });
      if (!machine) {
        const staleness = await dokStaleness(root, dok);
        printDok(dok, chalk, staleness);
      }
      recordShowResult(program, dok);
      void ctx;
    });
}

function recordShowResult(owner: object, data: Dok | DokSummary[]): void {
  recordCommandResult(owner, {
    schema_version: 1,
    command: 'show',
    status: 'success',
    data,
    diagnostics: [],
  });
}

// Pretty terminal renderer.
export function printDok(
  dok: Dok,
  chalk: typeof import('chalk').default,
  staleness: StaleResult,
): void {
  const w = (label: string, value: string): string =>
    `${chalk.dim(label)} ${value}`;

  console.log();
  console.log(`  ${chalk.bold(chalk.cyan(dok.dok_id))}  ${chalk.bold(translatableToString(dok.name))}`);
  console.log(
    `  ${w('status', dok.status)}  ${w('tags', dok.tags.join(', ') || chalk.dim('(none)'))}`,
  );
  console.log(
    `  ${w('freshness', formatFreshness(staleness, derivePriorityTier(dok.priority), chalk))}`,
  );
  if (dok.surfaces && dok.surfaces.length > 0) {
    console.log(`  ${w('surfaces', dok.surfaces.join(', '))}`);
  }
  console.log();
  if (dok.description) {
    console.log(`  ${wrap(translatableToString(dok.description), 78, '  ')}`);
    console.log();
  }

  // User actions
  const steps = dok.user_actions?.steps ?? [];
  console.log(`  ${chalk.bold(`User actions (${steps.length})`)}`);
  for (const s of steps) {
    const actor = formatActor(s.actor, chalk);
    const variants = s.variants
      .map((v) => `${v.platform}:${v.interaction}`)
      .join(', ');
    console.log(
      `    ${chalk.dim(String(s.order).padStart(2))}. ${actor}  ${chalk.dim('→')} ${translatableToString(s.intent)}`,
    );
    console.log(
      `        ${chalk.dim('outcome')} ${translatableToString(s.outcome)}`,
    );
    if (variants) console.log(`        ${chalk.dim('via    ')} ${variants}`);
  }
  console.log();

  // Business rules
  const rules = dok.business_rules?.rules ?? [];
  console.log(`  ${chalk.bold(`Business rules (${rules.length})`)}`);
  if (rules.length === 0) console.log(`    ${chalk.dim('(none)')}`);
  for (const r of rules) {
    console.log(
      `    ${chalk.cyan(r.id)}  ${chalk.dim(`[${r.type}]`)} ${translatableToString(r.description)}`,
    );
  }
  console.log();

  // Acceptance criteria
  const criteria = dok.acceptance_criteria?.criteria ?? [];
  console.log(`  ${chalk.bold(`Acceptance criteria (${criteria.length})`)}`);
  if (criteria.length === 0) console.log(`    ${chalk.dim('(none)')}`);
  for (const c of criteria) {
    const refs = c.related_rules.length > 0
      ? chalk.dim(` ↳ ${c.related_rules.join(', ')}`)
      : '';
    console.log(`    ${chalk.cyan(c.id)}  ${translatableToString(c.statement)}${refs}`);
  }
  console.log();
}

// Freshness (drift) one-liner — drift-spec §4.5.
//
// The icon alone invites the wrong reading — that 🟢 fresh means "this doc is
// correct". It does not: drift only compares the bytes of the tracked source
// files against what they were at generation time. Each state therefore carries
// a dim clause spelling out what it does and does not claim, and (when stale or
// untracked) what to do next.
function formatFreshness(
  staleness: StaleResult,
  tier: PriorityTier,
  chalk: typeof import('chalk').default,
): string {
  // no-hash: nothing was recorded to compare against, so drift is undecidable —
  // never flagged as stale, shown dim to distinguish it from a verified 🟢 fresh.
  if (staleness.reason === 'no-hash') {
    return chalk.dim('– unknown (no logic hash — regenerate to start drift tracking)');
  }
  if (staleness.reason === 'unverified-tracking') {
    return chalk.dim('– unknown (source tracking unverified — scan and regenerate to verify dependencies)');
  }
  if (staleness.stale) {
    // The tier rides along because the reader's next question after "did this
    // drift" is "how much does it cost me to be wrong here".
    const head = tier === 'critical'
      ? chalk.red(`✗ stale (${staleness.reason}) · critical`)
      : chalk.yellow(`⚠ stale (${staleness.reason}) · ${tier}`);
    return (
      head +
      chalk.dim(
        staleness.reason === 'tracking-expanded'
          ? ' — recovered source tracking needs review; trust the code over this doc, or run `doklo sync`'
          : ' — tracked sources changed since generation; trust the code over this doc, or run `doklo sync`',
      )
    );
  }
  return (
    '🟢 fresh' +
    chalk.dim(
      ' — tracked sources unchanged since generation (not a proof the doc is correct)',
    )
  );
}

function formatActor(
  actor: Actor,
  chalk: typeof import('chalk').default,
): string {
  if (actor.kind === 'role') return chalk.magenta(actor.role_ref);
  if (actor.kind === 'system') return chalk.green('SYSTEM');
  return chalk.yellow(`EXT(${actor.label})`);
}

// Soft-wrap a string to width chars, preserving Unicode (Korean) widths
// approximately by treating them as 2-wide. Pure ASCII would just use length.
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let line = '';
  let lineW = 0;
  for (const tok of words) {
    const tokW = visualWidth(tok);
    if (lineW + tokW > width && line.trim().length > 0) {
      lines.push(line.trimEnd());
      line = '';
      lineW = 0;
    }
    line += tok;
    lineW += tokW;
  }
  if (line.length > 0) lines.push(line.trimEnd());
  return lines.join('\n' + indent);
}

function visualWidth(s: string): number {
  // Treat CJK + emoji as 2-wide, everything else as 1.
  let n = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0x9fff) || // CJK
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      n += 2;
    } else {
      n += 1;
    }
  }
  return n;
}
