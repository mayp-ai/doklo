import {
  GROUNDED_MODEL,
  type GeneratorQualityEvidence,
  type ReleaseQualityGateResult,
  type ReleaseQualityThresholds,
} from './grounded-types.js';

export const FIXED_PUBLIC_REPO_URL = 'https://github.com/vercel/nextjs-postgres-auth-starter.git';
export const FIXED_PUBLIC_COMMIT = 'fde8ecf1da9337223081f70cf88b420060039d6e';
export const FIXED_GOLDEN_RELATIVE_PATH = 'packages/adapter-nextjs/__tests__/fixtures/app-router-golden';
export const GOLDEN_PROJECT_ID = 'golden';
export const PUBLIC_PROJECT_ID = 'public';

/**
 * Evidence records a canonical file URL whose path ends in the fixed fixture
 * segments. The command binds this URL only after resolving the exact
 * repo-relative path with core containment checks; arbitrary file URLs fail.
 */
export function isFixedGoldenRepoUrl(repoUrl: string): boolean {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== 'file:' || parsed.hostname !== '' || parsed.search || parsed.hash) return false;
    const segments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean);
    const expected = FIXED_GOLDEN_RELATIVE_PATH.split('/');
    return segments.length >= expected.length
      && segments.slice(-expected.length).every((segment, index) => segment === expected[index]);
  } catch {
    return false;
  }
}

