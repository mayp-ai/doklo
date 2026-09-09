// @doklo-beta/evaluator — golden quality gate + regression scoring.
//
// Two runners, one criterion catalogue:
//   - runViolations()  → EvalReport (interactive golden authoring)
//   - runScore()       → ScoreReport (5-category, 500-point regression)
//
// applyAutoFixes() walks the catalogue and applies safe automatic fixes.

export const EVALUATOR_VERSION = '0.1.0';

export type {
  Criterion,
  CriterionCategory,
  CriterionResult,
  CriterionTier,
  EvalInput,
  EvalPatch,
  EvalReport,
  ConsolidationHints,
  Severity,
  Violation,
} from './types.js';

export {
  ALL_CRITERIA,
  uniqueDokId,
  dokIdFormat,
  businessRuleIdFormat,
  enumValidity,
  requiredFieldsPresent,
  userActionsMin,
} from './criteria/index.js';

export { runViolations } from './runners/violations.js';
export {
  runScore,
  type CategoryName,
  type CategoryScore,
  type ScoreReport,
} from './runners/score.js';

export {
  applyAutoFixes,
  type AutoFixOptions,
  type AutoFixResult,
} from './auto-fixers/index.js';

export {
  SEMANTIC_AXES,
  type DokSemanticResult,
  type JudgeFn,
  type JudgeRequest,
  type JudgeResponse,
  type SemanticAxis,
  type SemanticAxisScore,
  type SemanticReport,
} from './semantic/types.js';
export { buildSemanticJudgePrompt, SEMANTIC_JUDGE_SYSTEM, type JudgePrompt } from './semantic/prompt.js';
export { parseJudgeVerdict, type GenericAxisScore, type ParsedVerdict } from './semantic/parse.js';
export { runSemanticScore } from './semantic/runner.js';

export {
  GROUNDED_MODEL,
  GROUNDED_MAX_SOURCE_CHARS,
  type GroundingSource,
  type GroundingCase,
  type FactualError,
  type GroundedDokResult,
  type GroundedSemanticReport,
  type GeneratorQualityEvidence,
  type ReleaseQualityThresholds,
  type ReleaseQualityGateResult,
  type GroundedJudgeFn,
} from './semantic/grounded-types.js';
export { buildSourceGroundedPrompt, GROUNDED_SYSTEM, type GroundedJudgePrompt } from './semantic/grounded-prompt.js';
export { parseGroundedVerdict, type ParsedGroundedVerdict } from './semantic/grounded-parse.js';
export { runSourceGroundedScore } from './semantic/grounded-runner.js';
export {
  DEFAULT_RELEASE_THRESHOLDS,
  FIXED_GOLDEN_RELATIVE_PATH,
  FIXED_PUBLIC_REPO_URL,
  FIXED_PUBLIC_COMMIT,
  GOLDEN_PROJECT_ID,
  PUBLIC_PROJECT_ID,
  isFixedGoldenRepoUrl,
  evaluateReleaseQuality,
} from './semantic/release-gate.js';
