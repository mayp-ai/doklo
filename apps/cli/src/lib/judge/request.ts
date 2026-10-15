// The sync judge's request (judge-gated sync design §4.3), copied from the
// benchmark harness (benchmarks/judge-sync/src/request.ts, dok-render.ts,
// git.ts) and fitted to the CLI. Pure given its seams (git show, git diff,
// anchor reads, the sensitive-path filter), so the budget order and the
// diff-base fallback are unit-testable, and two builds over the same inputs
// are byte-identical: no clock, no randomness, fixed ordering everywhere.
//
// What the judge receives, filling a 240,000-character budget in this order:
//  1. the Dok without `_meta`, Lexicon references resolved to plain text the
//     way the MCP server resolves them;
//  2. the logic files whose per-file sha256 differs from the stored one, as a
//     `git diff <source_commit> -- <file>` against the working tree when the
//     base is verified (the base blob hashes to the stored sha256), else the
//     file's whole current content; a file that changed in form only
//     (comments, whitespace, line endings) is left out;
//  3. the anchors — `source_anchors` line ranges when present, else the whole
//     file — in stored order, stopping at the first file that does not fit;
//     every anchor left out is named to the judge.
// Dok + diff alone over the budget → no call (`over_budget`). Every path sent
// passes the CLI's sensitive-path filter; a file it refuses is named, never
// sent.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  computeLogicHash,
  computeSourceFileSha256,
  readAnchorContentsSync,
  resolveTranslatable,
  type AnchorRead,
  type Dok,
  type SourceAnchor,
  type Translatable,
  type TranslateContext,
} from '@doklo-beta/core';
import { joinPromptParts } from '@doklo-beta/generator';
import { isFormatOnlyFileChange } from '../drift.js';
import { isSensitiveLlmPath } from '../llm-preflight.js';
import { dokBodySha256 } from './cache.js';
import {
  SYNC_JUDGE_PROMPT_DIGEST,
  SYNC_JUDGE_SYSTEM,
  answerLanguageFor,
  type AnswerLanguage,
} from './prompt.js';

/**
 * Characters per judge call: Dok + diff (or whole changed files) + anchors.
 * The grounded judge's source cap (`GROUNDED_MAX_SOURCE_CHARS`), as the design
 * and the benchmark used it.
 */
export const JUDGE_INPUT_BUDGET_CHARS = 240_000;

/** A full object id (SHA-1 or SHA-256 repositories) — the only diff base accepted. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type ShownAs = 'diff' | 'full' | 'withheld';
export type DiffBaseCheck = 'verified' | 'hash-mismatch' | 'missing-at-base' | 'undecodable';
/**
 * Why no call is made:
 *  - `no_facts`    — no `source_commit` or a logic file without its `sha256`;
 *  - `unreadable`  — a tracked file could not be read now;
 *  - `no_diff`     — nothing left to show (every changed file changed in form
 *                    only, or is withheld);
 *  - `over_budget` — the Dok and the changes alone exceed the budget.
 */
export type JudgeRequestSkip = 'no_facts' | 'unreadable' | 'no_diff' | 'over_budget';

export interface JudgePayload {
  answer_language: AnswerLanguage;
  dok: Record<string, unknown>;
  diff_base: string;
  changed_files: Array<{ path: string; shown_as: ShownAs }>;
  diff: string | null;
  full_files: Array<{ path: string; content: string }>;
  anchors: Array<{ path: string; lines: string | null; content: string }>;
  omitted_anchors: string[];
  withheld_files: string[];
}

export interface JudgeRequestSeams {
  /** The bytes of `git show <rev>:./<file>`, or null when the blob does not exist or git fails. */
  gitShow: (rev: string, file: string) => Promise<Buffer | null>;
  /** `git diff <rev> -- <file>` against the working tree, or null when git fails. */
  gitDiff: (rev: string, file: string) => Promise<string | null>;
  /** Current content of anchor files, read like drift verification; null = unreadable. */
  readFiles: (files: readonly string[]) => Map<string, string | null>;
  isSensitive: (file: string) => boolean;
}