export const DEFAULT_RELEASE_THRESHOLDS: ReleaseQualityThresholds = {
  averageMin: 80,
  perDokMin: 70,
  criticalMax: 0,
  maxUsdPerRun: 5,
  maxUsdTotal: 20,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function evaluateReleaseQuality(
  evidence: GeneratorQualityEvidence,
  thresholds: ReleaseQualityThresholds = DEFAULT_RELEASE_THRESHOLDS,
): ReleaseQualityGateResult {
  const violations: string[] = [];
  const rawProjects = (evidence as unknown as { projects?: unknown }).projects;
  const projects = Array.isArray(rawProjects) ? rawProjects.filter(isRecord) : [];
  let runCostTotal = 0;
  if (evidence.schema_version !== 1) violations.push('SCHEMA_VERSION_MISMATCH');
  if (evidence.model !== GROUNDED_MODEL || evidence.judgeModel !== GROUNDED_MODEL) violations.push('MODEL_MISMATCH');
  if (evidence.maxUsdPerRun !== thresholds.maxUsdPerRun) violations.push('RUN_CAP_MISMATCH');
  if (evidence.maxUsdTotal !== thresholds.maxUsdTotal) violations.push('TOTAL_CAP_MISMATCH');
  if (!Number.isFinite(evidence.totalActualUsd) || evidence.totalActualUsd < 0) violations.push('QUALITY_COST_INVALID');
  if (!Array.isArray(rawProjects) || rawProjects.length !== 2) violations.push('EXPECTED_TWO_PROJECTS');
  if (Array.isArray(rawProjects) && rawProjects.some((project) => !isRecord(project))) {
    violations.push('PROJECT_INVALID');
  }

  const golden = projects.filter((project) => project.kind === 'golden');
  const publicProjects = projects.filter((project) => project.kind === 'public');
  if (golden.length !== 1) violations.push('EXPECTED_ONE_GOLDEN_PROJECT');
  if (publicProjects.length !== 1) violations.push('EXPECTED_ONE_PUBLIC_PROJECT');
  if (golden[0] && golden[0].id !== GOLDEN_PROJECT_ID) violations.push('GOLDEN_PROJECT_ID_MISMATCH');
  if (golden[0] && (typeof golden[0].repoUrl !== 'string' || !isFixedGoldenRepoUrl(golden[0].repoUrl) || golden[0].commitSha !== 'golden-fixture')) {
    violations.push('GOLDEN_INPUT_MISMATCH');
  }
  const publicProject = publicProjects[0];
  if (publicProject && publicProject.id !== PUBLIC_PROJECT_ID) violations.push('PUBLIC_PROJECT_ID_MISMATCH');
  if (publicProject && publicProject.repoUrl !== FIXED_PUBLIC_REPO_URL) violations.push('PUBLIC_REPO_MISMATCH');
  if (publicProject && publicProject.commitSha !== FIXED_PUBLIC_COMMIT) violations.push('PUBLIC_COMMIT_MISMATCH');

  for (const project of projects) {
    const rawRuns = project.runs;
    if (!Array.isArray(rawRuns) || rawRuns.length !== 2) {
      violations.push(`EXPECTED_TWO_RUNS:${project.id}`);
    }
    if (!Array.isArray(rawRuns)) continue;
    for (const [index, run] of rawRuns.entries()) {
      const runLabel = `${project.id}:${index + 1}`;
      if (!isRecord(run)) {
        violations.push(`RUN_INVALID:${runLabel}`);
        continue;
      }
      if (run.model !== GROUNDED_MODEL || run.judgeModel !== GROUNDED_MODEL) violations.push(`MODEL_MISMATCH:${runLabel}`);
      const actualUsd = run.actualUsd;
      if (typeof actualUsd !== 'number' || !Number.isFinite(actualUsd) || actualUsd < 0) violations.push(`RUN_COST_INVALID:${runLabel}`);
      else runCostTotal += actualUsd;
      const averageScore = run.averageScore;
      if (typeof averageScore !== 'number' || !Number.isFinite(averageScore) || averageScore < 0 || averageScore > 100) {
        violations.push(`RUN_SCORE_INVALID:${runLabel}`);
      }
      const criticalFactualErrors = run.criticalFactualErrors;
      if (typeof criticalFactualErrors !== 'number' || !Number.isFinite(criticalFactualErrors) || criticalFactualErrors < 0) {
        violations.push(`CRITICAL_COUNT_INVALID:${runLabel}`);
      }
      const rawResults = run.results;
      if (!Array.isArray(rawResults)) {
        violations.push(`RESULTS_INVALID:${runLabel}`);
        continue;
      }
      if (rawResults.length === 0) violations.push(`NO_DOK_RESULTS:${runLabel}`);
      let resultTotal = 0;
      let resultCritical = 0;
      if (typeof actualUsd === 'number' && actualUsd > thresholds.maxUsdPerRun) violations.push(`RUN_COST_ABOVE_5:${runLabel}`);
      if (typeof averageScore === 'number' && averageScore < thresholds.averageMin) violations.push(`AVERAGE_BELOW_80:${runLabel}`);
      if (rawResults.some((result) => !isRecord(result) || typeof result.total !== 'number' || result.total < thresholds.perDokMin)) {
        violations.push(`DOK_BELOW_70:${runLabel}`);
      }
      if (typeof criticalFactualErrors === 'number' && criticalFactualErrors > thresholds.criticalMax) violations.push(`CRITICAL_FACTUAL_ERROR:${runLabel}`);
      if (!Array.isArray(run.infrastructureFailures) || run.infrastructureFailures.length !== 0) {
        violations.push(`INFRASTRUCTURE_FAILURE:${runLabel}`);
      }
      for (const result of rawResults) {
        if (!isRecord(result)) {
          violations.push(`DOK_RESULT_INVALID:${runLabel}`);
          continue;
        }
        if (!Array.isArray(result.sourceHashes) || result.sourceHashes.length === 0) {
          violations.push(`SOURCE_EVIDENCE_MISSING:${runLabel}`);
        }
        if (typeof result.total !== 'number' || !Number.isFinite(result.total) || result.total < 0 || result.total > 100) {
          violations.push(`DOK_SCORE_INVALID:${runLabel}`);
        } else {
          resultTotal += result.total;
        }
        if (Array.isArray(result.factualErrors)) {
          resultCritical += result.factualErrors.filter((error) => isRecord(error) && error.severity === 'critical').length;
        }
      }
      if (rawResults.length > 0 && typeof averageScore === 'number' && Number.isFinite(averageScore)
        && averageScore !== Math.round(resultTotal / rawResults.length)) {
        violations.push(`AVERAGE_AGGREGATE_MISMATCH:${runLabel}`);
      }
      if (typeof criticalFactualErrors === 'number' && Number.isFinite(criticalFactualErrors)
        && criticalFactualErrors !== resultCritical) {
        violations.push(`CRITICAL_AGGREGATE_MISMATCH:${runLabel}`);
      }
    }
  }
  if (Number.isFinite(evidence.totalActualUsd) && Math.abs(runCostTotal - evidence.totalActualUsd) > 1e-9) {
    violations.push('QUALITY_COST_TOTAL_MISMATCH');
  }
  if (evidence.totalActualUsd > thresholds.maxUsdTotal) violations.push('QUALITY_COST_ABOVE_20');

  return {
    schema_version: 1,
    status: violations.length === 0 ? 'pass' : 'fail',
    thresholds,
    violations,
  };
}
