import type { GroundingCase } from './grounded-types.js';
import type { JudgePrompt } from './prompt.js';

export interface GroundedJudgePrompt extends JudgePrompt {
  /** Short aliases retained for callers using the standalone grounded contract. */
  system: string;
  user: string;
}

const GROUNDED_SYSTEM = [
  'Judge only against the supplied source files; do not infer behavior that is not shown.',
  'An unsupported security, authorization, persistence, destructive-action, or external-side-effect claim is a critical factual error.',
  'Score task_relevance, specificity, completeness, and actionability from 0 to 100.',
  'For every factual error include severity, claim_path, claim, evidence_files, and reason.',
  'Return JSON only with {"axes":{"task_relevance":0,"specificity":0,"completeness":0,"actionability":0},"factual_errors":[],"flags":[]}.',
].join(' ');

/** Build a complete, source-grounded judge request. No source text is truncated. */
export function buildSourceGroundedPrompt(input: GroundingCase): GroundedJudgePrompt {
  const userPrompt = JSON.stringify({
    dok: input.dok,
    sources: input.sources.map((source) => ({
      file: source.file,
      sha256: source.sha256,
      content: source.content,
    })),
  });
  return {
    systemPrompt: GROUNDED_SYSTEM,
    userPrompt,
    system: GROUNDED_SYSTEM,
    user: userPrompt,
  };
}

export { GROUNDED_SYSTEM };
