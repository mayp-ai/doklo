import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runGenerate } from '../src/commands/generate.js';
import { authorizeLlmRun, buildLlmRunPlan } from '../src/lib/llm-preflight.js';
import { resolveContainedOutputPath } from '@doklo-beta/generator';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doklo-evidence-'));
  roots.push(root);
  for (const path of ['.doklo/cache', '.doklo/hub/doks', 'app']) await mkdir(join(root, path), { recursive: true });
  const files = {
    'app/page.tsx': "import { completedMonths } from './ChatPage';\nexport default function Child() { return completedMonths(12); }",
    'app/ChatPage.tsx': 'export function completedMonths(months: number) {\n  return Math.floor(months);\n}\nexport default function ChatPage() {\n  return <button>RESEND_CHAT_ACTION</button>;\n}',
    'PRODUCT.md': 'This product supports care as a whole. Future: video consultation.',
  };
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  await writeFile(join(root, 'workspace.json'), JSON.stringify({
    workspace_id: 'evidence', name: 'Evidence', default_locale: 'en', supported_locales: ['en'],
    services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
  }));
  await writeFile(join(root, '.doklo/hub/roles.json'), JSON.stringify({ version: 1, roles: [] }));
  await writeFile(join(root, '.doklo/cache/web.scan.json'), JSON.stringify({
    framework: 'nextjs', root, files: Object.keys(files), components: [], stores: [], role_signals: [],
    routes: [{ path: '/child', kind: 'page', file: 'app/page.tsx', dynamic_params: [], layout_chain: [] }],
  }));
  const consolidated = {
    projectName: 'evidence', basedOnFeaturesAt: '2026-09-24T00:00:00.000Z', generatedAt: '2026-09-24T00:00:00.000Z',
    model: 'test', originalFeatureIds: ['child'], userReviewed: false,
    stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
    groups: [{ group_id: 'children', label: 'Children', excluded: [], features: [{
      canonical_id: 'child', label: 'Child records', dok_id_prefix: 'CHILD', decision: 'keep', members: ['child'],
      primary_route: '/child', reason: '', user_reviewed: false,
      source_files: ['app/page.tsx', 'app/ChatPage.tsx'], logic_files: ['app/page.tsx', 'app/ChatPage.tsx'],
      source_context: [
        { file: 'app/page.tsx', content_hash: createHash('sha256').update(files['app/page.tsx']).digest('hex'), ranges: [{ start: 1, end: 2 }], symbols: [], kind: 'entry' },
        { file: 'app/ChatPage.tsx', content_hash: createHash('sha256').update(files['app/ChatPage.tsx']).digest('hex'), ranges: [{ start: 1, end: 3 }], symbols: ['completedMonths'], kind: 'imported-symbol' },
      ],
    }] }],
  };
  await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(consolidated));
  return { root, files, consolidated };
}

