import { buildSourceGroundedPrompt } from './grounded-prompt.js';
import { parseGroundedVerdict } from './grounded-parse.js';
import {
  GROUNDED_MAX_SOURCE_CHARS,
  GROUNDED_MODEL,
  type GroundedJudgeFn,
  type GroundedSemanticReport,
  type GroundingCase,
} from './grounded-types.js';

/** Run one isolated judge call per Dok and never turn infrastructure errors into a clean score. */
export async function runSourceGroundedScore(
  cases: readonly GroundingCase[],
  judge: GroundedJudgeFn,
  options?: { actualUsd?: number },
): Promise<GroundedSemanticReport> {
  const results: GroundedSemanticReport['results'] = [];
  const infrastructureFailures: string[] = [];
  const actualUsd = options?.actualUsd ?? 0;
  if (actualUsd > 5) {
    return {
      schema_version: 1,
      model: GROUNDED_MODEL,
      judgeModel: GROUNDED_MODEL,
      results,
      averageScore: 0,
      criticalFactualErrors: 0,
      infrastructureFailures: [`QUALITY_COST_ABOVE_5:${actualUsd}`],
      actualUsd,
    };
  }

  for (const item of cases) {
    const dokId = item.dok.dok_id;
    try {
      const sourceChars = item.sources.reduce((sum, source) => sum + source.content.length, 0);
      if (sourceChars > GROUNDED_MAX_SOURCE_CHARS) {
        throw new Error(`GROUNDING_SOURCE_LIMIT: ${sourceChars} > ${GROUNDED_MAX_SOURCE_CHARS}`);
      }
      const prompt = buildSourceGroundedPrompt(item);
      const response = await judge({ ...prompt, label: `grounded-semantic-${dokId}` });
      const content = typeof response === 'string'
        ? response
        : response.success && response.content !== null
          ? response.content
          : null;
      if (content === null) throw new Error('judge call failed');
      const verdict = parseGroundedVerdict(content);
      results.push({
        dokId,
        total: verdict.total,
        axes: [
          { axis: 'business_clarity', score: Math.round(verdict.axes.task_relevance / 4), reason: 'grounded task relevance' },
          { axis: 'internal_consistency', score: Math.round(verdict.axes.specificity / 4), reason: 'grounded specificity' },
          { axis: 'ac_verifiability', score: Math.round(verdict.axes.completeness / 4), reason: 'grounded completeness' },
          { axis: 'coherence', score: Math.round(verdict.axes.actionability / 4), reason: 'grounded actionability' },
        ],
        flags: verdict.flags,
        factualErrors: verdict.factualErrors,
        sourceHashes: item.sources.map(({ file, sha256 }) => ({ file, sha256 })),
      });
    } catch (error) {
      infrastructureFailures.push(`${dokId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const averageScore = results.length === 0
    ? 0
    : Math.round(results.reduce((sum, result) => sum + result.total, 0) / results.length);
  const criticalFactualErrors = results.reduce(
    (sum, result) => sum + result.factualErrors.filter((error) => error.severity === 'critical').length,
    0,
  );
  return {
    schema_version: 1,
    model: GROUNDED_MODEL,
    judgeModel: GROUNDED_MODEL,
    results,
    averageScore,
    criticalFactualErrors,
    infrastructureFailures,
    actualUsd,
  };
}
