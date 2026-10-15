// The sync judge's local cache (judge-gated sync design §4.7):
// `.doklo/cache/judge/<DOK-ID>.json`, one record per Dok the judge called
// accurate. It is the only place a verdict lives — never in the Dok file, never
// in history, never over MCP (design principles 2 and 5) — and it lets a later
// `doklo sync --judge` reuse the verdict instead of paying again, while
// `doklo sync --check` and `doklo show` say the Dok is "stale, judged accurate
// (unconfirmed)". The cache is not committed (only the hub is).
//
// A record holds for exactly the code, the base and the text the judge read:
// the raw logic hash of the tracked files read now, the Dok's `source_commit`
// and the hash of the Dok body. Any of the three moving voids it. A run that
// would reuse it also requires the same prompt digest and a byte-identical
// request. No wall-clock field: the record is a fact about its inputs.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  DokIdSchema,
  DokSchema,
  computeLogicHash,
  readAnchorContentsSync,
  type Dok,
} from '@doklo-beta/core';
import { resolveContainedOutputPath } from '@doklo-beta/generator';
import { writeTextFileAtomic } from '../atomic-file.js';
import { SyncJudgeCheckedSchema, SyncJudgeErrorSchema, SyncJudgeOmissionSchema } from './parse.js';

export const JUDGE_CACHE_DIR = '.doklo/cache/judge';
export const JUDGE_CACHE_SCHEMA_VERSION = 1;

/** Workspace-relative path of one Dok's cached verdict. */
export function judgeCacheFile(dokId: string): string {
  return `${JUDGE_CACHE_DIR}/${dokId}.json`;
}

export const JudgeCacheRecordSchema = z.object({
  schema_version: z.literal(JUDGE_CACHE_SCHEMA_VERSION),
  dok_id: z.string(),
  /** Raw logic hash of the tracked files the judge read (`computeLogicHash`). */
  logic_hash: z.string().min(1),
  /** The Dok's `_meta.source_commit` — the diff base the judge read against. */
  source_commit: z.string().min(1),
  /** sha256 of the Dok body the judge read (`dokBodySha256`). */
  dok_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  verdict: z.literal('accurate'),
  errors: z.array(SyncJudgeErrorSchema),
  omissions: z.array(SyncJudgeOmissionSchema),
  checked: z.array(SyncJudgeCheckedSchema),
  summary: z.string(),
  /** The model that gave the verdict, e.g. `anthropic/claude-sonnet-5`. */
  model: z.string().min(1),
  /** `SYNC_JUDGE_PROMPT_DIGEST` of the prompt the judge answered. */
  prompt_digest: z.string().min(1),
  /** sha256 of the exact prompt sent (system + user). */
  request_digest: z.string().min(1),
}).strict();

export type JudgeCacheRecord = z.infer<typeof JudgeCacheRecordSchema>;

/** What a cached verdict must still match to hold. */
export interface JudgeCacheFacts {
  dokId: string;
  logicHash: string;
  sourceCommit: string;
  dokSha256: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * sha256 of the Dok body — everything but `_meta` — as `DokSchema` parses it,
 * so a raw file and a parsed Dok hash alike. A person editing the Dok's text
 * (or its status) after the verdict moves it; a re-stamped hash or a new
 * history entry does not.
 */
export function dokBodySha256(dok: Dok | Record<string, unknown>): string {
  const parsed = DokSchema.parse(dok) as unknown as Record<string, unknown>;
  const { _meta: _dropped, ...body } = parsed;
  return createHash('sha256').update(stableStringify(body), 'utf8').digest('hex');
}

/** Whether a cached record still holds for these facts. */
export function judgeCacheMatches(record: JudgeCacheRecord, facts: JudgeCacheFacts): boolean {
  return record.dok_id === facts.dokId
    && record.logic_hash === facts.logicHash
    && record.source_commit === facts.sourceCommit
    && record.dok_sha256 === facts.dokSha256;
}

/**
 * The facts a cached verdict is checked against, read now: the raw logic hash
 * of the Dok's tracked files (the drift read), its `source_commit`, its body
 * hash. Null when the Dok has no `source_commit` or a tracked file cannot be
 * read — no verdict can hold then.
 */
export function currentJudgeCacheFacts(dok: Dok, projectRoot: string): JudgeCacheFacts | null {
  const sourceCommit = dok._meta?.source_commit;
  if (sourceCommit === undefined) return null;
  const files = (dok._meta?.logic_files ?? dok._meta?.source_anchors ?? []).map((anchor) => anchor.file);
  if (files.length === 0) return null;
  const read = readAnchorContentsSync(files, projectRoot);
  if (read.missing.length > 0) return null;
  let dokSha256: string;
  try {
    dokSha256 = dokBodySha256(dok);
  } catch {
    return null; // Not a valid Dok: no verdict can hold for it.
  }
  return {
    dokId: dok.dok_id,
    logicHash: computeLogicHash(read.contents),
    sourceCommit,
    dokSha256,
  };
}

/** The cached record for a Dok, or null when there is none or it is unreadable or malformed. */
export async function readJudgeCache(root: string, dokId: string): Promise<JudgeCacheRecord | null> {
  if (!DokIdSchema.safeParse(dokId).success) return null;
  let raw: string;
  try {
    const path = await resolveContainedOutputPath(root, judgeCacheFile(dokId));
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JudgeCacheRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.dok_id === dokId ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The verdict a person has yet to confirm: the Dok's cached `accurate` record,
 * when it still holds for the code, base and text as they are now. What
 * `doklo sync --check` and `doklo show` print as "stale, judged accurate
 * (unconfirmed)". `projectRoot` is the Dok's (`dokProjectRoot`).
 */
export async function readCurrentJudgeVerdict(
  root: string,
  dok: Dok,
  projectRoot: string,
): Promise<JudgeCacheRecord | null> {
  const record = await readJudgeCache(root, dok.dok_id);
  if (record === null) return null;
  const facts = currentJudgeCacheFacts(dok, projectRoot);
  return facts !== null && judgeCacheMatches(record, facts) ? record : null;
}

/** Write one Dok's verdict (atomic, contained under the workspace root). */
export async function writeJudgeCache(root: string, record: JudgeCacheRecord): Promise<void> {
  const valid = JudgeCacheRecordSchema.parse(record);
  if (!DokIdSchema.safeParse(valid.dok_id).success) {
    throw new TypeError(`Invalid Dok id for the judge cache: ${valid.dok_id}`);
  }
  const path = await resolveContainedOutputPath(root, judgeCacheFile(valid.dok_id));
  await mkdir(dirname(path), { recursive: true });
  await writeTextFileAtomic(path, `${JSON.stringify(valid, null, 2)}\n`);
}

/** Drop one Dok's cached verdict, if any. */
export async function removeJudgeCache(root: string, dokId: string): Promise<void> {
  if (!DokIdSchema.safeParse(dokId).success) return;
  const path = await resolveContainedOutputPath(root, judgeCacheFile(dokId));
  await rm(path, { force: true });
}
