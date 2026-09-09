import { z } from 'zod';
import type { FactualError } from './grounded-types.js';

const AxisSchema = z.object({
  task_relevance: z.number().finite().min(0).max(100),
  specificity: z.number().finite().min(0).max(100),
  completeness: z.number().finite().min(0).max(100),
  actionability: z.number().finite().min(0).max(100),
}).strict();

const ErrorSchema = z.object({
  severity: z.enum(['critical', 'major', 'minor']),
  claim_path: z.string().min(1),
  claim: z.string(),
  evidence_files: z.array(z.string()),
  reason: z.string(),
}).strict();

const VerdictSchema = z.object({
  axes: AxisSchema,
  factual_errors: z.array(ErrorSchema).default([]),
  flags: z.array(z.string()).default([]),
}).strict();

export interface ParsedGroundedVerdict {
  axes: z.infer<typeof AxisSchema>;
  factualErrors: FactualError[];
  flags: string[];
  total: number;
}

/** Parse only a complete JSON object; fenced/partial responses are rejected. */
export function parseGroundedVerdict(content: string): ParsedGroundedVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(content.trim()) as unknown;
  } catch (error) {
    throw new Error(`malformed grounded judge JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = VerdictSchema.parse(raw);
  const total = Math.round(
    (parsed.axes.task_relevance + parsed.axes.specificity + parsed.axes.completeness + parsed.axes.actionability) / 4,
  );
  return {
    axes: parsed.axes,
    factualErrors: parsed.factual_errors.map((error) => ({
      severity: classifyFactualSeverity(error.severity, error.claim, error.reason),
      claimPath: error.claim_path,
      claim: error.claim,
      evidenceFiles: error.evidence_files,
      reason: error.reason,
    })),
    flags: parsed.flags,
    total,
  };
}

function classifyFactualSeverity(
  severity: FactualError['severity'],
  claim: string,
  reason: string,
): FactualError['severity'] {
  if (severity === 'critical') return severity;
  const text = `${claim} ${reason}`;
  const sensitiveClaim = /security|auth(?:entication|orization)|permission|persist(?:ence|ent)?|database|destructive|delete|external side[- ]effect|payment|email|send(?:ing)?/iu.test(text);
  return sensitiveClaim ? 'critical' : severity;
}
