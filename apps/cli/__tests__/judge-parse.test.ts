// The sync judge's strict parser and post-rules (design §4.4), with the cases
// ported from the benchmark harness (benchmarks/judge-sync/__tests__/parse.test.ts,
// post-rules.test.ts).
import { describe, expect, it } from 'vitest';
import { parseSyncJudgeResponse, type SyncJudgeResponse } from '../src/lib/judge/parse.js';
import { applyPostRules } from '../src/lib/judge/post-rules.js';
import { judgedDokOf, judgeProposalsOf } from '../src/lib/judge/judge.js';
import { formatJudgeVerdict } from '../src/commands/sync.js';
import { createI18n } from '../src/lib/i18n.js';

const valid = {
  verdict: 'needs_update',
  errors: [{
    severity: 'major',
    claim_path: 'business_rules.rules[1].description',
    claim: 'default expiry is 7 days',
    evidence_files: ['app/admin/share-token/page.tsx'],
    reason: 'the diff sets 14 days',
    scope: 'this_change',
  }],
  omissions: [],
  checked: [],
  summary: 'The default expiry is now 14 days.',
};

describe('strict sync-judge parser', () => {
  it('accepts exactly the contract shape', () => {
    const out = parseSyncJudgeResponse(JSON.stringify(valid));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.errors[0]!.scope).toBe('this_change');
  });

  it('accepts surrounding whitespace only', () => {
    expect(parseSyncJudgeResponse(`\n  ${JSON.stringify(valid)}\n`).ok).toBe(true);
  });

  const rejected: Array<[string, string]> = [
    ['Markdown fences', '```json\n' + JSON.stringify(valid) + '\n```'],
    ['text before the object', `Here is my verdict: ${JSON.stringify(valid)}`],
    ['truncated JSON', JSON.stringify(valid).slice(0, -10)],
    ['an unknown verdict', JSON.stringify({ ...valid, verdict: 'mostly_fine' })],
    ['an extra top-level key', JSON.stringify({ ...valid, confidence: 0.9 })],
    ['a missing key (checked)', JSON.stringify({ verdict: 'accurate', errors: [], omissions: [], summary: 'x' })],
    ['an error without scope', JSON.stringify({ ...valid, errors: [{ ...valid.errors[0], scope: undefined }] })],
    ['an error with an unknown scope', JSON.stringify({ ...valid, errors: [{ ...valid.errors[0], scope: 'both' }] })],
    ['an omission with an extra key', JSON.stringify({ ...valid, omissions: [{ what: 'x', evidence_files: [], reason: 'y', severity: 'major' }] })],
    ['evidence_files as a string', JSON.stringify({ ...valid, errors: [{ ...valid.errors[0], evidence_files: 'a.ts' }] })],
    ['an array instead of an object', JSON.stringify([valid])],
  ];
  for (const [name, content] of rejected) {
    it(`rejects ${name}`, () => {
      expect(parseSyncJudgeResponse(content).ok).toBe(false);
    });
  }
});

const CHANGED = ['app/admin/share-token/page.tsx'];
const SENT = ['app/admin/share-token/page.tsx', 'components/admin/Other.tsx'];

function judge(response: SyncJudgeResponse) {
  return applyPostRules({ outcome: parseSyncJudgeResponse(JSON.stringify(response)), sentFiles: SENT, changedFiles: CHANGED });
}

const accurate: SyncJudgeResponse = {
  verdict: 'accurate',
  errors: [],
  omissions: [],
  checked: [{ claim_path: 'business_rules.rules[0].description', evidence_files: ['app/admin/share-token/page.tsx'], reason: 'languages unchanged' }],
  summary: 'Only a comment changed.',
};

