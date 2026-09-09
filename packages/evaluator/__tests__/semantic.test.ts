import { describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import {
  buildSemanticJudgePrompt,
  parseJudgeVerdict,
  runSemanticScore,
  SEMANTIC_AXES,
  type JudgeFn,
} from '../src/index.js';

const FAKE_DOK = {
  dok_id: 'TEST-FLOW',
  name: '테스트 기능',
  description: '테스트용 Dok',
} as unknown as Dok;

const VALID_VERDICT = JSON.stringify({
  axes: [
    { axis: 'business_clarity', score: 20, reason: 'clear' },
    { axis: 'internal_consistency', score: 21, reason: 'ok' },
    { axis: 'ac_verifiability', score: 18, reason: 'ok' },
    { axis: 'coherence', score: 22, reason: 'ok' },
  ],
  flags: ['AC-2 vague'],
});

describe('buildSemanticJudgePrompt', () => {
  it('embeds the dok JSON and names all four axes', () => {
    const p = buildSemanticJudgePrompt(FAKE_DOK);
    expect(p.userPrompt).toContain('"dok_id": "TEST-FLOW"');
    for (const axis of SEMANTIC_AXES) expect(p.systemPrompt).toContain(axis);
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a clean JSON verdict', () => {
    const v = parseJudgeVerdict(VALID_VERDICT, SEMANTIC_AXES, 25);
    expect(v.axes).toHaveLength(4);
    expect(v.flags).toEqual(['AC-2 vague']);
  });
  it('parses JSON wrapped in a markdown fence', () => {
    const v = parseJudgeVerdict('```json\n' + VALID_VERDICT + '\n```', SEMANTIC_AXES, 25);
    expect(v.axes[0].score).toBe(20);
  });
  it('rejects out-of-range scores', () => {
    // JSON.stringify produces compact JSON without spaces, so replace the compact form
    const bad = VALID_VERDICT.replace('"score":20', '"score":26');
    expect(() => parseJudgeVerdict(bad, SEMANTIC_AXES, 25)).toThrow(/out of range/);
  });
  it('rejects content with no JSON object', () => {
    expect(() => parseJudgeVerdict('sorry, I cannot', SEMANTIC_AXES, 25)).toThrow(/no JSON/);
  });
});

describe('runSemanticScore', () => {
  it('aggregates per-dok totals and averages', async () => {
    const judge: JudgeFn = async () => ({ success: true, content: VALID_VERDICT });
    const report = await runSemanticScore([FAKE_DOK, { ...FAKE_DOK, dok_id: 'TEST-OTHER' } as unknown as Dok], judge);
    expect(report.judged).toBe(2);
    expect(report.results[0].total).toBe(81); // 20+21+18+22
    expect(report.average).toBe(81);
    expect(report.failures).toHaveLength(0);
  });
  it('collects judge failures without aborting the run', async () => {
    let n = 0;
    const judge: JudgeFn = async () => (++n === 1 ? { success: false, content: null } : { success: true, content: VALID_VERDICT });
    const report = await runSemanticScore([FAKE_DOK, { ...FAKE_DOK, dok_id: 'TEST-OTHER' } as unknown as Dok], judge);
    expect(report.judged).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].dokId).toBe('TEST-FLOW');
  });
});
