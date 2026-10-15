// Strict parser for the sync judge's answer (judge-gated sync design §4.4 rule
// 1), copied from the benchmark harness (benchmarks/judge-sync/src/parse.ts).
// Only one complete JSON object of the exact shape is accepted — no fences, no
// extra keys, no missing keys. Anything else is a parse failure, which the
// post-rules turn into `uncertain` (pattern: the grounded judge's parser in
// packages/evaluator, which also refuses partial answers).
import { z } from 'zod';

export const SyncJudgeVerdictSchema = z.enum(['accurate', 'needs_update', 'uncertain']);
export type SyncJudgeVerdict = z.infer<typeof SyncJudgeVerdictSchema>;

export const SyncJudgeErrorSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor']),
  claim_path: z.string().min(1),
  claim: z.string(),
  evidence_files: z.array(z.string()),
  reason: z.string(),
  scope: z.enum(['this_change', 'pre_existing']),
}).strict();

export const SyncJudgeOmissionSchema = z.object({
  what: z.string().min(1),
  evidence_files: z.array(z.string()),
  reason: z.string(),
}).strict();

export const SyncJudgeCheckedSchema = z.object({
  claim_path: z.string().min(1),
  evidence_files: z.array(z.string()),
  reason: z.string(),
}).strict();

export const SyncJudgeResponseSchema = z.object({
  verdict: SyncJudgeVerdictSchema,
  errors: z.array(SyncJudgeErrorSchema),
  omissions: z.array(SyncJudgeOmissionSchema),
  checked: z.array(SyncJudgeCheckedSchema),
  summary: z.string(),
}).strict();

export type SyncJudgeResponse = z.infer<typeof SyncJudgeResponseSchema>;
export type SyncJudgeError = SyncJudgeResponse['errors'][number];
export type SyncJudgeOmission = SyncJudgeResponse['omissions'][number];
export type SyncJudgeChecked = SyncJudgeResponse['checked'][number];

export type ParseOutcome =
  | { ok: true; value: SyncJudgeResponse }
  | { ok: false; error: string };

export function parseSyncJudgeResponse(content: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content.trim()) as unknown;
  } catch (error) {
    return { ok: false, error: `malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = SyncJudgeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `shape: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '<root>'} ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, value: parsed.data };
}
