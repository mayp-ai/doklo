import { describe, expect, it, vi } from 'vitest';
const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));
vi.mock('../src/llm-client.js', async (original) => ({
  ...await original<typeof import('../src/llm-client.js')>(), callModel: callModelMock,
}));
import { buildDokPromptParts, findDokLanguageMismatch, generateDokForFeature, renderDokFeatureBlock } from '../src/dok-generator.js';

// A Korean product documented in another language: the source and the feature
// label are Korean, the Dok is asked for in Simplified Chinese (review 2026-10-27).
const feature = {
  canonical_id: 'program-schedule', label: '프로그램 일정 관리', dok_id_prefix: 'PROGRAM-SCHEDULE',
  primary_route: '/program/:id/schedule', members: [], files: ['app/page.tsx'],
};
const ctx = {
  defaultLocale: 'zh-Hans', knownRoles: ['ROLE-OWNER'], dokId: 'PROGRAM-SCHEDULE',
  fileContext: { 'app/page.tsx': "toast.success('일정이 추가되었습니다.')" },
};

function response(name: string, sentence: string) {
  return {
    success: true, processingTime: 0, error: null, usage: null,
    content: JSON.stringify({
      dok_id: 'PROGRAM-SCHEDULE', name, description: sentence,
      user_actions: { steps: [1, 2, 3].map((order) => ({
        order, actor: { kind: 'role', role_ref: 'ROLE-OWNER' }, intent: sentence, outcome: sentence,
        variants: [{ platform: 'all', interaction: 'auto' }],
      })) },
      business_rules: { rules: [{ id: 'BR-PROGRAM-SCHEDULE-01', description: sentence, type: 'permission' }] },
      acceptance_criteria: { criteria: [{ id: 'AC-PROGRAM-SCHEDULE-01', statement: sentence, related_rules: [] }] },
    }),
  };
}

describe('the Dok language', () => {
  it('holds the asked language against the source language at both ends of the prompt', () => {
    const { systemPrompt, userPrompt } = buildDokPromptParts(feature, ctx);
    expect(systemPrompt).toContain('that never changes the output language');
    expect(systemPrompt).toContain('only when it is in Simplified Chinese (简体中文)');
    expect(systemPrompt).toContain('as if the screen showed it');
    // The English instruction, then the same in the language itself, close the prompt.
    expect(userPrompt.trimEnd().split('\n').slice(-3)).toEqual([
      'Now output the JSON object. Write every reader-facing field in Simplified Chinese (简体中文),',
      'whatever language the evidence above is written in.',
      '即使源代码和界面文字使用其他语言，所有面向读者的字段也都必须用简体中文撰写。',
    ]);
    const english = buildDokPromptParts(feature, { ...ctx, defaultLocale: 'en' }).userPrompt.trimEnd();
    expect(english.endsWith('whatever language the evidence above is written in.')).toBe(true);
  });

  it('refuses a Dok written in the source language instead of the asked one', async () => {
    callModelMock.mockResolvedValueOnce(response('프로그램 일정 관리', '프로그램 소유자는 일정을 추가하거나 삭제할 수 있고 다른 멘토는 목록만 봅니다.'));
    const result = await generateDokForFeature(feature, ctx);
    expect(result).toMatchObject({
      success: false, dok: null, failureKind: 'wrong_language',
      error: 'The Dok was written in Hangul (Korean), not Simplified Chinese (简体中文).',
    });
  });

  it('keeps a Dok in the asked language, with the on-screen wording quoted', async () => {
    callModelMock.mockResolvedValueOnce(response('项目日程管理', '负责导师提交后，列表中出现新日程，页面提示“일정이 추가되었습니다.”（日程已添加）。'));
    const result = await generateDokForFeature(feature, ctx);
    expect(result.success).toBe(true);
    expect(result.dok?._meta.locale).toBe('zh-Hans');
  });

  it('leaves a working label in another script out of the feature block', () => {
    const korean = { ...feature, members: [{ id: 'program-schedule', label: '일정', route: '/program/:id/schedule' }] };
    const chinese = renderDokFeatureBlock(korean, 12_000, 'zh-Hans');
    expect(chinese).not.toContain('프로그램 일정 관리');
    expect(chinese).not.toContain('"label"');
    expect(chinese).toContain('"canonical_id": "program-schedule"');
    // Same language, or no language given: the block is unchanged.
    expect(renderDokFeatureBlock(korean, 12_000, 'ko')).toBe(renderDokFeatureBlock(korean));
    expect(renderDokFeatureBlock(korean)).toContain('"label": "프로그램 일정 관리"');
    expect(buildDokPromptParts(korean, ctx).userPrompt).not.toContain('프로그램 일정 관리');
  });

  it('refuses a name in another script even when the rest is in the asked language', () => {
    const dok = (name: string) => ({ name, description: '负责导师可以新增或删除日程。', user_actions: { steps: [] },
      business_rules: { rules: [] }, acceptance_criteria: { criteria: [] } }) as never;
    expect(findDokLanguageMismatch(dok('멘토링 프로그램 일정 관리'), 'zh-Hant')).toBe("The Dok's name is not written in Traditional Chinese (繁體中文).");
    expect(findDokLanguageMismatch(dok('방案行程管理'), 'zh-Hant')).not.toBeNull();
    expect(findDokLanguageMismatch(dok('课程排程管理'), 'zh-Hans')).toBeNull();
  });
});