describe('post-rules (design §4.4)', () => {
  it('an evidenced "accurate" keeps the Dok', () => {
    expect(judge(accurate)).toMatchObject({ raw_verdict: 'accurate', effective_verdict: 'accurate', decision: 'keep', rules_applied: [] });
  });

  it('R0: a failed or skipped call is uncertain → regenerate', () => {
    expect(applyPostRules({ outcome: null, failure: 'call_failed:timeout', sentFiles: SENT, changedFiles: CHANGED }))
      .toMatchObject({ raw_verdict: null, effective_verdict: 'uncertain', decision: 'regenerate', rules_applied: ['R0_FAILURE'] });
    expect(applyPostRules({ outcome: null, sentFiles: SENT, changedFiles: CHANGED }).rules_applied).toEqual(['R0_FAILURE']);
  });

  it('R1: an unparseable response is uncertain → regenerate', () => {
    const out = applyPostRules({ outcome: parseSyncJudgeResponse('```json\n{}\n```'), sentFiles: SENT, changedFiles: CHANGED });
    expect(out).toMatchObject({ effective_verdict: 'uncertain', decision: 'regenerate', rules_applied: ['R1_SHAPE'] });
  });

  it('R2: evidence outside the files sent → uncertain, even for "accurate"', () => {
    const out = judge({ ...accurate, checked: [{ claim_path: 'x', evidence_files: ['lib/never-sent.ts'], reason: 'r' }] });
    expect(out).toMatchObject({ effective_verdict: 'uncertain', decision: 'regenerate', rules_applied: ['R2_EVIDENCE_OUTSIDE_SENT'], evidence_outside_sent: ['lib/never-sent.ts'] });
    const needs = judge({ ...accurate, verdict: 'needs_update', omissions: [{ what: 'w', evidence_files: ['.env.local'], reason: 'r' }] });
    expect(needs.effective_verdict).toBe('uncertain');
  });

  it('R2: a bare file name for a sent path is outside the files sent', () => {
    const out = judge({ ...accurate, checked: [{ claim_path: 'x', evidence_files: ['page.tsx'], reason: 'r' }] });
    expect(out).toMatchObject({ effective_verdict: 'uncertain', rules_applied: ['R2_EVIDENCE_OUTSIDE_SENT'] });
  });

  it('R3: "accurate" that lists a wrong claim or an omission → needs_update', () => {
    const withError = judge({
      ...accurate,
      errors: [{ severity: 'minor', claim_path: 'description', claim: 'c', evidence_files: CHANGED, reason: 'r', scope: 'this_change' }],
    });
    expect(withError).toMatchObject({ effective_verdict: 'needs_update', decision: 'regenerate', rules_applied: ['R3_ACCURATE_WITH_FINDINGS'] });
    const withOmission = judge({ ...accurate, omissions: [{ what: 'new role', evidence_files: CHANGED, reason: 'r' }] });
    expect(withOmission.effective_verdict).toBe('needs_update');
  });

  it('R4: "accurate" without one evidenced "checked" item → uncertain', () => {
    expect(judge({ ...accurate, checked: [] })).toMatchObject({ effective_verdict: 'uncertain', rules_applied: ['R4_ACCURATE_WITHOUT_EVIDENCE'] });
    expect(judge({ ...accurate, checked: [{ claim_path: 'x', evidence_files: [], reason: 'r' }] }).effective_verdict).toBe('uncertain');
  });

  it('"needs_update" and "uncertain" always regenerate', () => {
    expect(judge({ ...accurate, verdict: 'needs_update', checked: [] }).decision).toBe('regenerate');
    expect(judge({ ...accurate, verdict: 'uncertain', checked: [] }).decision).toBe('regenerate');
  });

  it('records the model scope and the mechanical scope separately and counts disagreements', () => {
    const out = judge({
      verdict: 'needs_update',
      errors: [
        { severity: 'major', claim_path: 'a', claim: 'c', evidence_files: CHANGED, reason: 'r', scope: 'this_change' },
        { severity: 'minor', claim_path: 'b', claim: 'c', evidence_files: ['components/admin/Other.tsx'], reason: 'r', scope: 'pre_existing' },
        { severity: 'minor', claim_path: 'c', claim: 'c', evidence_files: ['components/admin/Other.tsx'], reason: 'r', scope: 'this_change' },
      ],
      omissions: [],
      checked: [],
      summary: 's',
    });
    expect(out.errors.map((e) => e.mechanical_scope)).toEqual(['this_change', 'pre_existing', 'pre_existing']);
    expect(out.tallies).toMatchObject({
      errors_this_change: 2,
      errors_pre_existing: 1,
      errors_mechanical_this_change: 1,
      errors_mechanical_pre_existing: 2,
      scope_disagreements: 1,
    });
  });

  it('upgrades display severity like the grounded parser, without touching the verdict', () => {
    const out = judge({
      ...accurate,
      verdict: 'needs_update',
      checked: [],
      errors: [{ severity: 'minor', claim_path: 'a', claim: 'only admins can delete tokens', evidence_files: CHANGED, reason: 'permission check moved', scope: 'this_change' }],
    });
    expect(out.errors[0]).toMatchObject({ severity: 'minor', display_severity: 'critical' });
    expect(out.effective_verdict).toBe('needs_update');
  });
});

