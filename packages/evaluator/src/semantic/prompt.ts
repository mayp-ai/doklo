// Prompt builder: Tier 3 semantic judge (whole-Dok JSON, zero schema coupling).

import type { Dok } from '@doklo-beta/core';

export interface JudgePrompt {
  systemPrompt: string;
  userPrompt: string;
}

export const SEMANTIC_JUDGE_SYSTEM = `You are a strict reviewer of business feature documents ("Dok").
Score the Dok on 4 axes, each an integer 0-25:
- business_clarity: a non-developer PM can understand name/description/steps without reading code.
- internal_consistency: steps, business rules, and acceptance criteria describe the same feature without contradiction.
- ac_verifiability: each acceptance criterion is concretely testable (no vague wording).
- coherence: name, description, and body describe one coherent feature at one altitude.

Also list "flags": short strings naming concrete defects (e.g. "AC-2 not testable").

Respond with JSON ONLY, no markdown fence, exactly this shape:
{"axes":[{"axis":"business_clarity","score":0,"reason":""},{"axis":"internal_consistency","score":0,"reason":""},{"axis":"ac_verifiability","score":0,"reason":""},{"axis":"coherence","score":0,"reason":""}],"flags":[]}`;

export function buildSemanticJudgePrompt(dok: Dok): JudgePrompt {
  return {
    systemPrompt: SEMANTIC_JUDGE_SYSTEM,
    userPrompt: `Dok to review:\n${JSON.stringify(dok, null, 2)}`,
  };
}
