// Mechanical post-rules (judge-gated sync design §4.4), applied before any
// judge verdict counts. Copied from the benchmark harness
// (benchmarks/judge-sync/src/post-rules.ts):
//   R0 call failure / no answer                       → uncertain
//   R1 answer not exactly the contract shape          → uncertain
//   R2 an evidence file outside the files sent        → uncertain
//   R3 "accurate" but listing a wrong claim/omission  → needs_update
//   R4 "accurate" without one evidenced "checked"     → uncertain
// Decision: only an effective "accurate" keeps the Dok; uncertain and every
// failure regenerate (design principle 3: fail toward human review).
import type {
  ParseOutcome,
  SyncJudgeChecked,
  SyncJudgeError,
  SyncJudgeOmission,
  SyncJudgeVerdict,
} from './parse.js';

export type RuleId =
  | 'R0_FAILURE'
  | 'R1_SHAPE'
  | 'R2_EVIDENCE_OUTSIDE_SENT'
  | 'R3_ACCURATE_WITH_FINDINGS'
  | 'R4_ACCURATE_WITHOUT_EVIDENCE';

export interface JudgedError extends SyncJudgeError {
  /** Display severity after the grounded parser's upgrade rule (no effect on the verdict). */
  display_severity: SyncJudgeError['severity'];
  /** Mechanical scope (design §6): any evidence in a changed file ⇒ this_change, else pre_existing. */
  mechanical_scope: 'this_change' | 'pre_existing';
}

export interface EffectiveVerdict {
  raw_verdict: SyncJudgeVerdict | null;
  effective_verdict: SyncJudgeVerdict;
  decision: 'keep' | 'regenerate';
  rules_applied: RuleId[];
  failure: string | null;
  evidence_outside_sent: string[];
  errors: JudgedError[];
  omissions: SyncJudgeOmission[];
  checked: SyncJudgeChecked[];
  summary: string;
  tallies: {
    errors_this_change: number;
    errors_pre_existing: number;
    errors_mechanical_this_change: number;
    errors_mechanical_pre_existing: number;
    scope_disagreements: number;
    omissions: number;
    checked: number;
  };
}

/** Same upgrade rule as the grounded judge's parser in packages/evaluator (not exported there). */
export function classifyFactualSeverity(
  severity: SyncJudgeError['severity'],
  claim: string,
  reason: string,
): SyncJudgeError['severity'] {
  if (severity === 'critical') return severity;
  const text = `${claim} ${reason}`;
  const sensitiveClaim = /security|auth(?:entication|orization)|permission|persist(?:ence|ent)?|database|destructive|delete|external side[- ]effect|payment|email|send(?:ing)?/iu.test(text);
  return sensitiveClaim ? 'critical' : severity;
}

function emptyTallies(): EffectiveVerdict['tallies'] {
  return {
    errors_this_change: 0,
    errors_pre_existing: 0,
    errors_mechanical_this_change: 0,
    errors_mechanical_pre_existing: 0,
    scope_disagreements: 0,
    omissions: 0,
    checked: 0,
  };
}

export function applyPostRules(input: {
  outcome: ParseOutcome | null;
  failure?: string | null;
  sentFiles: readonly string[];
  changedFiles: readonly string[];
}): EffectiveVerdict {
  const failed = (rule: RuleId, failure: string, raw: SyncJudgeVerdict | null = null): EffectiveVerdict => ({
    raw_verdict: raw,
    effective_verdict: 'uncertain',
    decision: 'regenerate',
    rules_applied: [rule],
    failure,
    evidence_outside_sent: [],
    errors: [],
    omissions: [],
    checked: [],
    summary: '',
    tallies: emptyTallies(),
  });
  if (input.failure) return failed('R0_FAILURE', input.failure);
  if (input.outcome === null) return failed('R0_FAILURE', 'no response');
  if (!input.outcome.ok) return failed('R1_SHAPE', input.outcome.error);

  const response = input.outcome.value;
  const sent = new Set(input.sentFiles);
  const changed = new Set(input.changedFiles);
  const cited = [
    ...response.errors.flatMap((e) => e.evidence_files),
    ...response.omissions.flatMap((o) => o.evidence_files),
    ...response.checked.flatMap((c) => c.evidence_files),
  ];
  const outside = [...new Set(cited.filter((file) => !sent.has(file)))].sort();

  const errors: JudgedError[] = response.errors.map((e) => ({
    ...e,
    display_severity: classifyFactualSeverity(e.severity, e.claim, e.reason),
    mechanical_scope: e.evidence_files.some((file) => changed.has(file)) ? 'this_change' : 'pre_existing',
  }));
  const tallies = emptyTallies();
  for (const e of errors) {
    if (e.scope === 'this_change') tallies.errors_this_change += 1;
    else tallies.errors_pre_existing += 1;
    if (e.mechanical_scope === 'this_change') tallies.errors_mechanical_this_change += 1;
    else tallies.errors_mechanical_pre_existing += 1;
    if (e.scope !== e.mechanical_scope) tallies.scope_disagreements += 1;
  }
  tallies.omissions = response.omissions.length;
  tallies.checked = response.checked.length;

  const rules: RuleId[] = [];
  let effective: SyncJudgeVerdict = response.verdict;
  if (outside.length > 0) {
    rules.push('R2_EVIDENCE_OUTSIDE_SENT');
    effective = 'uncertain';
  } else if (response.verdict === 'accurate' && (response.errors.length > 0 || response.omissions.length > 0)) {
    rules.push('R3_ACCURATE_WITH_FINDINGS');
    effective = 'needs_update';
  } else if (response.verdict === 'accurate' && !response.checked.some((c) => c.evidence_files.length > 0)) {
    rules.push('R4_ACCURATE_WITHOUT_EVIDENCE');
    effective = 'uncertain';
  }
  return {
    raw_verdict: response.verdict,
    effective_verdict: effective,
    decision: effective === 'accurate' ? 'keep' : 'regenerate',
    rules_applied: rules,
    failure: null,
    evidence_outside_sent: outside,
    errors,
    omissions: response.omissions,
    checked: response.checked,
    summary: response.summary,
    tallies,
  };
}
