import { describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import {
  buildSourceGroundedPrompt,
  runSourceGroundedScore,
  type GroundingCase,
} from '../src/index.js';

const DOK = {
  dok_id: 'ADMIN-DATA',
  name: 'Account administration',
  description: 'Admins manage accounts.',
  _meta: {
    version: 1,
    history: [],
    source_anchors: [{ file: 'app/admin/page.tsx' }],
  },
} as unknown as Dok;

const CASE: GroundingCase = {
  dok: DOK,
  sources: [{
    file: 'app/admin/page.tsx',
    sha256: 'a'.repeat(64),
    content: 'export function AdminPage() { return <p>List accounts</p>; }',
  }],
};

describe('source-grounded semantic evaluation', () => {
  it('includes full Dok JSON, source paths, hashes, and source text in the prompt', () => {
    const prompt = buildSourceGroundedPrompt(CASE);
    expect(prompt.systemPrompt).toContain('supplied source files');
    expect(prompt.userPrompt).toContain('ADMIN-DATA');
    expect(prompt.userPrompt).toContain('app/admin/page.tsx');
    expect(prompt.userPrompt).toContain('a'.repeat(64));
    expect(prompt.userPrompt).toContain('List accounts');
  });

  it('records one deterministic critical hallucination from the judge', async () => {
    const report = await runSourceGroundedScore([CASE], async () => JSON.stringify({
      axes: {
        task_relevance: 90,
        specificity: 85,
        completeness: 80,
        actionability: 85,
      },
      factual_errors: [{
        severity: 'critical',
        claim_path: 'rules[0].description',
        claim: 'Admins can delete every account',
        evidence_files: ['app/admin/page.tsx'],
        reason: 'No delete operation exists in the supplied source',
      }],
      flags: [],
    }));

    expect(report.criticalFactualErrors).toBe(1);
    expect(report.results[0]?.factualErrors[0]?.claimPath).toBe('rules[0].description');
    expect(report.results[0]?.sourceHashes[0]?.sha256).toBe('a'.repeat(64));
  });

  it('fails closed for malformed judge output instead of returning a zero-error result', async () => {
    const report = await runSourceGroundedScore([CASE], async () => '{not-json');
    expect(report.results).toHaveLength(0);
    expect(report.infrastructureFailures.some((failure) => failure.includes('ADMIN-DATA'))).toBe(true);
    expect(report.criticalFactualErrors).toBe(0);
  });

  it('rejects a run cost cap before invoking the judge', async () => {
    let called = false;
    const report = await runSourceGroundedScore([CASE], async () => {
      called = true;
      return '{}';
    }, { actualUsd: 5.01 });
    expect(called).toBe(false);
    expect(report.infrastructureFailures).toContain('QUALITY_COST_ABOVE_5:5.01');
  });

  it('promotes unsupported destructive claims to critical regardless of judge severity', async () => {
    const report = await runSourceGroundedScore([CASE], async () => JSON.stringify({
      axes: { task_relevance: 80, specificity: 80, completeness: 80, actionability: 80 },
      factual_errors: [{
        severity: 'major',
        claim_path: 'rules[0]',
        claim: 'The endpoint permanently deletes every account',
        evidence_files: ['app/admin/page.tsx'],
        reason: 'Unsupported destructive action; no delete operation is shown in the source',
      }],
      flags: [],
    }));
    expect(report.criticalFactualErrors).toBe(1);
    expect(report.results[0]?.factualErrors[0]?.severity).toBe('critical');
  });

  it('promotes sensitive or destructive claims even without an unsupported marker', async () => {
    const report = await runSourceGroundedScore([CASE], async () => JSON.stringify({
      axes: { task_relevance: 80, specificity: 80, completeness: 80, actionability: 80 },
      factual_errors: [{
        severity: 'minor',
        claim_path: 'rules[0]',
        claim: 'Admins can delete every account',
        evidence_files: ['app/admin/page.tsx'],
        reason: 'The claim is not a documented product behavior.',
      }],
      flags: [],
    }));
    expect(report.criticalFactualErrors).toBe(1);
    expect(report.results[0]?.factualErrors[0]?.severity).toBe('critical');
  });
});
