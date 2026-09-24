import { describe, expect, it, vi } from 'vitest';
const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));
vi.mock('../src/llm-client.js', async (original) => ({
  ...await original<typeof import('../src/llm-client.js')>(), callModel: callModelMock,
}));
import { buildDokPromptParts, generateDokForFeature } from '../src/dok-generator.js';

const feature = {
  canonical_id: 'chat', label: 'Chat', dok_id_prefix: 'CHAT', primary_route: '/chat',
  members: [], files: ['app/page.tsx', 'PRODUCT.md'],
};
const ctx = {
  defaultLocale: 'ko', knownRoles: [], dokId: 'CHAT',
  fileContext: {
    'app/page.tsx': 'export default function Chat() { return <button>돌봄 질문하기</button>; }',
    'PRODUCT.md': '배시시는 돌봄 전반을 돕습니다. 계획: 영상 상담을 추가합니다.',
  },
};

describe('product intent and generated review evidence', () => {
  it('separates product intent from executable evidence in the actual provider input', async () => {
    callModelMock.mockResolvedValueOnce({ success: false, content: null, usage: null,
      error: { type: 'ai_sdk_error', message: 'provider unavailable' }, processingTime: 0 });
    await generateDokForFeature(feature, ctx);
    const input = callModelMock.mock.calls.at(-1)![0];
    const implementation = input.userPrompt.split('# Implementation evidence\n')[1]?.split('# Product intent evidence\n')[0];
    const intent = input.userPrompt.split('# Product intent evidence\n')[1];
    expect(implementation).toContain('돌봄 질문하기');
    expect(implementation).not.toContain('영상 상담');
    expect(intent).toContain('PRODUCT.md');
    expect(intent).toContain('영상 상담');
    expect(input.systemPrompt).not.toContain('배시시');
  });

  it('keeps model-reported conflict notes separate from customer prose with verified source membership', async () => {
    callModelMock.mockResolvedValueOnce({ success: true, processingTime: 0, error: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      content: JSON.stringify({ dok_id: 'CHAT', name: '돌봄 대화', description: '돌봄에 관해 질문합니다.',
        _review: { concerns: [{ kind: 'product-scope-conflict', message: '제품 범위를 검토해 주세요.', files: ['PRODUCT.md', 'server/private.ts'] }] },
        _meta: { content_review: { product_sources: ['forged.md'], assessed_by: 'human' } },
      }),
    });
    const result = await generateDokForFeature(feature, ctx);
    expect(result.success).toBe(true);
    expect(result.dok?.description).toBe('돌봄에 관해 질문합니다.');
    expect(result.dok).not.toHaveProperty('_review');
    expect(result.dok?._meta.content_review).toEqual({
      assessed_by: 'model', reported: true, product_sources: ['PRODUCT.md'],
      concerns: [{ kind: 'product-scope-conflict', message: '제품 범위를 검토해 주세요.', files: ['PRODUCT.md'] }],
    });
    expect(result.dok?.status).toBe('draft');
  });

  it('does not promote arbitrary markdown files or filenames into product intent', () => {
    const p = buildDokPromptParts(feature, { ...ctx, fileContext: {
      'README.md': 'build commands', 'PRODUCT.md.ts': 'export const fake = 1;',
      'examples/other-app/PRODUCT.md': 'OTHER_PRODUCT_FUTURE',
    } });
    const intent = p.userPrompt.split('# Product intent evidence\n')[1];
    expect(intent).not.toContain('build commands');
    expect(intent).not.toContain('export const fake');
    expect(intent).not.toContain('OTHER_PRODUCT_FUTURE');
  });

  it('distinguishes an omitted assessment from an explicitly empty model review', async () => {
    callModelMock.mockResolvedValueOnce({ success:true,processingTime:0,error:null,usage:null,
      content:JSON.stringify({dok_id:'CHAT',name:'Chat',description:'Ask a question.'}),
    });
    const result = await generateDokForFeature(feature,ctx);
    expect(result.dok?._meta.content_review).toMatchObject({reported:false,concerns:[]});
  });
});