describe('verdicts as sync reports them', () => {
  it('names why a verdict is not the judge’s own word', () => {
    const r3 = judge({ ...accurate, omissions: [{ what: 'new role', evidence_files: CHANGED, reason: 'r' }] });
    expect(judgedDokOf('AUTH', 'anthropic/claude-sonnet-5', r3)).toEqual({
      dokId: 'AUTH',
      verdict: 'needs_update',
      cached: false,
      model: 'anthropic/claude-sonnet-5',
      summary: 'Only a comment changed.',
      reason: 'accurate_with_findings',
    });
    const r0 = applyPostRules({ outcome: null, failure: 'ai_sdk_error: boom', sentFiles: SENT, changedFiles: CHANGED });
    expect(judgedDokOf('AUTH', 'm', r0)).toEqual({ dokId: 'AUTH', verdict: 'uncertain', cached: false, model: 'm', reason: 'call_failed' });
    expect(judgedDokOf('AUTH', 'm', judge(accurate))).not.toHaveProperty('reason');
  });

  it('only the judge’s own needs_update sentence becomes a proposal', () => {
    const own = judgedDokOf('OWN', 'm', judge({ ...accurate, verdict: 'needs_update', checked: [], summary: '  Say 14 days.  ' }));
    const r3 = judgedDokOf('RTHREE', 'm', judge({ ...accurate, omissions: [{ what: 'w', evidence_files: CHANGED, reason: 'r' }] }));
    const silent = judgedDokOf('SILENT', 'm', judge({ ...accurate, verdict: 'needs_update', checked: [], summary: ' ' }));
    const unsure = judgedDokOf('UNSURE', 'm', judge({ ...accurate, verdict: 'uncertain', checked: [] }));
    const kept = judgedDokOf('KEPT', 'm', judge(accurate));
    expect(judgeProposalsOf([own, r3, silent, unsure, kept, { ...own, dokId: 'CACHED', cached: true }])).toEqual({ OWN: 'Say 14 days.' });
  });

  it('prints one line per verdict, with the reason in place of a sentence the post-rules overrode', () => {
    const t = createI18n('en');
    const r3 = judgedDokOf('AUTH', 'anthropic/claude-sonnet-5', judge({ ...accurate, omissions: [{ what: 'w', evidence_files: CHANGED, reason: 'r' }] }));
    expect(formatJudgeVerdict(r3, t)).toBe('↻ AUTH — needs an update (anthropic/claude-sonnet-5): it called the Dok accurate but listed a problem');
    const outside = judgedDokOf('AUTH', 'm', judge({ ...accurate, checked: [{ claim_path: 'x', evidence_files: ['page.tsx'], reason: 'r' }] }));
    expect(formatJudgeVerdict(outside, t)).toBe('? AUTH — the judge could not decide (m): it cited a file it was not given');
    expect(formatJudgeVerdict({ dokId: 'AUTH', verdict: 'uncertain', cached: false, model: 'm' }, createI18n('ko')))
      .toBe('? AUTH — 판사가 정하지 못함 (m): —');
  });
});