describe('generation evidence preparation', () => {
  it('transmits the imported helper without the other screen and preserves full drift coverage', async () => {
    const { root } = await fixture();
    const preview = await runGenerate({ root, dryRun: true, noIa: true, noCodeMapping: true });
    const item = preview.preparedGeneration!.items[0]!;
    expect(item.ctx.fileContext['app/ChatPage.tsx']).toContain('Math.floor');
    expect(item.prompt).not.toContain('RESEND_CHAT_ACTION');
    expect(item.feature.logic_files).toContain('app/ChatPage.tsx');
    const transmitted = item.transmissions.find(source => source.file === 'app/ChatPage.tsx')!;
    expect(transmitted.actualChars).toBe(item.ctx.fileContext['app/ChatPage.tsx']!.length);
  });

  it('includes an inventoried product brief in consent and drift, separated from implementation', async () => {
    const { root } = await fixture();
    const preview = await runGenerate({ root, dryRun: true, noIa: true, noCodeMapping: true });
    const item = preview.preparedGeneration!.items[0]!;
    expect(item.ctx.fileContext['PRODUCT.md']).toContain('care as a whole');
    expect(item.feature.logic_files).toContain('PRODUCT.md');
    expect(item.transmissions.some(source => source.file === 'PRODUCT.md' && source.actualChars > 0)).toBe(true);
    expect(item.prompt.split('# Product intent evidence\n')[1]).toContain('Future: video consultation');
  });

  it('rejects stale source ranges instead of silently widening them to the entire file', async () => {
    const { root, consolidated } = await fixture();
    consolidated.groups[0]!.features[0]!.source_context[1]!.ranges[0]!.end = 99;
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(consolidated));
    await expect(runGenerate({ root, dryRun: true })).rejects.toThrow(/range|rescan/i);
  });

  it('does not include another screen declared on the same line as an imported helper', async () => {
    const { root, consolidated } = await fixture();
    const helper = 'export function completedMonths(n:number){return n;}';
    const source = helper + ' export const Chat = "RESEND_CHAT_ACTION";';
    await writeFile(join(root, 'app/ChatPage.tsx'), source);
    consolidated.groups[0]!.features[0]!.source_context[1]!.content_hash = createHash('sha256').update(source).digest('hex');
    Object.assign(consolidated.groups[0]!.features[0]!.source_context[1]!.ranges[0]!, {
      start: 1, end: 1, startColumn: 1, endColumn: helper.length + 1,
    });
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(consolidated));
    const preview = await runGenerate({ root, dryRun: true, noIa: true, noCodeMapping: true });
    expect(preview.preparedGeneration!.items[0]!.prompt).toContain('return n;');
    expect(preview.preparedGeneration!.items[0]!.prompt).not.toContain('RESEND_CHAT_ACTION');
  });

  it('rejects stale symbol ranges even when the changed file still has enough lines', async () => {
    const { root, files } = await fixture();
    await writeFile(join(root, 'app/ChatPage.tsx'), 'export function unrelated() { return "WRONG_EVIDENCE"; }\n' + files['app/ChatPage.tsx']);
    await expect(runGenerate({ root, dryRun: true })).rejects.toThrow(/changed|rescan/i);
  });

  it('does not stamp a current drift baseline over source edited during the provider call', async () => {
    const { root } = await fixture();
    const options = { root, noIa: true, noCodeMapping: true };
    const preview = await runGenerate({ ...options, dryRun: true });
    const llm = { providerKind: 'anthropic' as const, model: 'anthropic/claude-sonnet-5', authSource: 'keychain' as const, apiKey: 'test-key' };
    const workItems = preview.plan.map(item => ({phase: 'generate' as const, serviceId:item.serviceId,id:item.dokId}));
    const plan = buildLlmRunPlan({ llm, candidateFiles:preview.transmissions, workItems,
      calls:{consolidate:0,lexicon:0,generateMax:1,judgeMax:0},
      preparedCalls:preview.preparedGeneration!.items.map(item => ({phase:'generate' as const,workItem:workItems[0]!,prompt:item.prompt,maxOutputTokens:8192})),
      debugDir:await resolveContainedOutputPath(root,'.doklo/debug'),
    });
    const authorizedRun = await authorizeLlmRun(root,plan,llm,{yes:true,isTTY:false});
    const result = await runGenerate({...options,authorizedRun,preparedGeneration:preview.preparedGeneration}, {
      generateDokForFeature: async () => {
        await writeFile(join(root,'app/ChatPage.tsx'),'export const changedAfterApproval = true;');
        return {success:true,prompt:'',rawResponse:'{}',usage:{input_tokens:2,output_tokens:2},
          dok:{dok_id:'CHILD',name:'Child',status:'draft',description:'Records',tags:[],surfaces:['web'],_meta:{version:1,history:[]}}};
      },
    });
    expect(result.results).toHaveLength(0);
    expect(result.failures).toEqual([expect.objectContaining({dokId:'CHILD',code:'SOURCE_CHANGED_DURING_GENERATION'})]);
  });
});
