// Runner: runSemanticScore — per-Dok judge calls with failure isolation.

import type { Dok } from '@doklo-beta/core';
import { buildSemanticJudgePrompt } from './prompt.js';
import { parseJudgeVerdict } from './parse.js';
import {
  SEMANTIC_AXES,
  type DokSemanticResult,
  type JudgeFn,
  type SemanticAxis,
  type SemanticReport,
} from './types.js';

export async function runSemanticScore(doks: Dok[], judge: JudgeFn): Promise<SemanticReport> {
  const results: DokSemanticResult[] = [];
  const failures: Array<{ dokId: string; error: string }> = [];

  for (const dok of doks) {
    const dokId = (dok as { dok_id?: string }).dok_id ?? '(unknown)';
    try {
      const prompt = buildSemanticJudgePrompt(dok);
      const res = await judge({ ...prompt, label: `semantic-${dokId}` });
      if (!res.success || res.content == null) throw new Error('judge call failed');
      const verdict = parseJudgeVerdict(res.content, SEMANTIC_AXES, 25);
      results.push({
        dokId,
        total: verdict.axes.reduce((sum, a) => sum + a.score, 0),
        axes: verdict.axes.map((a) => ({ ...a, axis: a.axis as SemanticAxis })),
        flags: verdict.flags,
      });
    } catch (err) {
      failures.push({ dokId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const average = results.length
    ? Math.round(results.reduce((sum, r) => sum + r.total, 0) / results.length)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    totalDoks: doks.length,
    judged: results.length,
    average,
    results,
    failures,
  };
}