export interface JudgeRequestInput {
  dok: Dok;
  /** The drift read of the Dok's tracked files (`readAnchorContentsSync`). */
  read: AnchorRead;
  /** Lexicon context for resolving TermRefs (MCP's: locale = primary = default_locale). */
  translate: TranslateContext;
  /** The workspace `default_locale`; names the answer language. */
  locale: string;
  budgetChars?: number;
}

export interface JudgeRequestSections {
  dokChars: number;
  diffChars: number;
  fullChars: number;
  anchorChars: number;
  totalChars: number;
  budgetChars: number;
}

/** Characters of one source file a call transmits (diff chunk + whole content + anchor excerpts). */
export interface JudgeTransmission {
  file: string;
  chars: number;
}

export type AnchorNote = 'duplicate' | 'already-full' | 'unreadable' | 'withheld' | 'budget';

export interface BuiltJudgeRequest {
  dokId: string;
  status: 'ready' | 'skip';
  skipReason?: JudgeRequestSkip;
  promptDigest: string;
  systemPrompt: string;
  /** `JSON.stringify(payload)`; '' when skipped. */
  userPrompt: string;
  /** `joinPromptParts({ systemPrompt, userPrompt })` — what consent digests; '' when skipped. */
  prompt: string;
  /** sha256 of `prompt`; '' when skipped. */
  requestDigest: string;
  payload: JudgePayload | null;
  sections: JudgeRequestSections;
  /** Changed files shown to the judge (diff or full), sorted. */
  changedFiles: string[];
  /** Changed files left out because they changed in form only, sorted. */
  formatOnlyFiles: string[];
  diffBaseChecks: Array<{ file: string; check: DiffBaseCheck }>;
  diffSource: 'git' | 'full_content' | 'mixed' | 'none';
  anchorsSent: string[];
  omittedAnchors: string[];
  withheld: string[];
  anchorNotes: Array<{ file: string; note: AnchorNote }>;
  /** The evidence whitelist: changed files shown (diff or full) ∪ anchors sent, sorted. */
  sentFiles: string[];
  /** Per-file characters sent, sorted by file — the consent plan's transmissions. */
  transmissions: JudgeTransmission[];
  /** Cache key facts: the raw logic hash of the files read now, and the Dok body's hash. */
  logicHash: string;
  dokSha256: string;
}

const UTF8 = (): TextDecoder => new TextDecoder('utf-8', { fatal: true });

/**
 * Whether a Dok carries the facts a diff needs (design §4.3): a full commit id
 * in `_meta.source_commit` and a `sha256` on every `_meta.logic_files` entry.
 * Doks generated before judge-gated sync have neither and are regenerated
 * without the judge.
 */
export function hasJudgeFacts(dok: Dok): boolean {
  const meta = dok._meta;
  const base = meta?.source_commit;
  const files = meta?.logic_files ?? [];
  return typeof base === 'string'
    && COMMIT_ID.test(base)
    && files.length > 0
    && files.every((entry) => typeof entry.sha256 === 'string' && entry.sha256.length > 0);
}

// ───────── the Dok as the judge sees it ─────────────────────────────

function isTermRef(value: unknown): value is { term_ref: string } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { term_ref?: unknown }).term_ref === 'string';
}

function resolveDeep(value: unknown, ctx: TranslateContext): unknown {
  if (isTermRef(value)) return resolveTranslatable(value as Translatable, ctx);
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, ctx));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveDeep(item, ctx);
    return out;
  }
  return value;
}

/**
 * The Dok body without `_meta` (hashes and history are not evidence and only
 * spend tokens), every Lexicon reference resolved with the MCP server's
 * function and context. Actors are passed through as-is, as MCP's get_dok does.
 */
export function renderDokForJudge(dok: Dok, ctx: TranslateContext): Record<string, unknown> {
  const { _meta: _dropped, ...body } = dok as unknown as Record<string, unknown>;
  return resolveDeep(body, ctx) as Record<string, unknown>;
}

// ───────── anchors ───────────────────────────────────────────────────

interface AnchorUnit {
  file: string;
  /** Merged, sorted 1-based inclusive ranges; empty = the whole file. */
  ranges: Array<[number, number]>;
}

/**
 * Anchor files in first-appearance order. A file with any whole-file entry is
 * sent whole; otherwise its line ranges are merged (overlapping or adjacent)
 * and sent in ascending order. `start_line` without `end_line` names one line.
 */
