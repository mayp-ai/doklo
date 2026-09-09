import type { Dok } from '@doklo-beta/core';
import type {
  DokSemanticResult,
  JudgeFn,
  JudgeRequest,
  JudgeResponse,
} from './types.js';

export const GROUNDED_MODEL = 'anthropic/claude-sonnet-5' as const;
export const GROUNDED_MAX_SOURCE_CHARS = 240_000;

export interface GroundingSource {
  file: string;
  sha256: string;
  content: string;
}

export interface GroundingCase {
  dok: Dok;
  sources: GroundingSource[];
}

export interface FactualError {
  severity: 'critical' | 'major' | 'minor';
  claimPath: string;
  claim: string;
  evidenceFiles: string[];
  reason: string;
}

export interface GroundedDokResult extends DokSemanticResult {
  factualErrors: FactualError[];
  sourceHashes: Array<{ file: string; sha256: string }>;
}

export interface GroundedSemanticReport {
  schema_version: 1;
  model: typeof GROUNDED_MODEL;
  judgeModel: typeof GROUNDED_MODEL;
  results: GroundedDokResult[];
  averageScore: number;
  criticalFactualErrors: number;
  infrastructureFailures: string[];
  actualUsd: number;
}

export interface GeneratorQualityEvidence {
  schema_version: 1;
  model: typeof GROUNDED_MODEL;
  judgeModel: typeof GROUNDED_MODEL;
  maxUsdPerRun: 5;
  maxUsdTotal: 20;
  totalActualUsd: number;
  projects: Array<{
    kind: 'golden' | 'public';
    id: string;
    repoUrl: string;
    commitSha: string;
    runs: [GroundedSemanticReport, GroundedSemanticReport];
  }>;
}

export interface ReleaseQualityThresholds {
  averageMin: 80;
  perDokMin: 70;
  criticalMax: 0;
  maxUsdPerRun: 5;
  maxUsdTotal: 20;
}

export interface ReleaseQualityGateResult {
  schema_version: 1;
  status: 'pass' | 'fail';
  thresholds: ReleaseQualityThresholds;
  violations: string[];
}

/** Grounded judges may use the evaluator's response envelope or return JSON directly. */
export type GroundedJudgeFn = (request: JudgeRequest) => Promise<JudgeResponse | string>;

export type { JudgeFn };
