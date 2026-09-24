import { describe, expect, it } from 'vitest';
import { WorkspaceSchema } from '../src/schemas/workspace.js';
import { DokMetaSchema, DokSchema } from '../src/schemas/dok.js';
import { findKoreanToneConflicts, recordDokWritingPolicy } from '../src/hub/writing-policy.js';

const base = { workspace_id: 'demo', name: 'Demo', services: [] };
describe('Korean customer writing policy', () => {
  it('preserves an explicit plain tone and rejects unsupported policies', () => {
    expect(WorkspaceSchema.parse({ ...base, korean_customer_tone: 'plain' })).toHaveProperty('korean_customer_tone', 'plain');
    expect(WorkspaceSchema.safeParse({ ...base, korean_customer_tone: 'casual' }).success).toBe(false);
  });

  it.each(['\n', '\r\n', '\r'])('checks unpunctuated sentences separated by %j', (boundary) => {
    expect(findKoreanToneConflicts(`메시지를 보낸다${boundary}답변을 확인합니다.`)).toEqual([
      { code: 'KOREAN_TONE_CONFLICT', expected_tone: 'formal', actual_tone: 'plain', excerpt: '메시지를 보낸다' },
    ]);
    expect(findKoreanToneConflicts(`메시지를 보냅니다${boundary}답변을 확인한다.`, 'plain')).toEqual([
      { code: 'KOREAN_TONE_CONFLICT', expected_tone: 'plain', actual_tone: 'formal', excerpt: '메시지를 보냅니다' },
    ]);
  });

  it('keeps multiline quoted labels outside the sentence policy', () => {
    expect(findKoreanToneConflicts('“메시지를 보낸다\n답변을 확인한다”라는 문구를 확인합니다.')).toEqual([]);
  });

  it('preserves a distinct policy acknowledgment and validates its policy and timestamp', () => {
    const acknowledgment = { locale: 'ko', tone: 'plain', acknowledged_at: '2026-09-25T03:00:00.000Z' };
    const review = (value: unknown) => ({ writing_review: { concerns: [], policy_acknowledgment: value } });
    expect(DokMetaSchema.parse(review(acknowledgment)).writing_review).toHaveProperty('policy_acknowledgment', acknowledgment);
    for (const invalid of [{ tone: 'casual' }, { locale: 'en' }, { acknowledged_at: 'today' }]) {
      expect(DokMetaSchema.safeParse(review({ ...acknowledgment, ...invalid })).success).toBe(false);
    }
  });

  it('clears prior acknowledgment when recording a new generation policy', () => {
    const dok = DokSchema.parse({ dok_id: 'CHAT', name: '대화', description: '메시지를 보냅니다.', _meta: {
      writing_policy: { locale: 'ko', tone: 'plain' }, writing_review: { concerns: [], policy_acknowledgment: {
        locale: 'ko', tone: 'formal', acknowledged_at: '2026-09-25T03:00:00.000Z',
      } },
    } });
    expect(dok._meta.writing_review).toHaveProperty('policy_acknowledgment');
    recordDokWritingPolicy(dok, 'ko', 'formal');
    expect(dok._meta.writing_policy).toEqual({ locale: 'ko', tone: 'formal' });
    expect(dok._meta.writing_review).toEqual({ assessed_by: 'deterministic', concerns: [] });
  });
});
