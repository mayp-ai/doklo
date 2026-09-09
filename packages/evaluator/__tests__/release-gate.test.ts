import { describe, expect, it } from 'vitest';
import { evaluateReleaseQuality, isFixedGoldenRepoUrl, type GeneratorQualityEvidence } from '../src/index.js';

const report = {
  schema_version: 1 as const,
  model: 'anthropic/claude-sonnet-5' as const,
  judgeModel: 'anthropic/claude-sonnet-5' as const,
  results: [{
    dokId: 'ADMIN-DATA',
    total: 82,
    axes: [],
    flags: [],
    factualErrors: [],
    sourceHashes: [{ file: 'app/page.tsx', sha256: 'a'.repeat(64) }],
  }],
  averageScore: 82,
  criticalFactualErrors: 0,
  infrastructureFailures: [],
  actualUsd: 4,
};

const passingEvidence: GeneratorQualityEvidence = {
  schema_version: 1,
  model: 'anthropic/claude-sonnet-5',
  judgeModel: 'anthropic/claude-sonnet-5',
  maxUsdPerRun: 5,
  maxUsdTotal: 20,
  totalActualUsd: 16,
  projects: [
    { kind: 'golden', id: 'golden', repoUrl: 'file:///repo/packages/adapter-nextjs/__tests__/fixtures/app-router-golden', commitSha: 'golden-fixture', runs: [report, report] },
    { kind: 'public', id: 'public', repoUrl: 'https://github.com/vercel/nextjs-postgres-auth-starter.git', commitSha: 'fde8ecf1da9337223081f70cf88b420060039d6e', runs: [report, report] },
  ],
};

describe('release quality gate', () => {
  it('requires exact golden fixture path segments in file URLs', () => {
    expect(isFixedGoldenRepoUrl('file:///repo/packages/adapter-nextjs/__tests__/fixtures/app-router-golden')).toBe(true);
    expect(isFixedGoldenRepoUrl('file:///repo/evilapp-router-golden')).toBe(false);
    expect(isFixedGoldenRepoUrl('file:///repo/packages/adapter-nextjs/__tests__/fixtures/app-router-golden?forged=1')).toBe(false);
  });

  it('passes the exact 2×2 fixed-input evidence set', () => {
    expect(evaluateReleaseQuality(passingEvidence)).toEqual({
      schema_version: 1,
      status: 'pass',
      thresholds: {
        averageMin: 80,
        perDokMin: 70,
        criticalMax: 0,
        maxUsdPerRun: 5,
        maxUsdTotal: 20,
      },
      violations: [],
    });
  });

  it('rejects project/run cardinality, fixed model/SHA, costs, and quality thresholds', () => {
    const bad = {
      ...passingEvidence,
      model: 'openai/gpt-5.5',
      totalActualUsd: 20.01,
      projects: [{
        ...passingEvidence.projects[0]!,
        repoUrl: 'https://evil.example/repo.git',
        commitSha: 'c'.repeat(40),
        runs: [{ ...report, model: 'openai/gpt-5.5', actualUsd: 5.01, averageScore: 79, criticalFactualErrors: 1, infrastructureFailures: ['judge'] }],
      }],
    } as unknown as GeneratorQualityEvidence;
    const result = evaluateReleaseQuality(bad);
    expect(result.status).toBe('fail');
    expect(result.violations).toEqual(expect.arrayContaining([
      'EXPECTED_TWO_PROJECTS',
      'MODEL_MISMATCH',
      'QUALITY_COST_ABOVE_20',
      'EXPECTED_TWO_RUNS:golden',
      'RUN_COST_ABOVE_5:golden:1',
      'AVERAGE_BELOW_80:golden:1',
      'CRITICAL_FACTUAL_ERROR:golden:1',
      'INFRASTRUCTURE_FAILURE:golden:1',
    ]));
  });

  it('fails closed on non-finite scores and mismatched aggregate cost', () => {
    const malformed = {
      ...passingEvidence,
      totalActualUsd: 0,
      projects: passingEvidence.projects.map((project) => ({
        ...project,
        runs: project.runs.map((run) => ({
          ...run,
          averageScore: Number.NaN,
        })) as [typeof report, typeof report],
      })) as GeneratorQualityEvidence['projects'],
    };
    const result = evaluateReleaseQuality(malformed);
    expect(result.status).toBe('fail');
    expect(result.violations).toEqual(expect.arrayContaining([
      'RUN_SCORE_INVALID:golden:1',
      'RUN_SCORE_INVALID:public:2',
      'QUALITY_COST_TOTAL_MISMATCH',
    ]));
  });

  it('returns violations instead of throwing for null project/run/result shapes', () => {
    expect(() => evaluateReleaseQuality({
      ...passingEvidence,
      projects: [null, { ...passingEvidence.projects[1]!, runs: [null, null] }],
    } as unknown as GeneratorQualityEvidence)).not.toThrow();
    const result = evaluateReleaseQuality({
      ...passingEvidence,
      projects: [null, { ...passingEvidence.projects[1]!, runs: [null, null] }],
    } as unknown as GeneratorQualityEvidence);
    expect(result.status).toBe('fail');
    expect(result.violations).toContain('PROJECT_INVALID');
  });
});