function anchorUnits(anchors: readonly SourceAnchor[]): { units: AnchorUnit[]; duplicates: string[] } {
  const order: string[] = [];
  const whole = new Set<string>();
  const ranges = new Map<string, Array<[number, number]>>();
  const entries = new Map<string, number>();
  for (const anchor of anchors) {
    if (!entries.has(anchor.file)) order.push(anchor.file);
    entries.set(anchor.file, (entries.get(anchor.file) ?? 0) + 1);
    if (anchor.start_line === undefined) {
      whole.add(anchor.file);
      continue;
    }
    const end = Math.max(anchor.start_line, anchor.end_line ?? anchor.start_line);
    ranges.set(anchor.file, [...(ranges.get(anchor.file) ?? []), [anchor.start_line, end]]);
  }
  const duplicates = order.filter((file) => whole.has(file) && (entries.get(file) ?? 0) > 1);
  return {
    duplicates,
    units: order.map((file) => {
      if (whole.has(file)) return { file, ranges: [] };
      const sorted = [...(ranges.get(file) ?? [])].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged: Array<[number, number]> = [];
      for (const [start, end] of sorted) {
        const last = merged.at(-1);
        if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      return { file, ranges: merged };
    }),
  };
}

/** The excerpts one anchor unit sends: the whole file, or each range's lines. */
function anchorExcerpts(unit: AnchorUnit, content: string): Array<{ lines: string | null; content: string }> {
  if (unit.ranges.length === 0) return [{ lines: null, content }];
  const lines = content.split('\n');
  const out: Array<{ lines: string | null; content: string }> = [];
  for (const [start, end] of unit.ranges) {
    if (start > lines.length) continue;
    const last = Math.min(end, lines.length);
    out.push({ lines: `${start}-${last}`, content: lines.slice(start - 1, last).join('\n') });
  }
  return out;
}

// ───────── the builder ───────────────────────────────────────────────

function emptySections(budget: number): JudgeRequestSections {
  return { dokChars: 0, diffChars: 0, fullChars: 0, anchorChars: 0, totalChars: 0, budgetChars: budget };
}

export async function buildJudgeRequest(
  input: JudgeRequestInput,
  seams: JudgeRequestSeams,
): Promise<BuiltJudgeRequest> {
  const budget = input.budgetChars ?? JUDGE_INPUT_BUDGET_CHARS;
  const dokId = input.dok.dok_id;
  const logicHash = computeLogicHash(input.read.contents);
  const dokSha256 = dokBodySha256(input.dok);
  const skip = (reason: JudgeRequestSkip, extra: Partial<BuiltJudgeRequest> = {}): BuiltJudgeRequest => ({
    dokId,
    status: 'skip',
    skipReason: reason,
    promptDigest: SYNC_JUDGE_PROMPT_DIGEST,
    systemPrompt: SYNC_JUDGE_SYSTEM,
    userPrompt: '',
    prompt: '',
    requestDigest: '',
    payload: null,
    sections: emptySections(budget),
    changedFiles: [],
    formatOnlyFiles: [],
    diffBaseChecks: [],
    diffSource: 'none',
    anchorsSent: [],
    omittedAnchors: [],
    withheld: [],
    anchorNotes: [],
    sentFiles: [],
    transmissions: [],
    logicHash,
    dokSha256,
    ...extra,
  });

  if (!hasJudgeFacts(input.dok)) return skip('no_facts');
  if (input.read.missing.length > 0) return skip('unreadable');
  const base = input.dok._meta.source_commit!;
  const logicFiles = input.dok._meta.logic_files!;

  // ── Changed files: the per-file hash differs from the stored one.
  const current = new Map(input.read.contents.map((entry) => [entry.file, entry.content]));
  const stored = new Map(logicFiles.map((entry) => [entry.file, entry.sha256!]));
  const changed = [...new Set(logicFiles.map((entry) => entry.file))]
    .filter((file) => computeSourceFileSha256(current.get(file) ?? '') !== stored.get(file))
    .sort();

  const shownAs = new Map<string, ShownAs>();
  const withheld: string[] = [];
  const formatOnlyFiles: string[] = [];
  const diffBaseChecks: Array<{ file: string; check: DiffBaseCheck }> = [];
  const diffChunks: Array<{ file: string; text: string }> = [];
  const fullFiles: Array<{ path: string; content: string }> = [];
  for (const file of changed) {
    if (seams.isSensitive(file)) {
      shownAs.set(file, 'withheld');
      withheld.push(file);
      continue;
    }
    const now = current.get(file) ?? '';
    const bytes = await seams.gitShow(base, file);
    let check: DiffBaseCheck;
    let before: string | null = null;
    if (bytes === null) check = 'missing-at-base';
    else {
      try {
        // Decoded exactly as the drift read decodes (strict UTF-8, BOM dropped),
        // so the hash compares like with like.
        const decoded = UTF8().decode(bytes);
        before = decoded;
        check = computeSourceFileSha256(decoded) === stored.get(file) ? 'verified' : 'hash-mismatch';
      } catch {
        check = 'undecodable';
      }
    }
    diffBaseChecks.push({ file, check });
    if (check === 'verified' && before !== null && isFormatOnlyFileChange(file, before, now)) {
      formatOnlyFiles.push(file);
      continue;
    }
    const text = check === 'verified' ? await seams.gitDiff(base, file) : null;
    if (text !== null && text.length > 0) {
      shownAs.set(file, 'diff');
      diffChunks.push({ file, text });
    } else {
      shownAs.set(file, 'full');
      fullFiles.push({ path: file, content: now });
    }
  }
  const shown = changed.filter((file) => shownAs.get(file) === 'diff' || shownAs.get(file) === 'full');
  if (shown.length === 0) {
    return skip('no_diff', { formatOnlyFiles, diffBaseChecks, withheld });
  }
  const diff = diffChunks.length > 0 ? diffChunks.map((chunk) => chunk.text).join('') : null;
  const diffSource = diffChunks.length > 0 && fullFiles.length > 0
    ? 'mixed'
    : diffChunks.length > 0 ? 'git' : 'full_content';

  const dok = renderDokForJudge(input.dok, input.translate);
  const dokChars = JSON.stringify(dok).length;
  const diffChars = diff?.length ?? 0;
  const fullChars = fullFiles.reduce((sum, entry) => sum + entry.content.length, 0);
  const fixedChars = dokChars + diffChars + fullChars;
  if (fixedChars > budget) {
    return skip('over_budget', {
      changedFiles: shown,
      formatOnlyFiles,
      diffBaseChecks,
      diffSource,
      withheld,
      sections: { dokChars, diffChars, fullChars, anchorChars: 0, totalChars: fixedChars, budgetChars: budget },
    });
  }

  // ── Anchors, in stored order, within the remaining budget.
  const { units, duplicates } = anchorUnits(input.dok._meta.source_anchors ?? []);
  const anchorNotes: BuiltJudgeRequest['anchorNotes'] = duplicates.map((file) => ({ file, note: 'duplicate' }));
  const readable = seams.readFiles(units.map((unit) => unit.file).filter((file) => !seams.isSensitive(file)));
  const fullPaths = new Set(fullFiles.map((entry) => entry.path));
  let remaining = budget - fixedChars;
  let stopped = false;
  const anchors: JudgePayload['anchors'] = [];
  const anchorsSent: string[] = [];
  const omittedAnchors: string[] = [];
  for (const unit of units) {
    const file = unit.file;
    if (seams.isSensitive(file)) {
      anchorNotes.push({ file, note: 'withheld' });
      if (!withheld.includes(file)) withheld.push(file);
      continue;
    }
    if (fullPaths.has(file)) {
      anchorNotes.push({ file, note: 'already-full' });
      continue;
    }
    const content = readable.get(file) ?? null;
    const excerpts = content === null ? [] : anchorExcerpts(unit, content);
    if (excerpts.length === 0) {
      anchorNotes.push({ file, note: 'unreadable' });
      omittedAnchors.push(file);
      continue;
    }
    const unitChars = excerpts.reduce((sum, excerpt) => sum + excerpt.content.length, 0);
    if (!stopped && unitChars <= remaining) {
      for (const excerpt of excerpts) anchors.push({ path: file, lines: excerpt.lines, content: excerpt.content });
      anchorsSent.push(file);
      remaining -= unitChars;
      continue;
    }
    stopped = true;
    anchorNotes.push({ file, note: 'budget' });
    omittedAnchors.push(file);
  }
  const anchorChars = anchors.reduce((sum, anchor) => sum + anchor.content.length, 0);

  const payload: JudgePayload = {
    answer_language: answerLanguageFor(input.locale),
    dok,
    diff_base: base,
    changed_files: changed
      .filter((file) => shownAs.has(file))
      .map((path) => ({ path, shown_as: shownAs.get(path)! })),
    diff,
    full_files: fullFiles,
    anchors,
    omitted_anchors: omittedAnchors,
    withheld_files: [...new Set(withheld)].sort(),
  };
  const userPrompt = JSON.stringify(payload);
  const prompt = joinPromptParts({ systemPrompt: SYNC_JUDGE_SYSTEM, userPrompt });

  const chars = new Map<string, number>();
  const add = (file: string, n: number): void => { chars.set(file, (chars.get(file) ?? 0) + n); };
  for (const chunk of diffChunks) add(chunk.file, chunk.text.length);
  for (const entry of fullFiles) add(entry.path, entry.content.length);
  for (const anchor of anchors) add(anchor.path, anchor.content.length);
  const transmissions = [...chars.entries()]
    .map(([file, n]) => ({ file, chars: n }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    dokId,
    status: 'ready',
    promptDigest: SYNC_JUDGE_PROMPT_DIGEST,
    systemPrompt: SYNC_JUDGE_SYSTEM,
    userPrompt,
    prompt,
    requestDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    payload,
    sections: { dokChars, diffChars, fullChars, anchorChars, totalChars: fixedChars + anchorChars, budgetChars: budget },
    changedFiles: shown,
    formatOnlyFiles,
    diffBaseChecks,
    diffSource,
    anchorsSent,
    omittedAnchors,
    withheld: payload.withheld_files,
    anchorNotes,
    sentFiles: [...new Set([...shown, ...anchorsSent])].sort(),
    transmissions,
    logicHash,
    dokSha256,
  };
}

// ───────── git, as the judge reads it ────────────────────────────────

// Every call pins the options that would otherwise come from the user's git
// configuration (colour, pager, path quoting, diff prefixes, algorithm,
// renames, line-ending conversion, the fsmonitor hook), so the same tree
// always yields the same diff. `--no-optional-locks` keeps the reads from
// refreshing the index, `--no-ext-diff --no-textconv` from running any
// user-configured program, and `--relative` prints paths relative to the Dok's
// project root — the paths the judge must cite.
const PINNED_CONFIG = [
  'color.ui=false',
  'core.pager=cat',
  'core.quotepath=false',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.fsmonitor=false',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
  'diff.renames=false',
  'diff.algorithm=myers',
  'diff.indentHeuristic=true',
  'diff.interHunkContext=0',
].flatMap((entry) => ['-c', entry]);

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative', '-U3'] as const;
/** Bound on one git read; a hung git costs at most this, then the file is sent whole. */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
}

function runGit(projectRoot: string, args: readonly string[], encoding: 'buffer'): Promise<Buffer | null>;
function runGit(projectRoot: string, args: readonly string[], encoding: 'utf8'): Promise<string | null>;
function runGit(
  projectRoot: string,
  args: readonly string[],
  encoding: 'buffer' | 'utf8',
): Promise<Buffer | string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '--literal-pathspecs', '-C', projectRoot, ...PINNED_CONFIG, ...args],
      { env: gitEnv(), encoding, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : (stdout as Buffer | string)),
    );
  });
}

/** The production seams over the Dok's project root (`dokProjectRoot`). */
export function gitJudgeSeams(projectRoot: string): JudgeRequestSeams {
  return {
    gitShow: (rev, file) => runGit(projectRoot, ['show', `${rev}:./${file}`], 'buffer'),
    gitDiff: (rev, file) => runGit(projectRoot, ['diff', ...DIFF_FLAGS, rev, '--', file], 'utf8'),
    readFiles: (files) => {
      const read = readAnchorContentsSync([...files], projectRoot);
      const map = new Map<string, string | null>(files.map((file) => [file, null]));
      for (const entry of read.contents) map.set(entry.file, entry.content);
      return map;
    },
    isSensitive: isSensitiveLlmPath,
  };
}
