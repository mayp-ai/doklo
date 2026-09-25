import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runGenerate } from '../src/commands/generate.js';
import { authorizeLlmRun, buildLlmRunPlan } from '../src/lib/llm-preflight.js';
import { DOK_SOURCE_MAX_CHARS, resolveContainedOutputPath } from '@doklo-beta/generator';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: { shellMetacharactersInRoot?: boolean } = {}) {
  const cleanupRoot = await mkdtemp(join(tmpdir(), 'doklo-evidence-'));
  roots.push(cleanupRoot);
  const root = options.shellMetacharactersInRoot
    ? join(cleanupRoot, "workspace $HOME `tick` 'quoted")
    : cleanupRoot;
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
  it('keeps disjoint source evidence under the transmitted cap without repeated range labels', async () => {
    const { root, consolidated } = await fixture();
    const sentinels = new Map([
      [0, 'SHARED_BUSINESS_HELPER'],
      [1, 'SIDE_EFFECT_INITIALIZER'],
      [2, 'TYPE_ONLY_BOUNDARY'],
      [299, 'LATE_RANGE'],
    ]);
    const selected = Array.from({ length: 300 }, (_, index) =>
      `${sentinels.get(index) ?? `selected_${index}`}`.padEnd(620, 'x'));
    const lines = selected.flatMap((line, index) => [line, `UNRELATED_SCREEN_${index}`]);
    const source = lines.join('\n');
    await writeFile(join(root, 'app/ChatPage.tsx'), source);
    const context = consolidated.groups[0]!.features[0]!.source_context[1]!;
    context.content_hash = createHash('sha256').update(source).digest('hex');
    context.ranges = selected.map((_, index) => ({ start: index * 2 + 1, end: index * 2 + 1 }));
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(consolidated));

    const preview = await runGenerate({ root, dryRun: true, noIa: true, noCodeMapping: true });
    const item = preview.preparedGeneration!.items[0]!;
    const rendered = item.ctx.fileContext['app/ChatPage.tsx']!;
    expect(rendered).toBe(selected.join('\n\n'));
    expect(rendered).toContain('SHARED_BUSINESS_HELPER');
    expect(rendered).toContain('SIDE_EFFECT_INITIALIZER');
    expect(rendered).toContain('TYPE_ONLY_BOUNDARY');
    expect(rendered).toContain('LATE_RANGE');
    expect(rendered).not.toContain('UNRELATED_SCREEN');
    expect(Object.values(item.ctx.fileContext).reduce((sum, value) => sum + value.length, 0))
      .toBeLessThanOrEqual(DOK_SOURCE_MAX_CHARS);
    expect(item.transmissions.find(source => source.file === 'app/ChatPage.tsx')?.actualChars)
      .toBe(rendered.length);
  });

  it('reports one true oversize as blocked while preserving the ready dry-run plan', async () => {
    const { root, consolidated } = await fixture({ shellMetacharactersInRoot: true });
    const shellQuotedRoot = `'${root.slice(0, -"'quoted".length)}'\\''quoted'`;
    const oversized = 'z'.repeat(DOK_SOURCE_MAX_CHARS + 1);
    await writeFile(join(root, 'app/Oversize.ts'), oversized);
    consolidated.groups[0]!.features.push({
      canonical_id: 'oversize', label: 'Oversize records', dok_id_prefix: 'OVERSIZE', decision: 'keep', members: ['oversize'],
      primary_route: '/oversize', reason: '', user_reviewed: false,
      source_files: ['app/Oversize.ts'], logic_files: ['app/Oversize.ts'],
      source_context: [{
        file: 'app/Oversize.ts', content_hash: createHash('sha256').update(oversized).digest('hex'),
        ranges: [{ start: 1, end: 1 }], symbols: ['oversize'], kind: 'imported-symbol',
      }],
    });
    consolidated.originalFeatureIds.push('oversize');
    consolidated.stats.originalFeatures = 2;
    consolidated.stats.consolidatedFeatures = 2;
    await writeFile(join(root, '.doklo/cache/web.consolidated.json'), JSON.stringify(consolidated));
    const generator = vi.fn();

    const preview = await runGenerate(
      { root, dryRun: true, noIa: true, noCodeMapping: true, retries: 2 },
      { generateDokForFeature: generator },
    );

    expect(generator).not.toHaveBeenCalled();
    expect(preview.plan.map(item => item.dokId)).toEqual(['CHILD', 'OVERSIZE']);
    expect(preview.preparedGeneration!.items.map(item => item.dokId)).toEqual(['CHILD']);
    expect(preview.failures).toEqual([expect.objectContaining({
      serviceId: 'web', dokId: 'OVERSIZE', code: 'DOK_SOURCE_CONTEXT_LIMIT',
      file: 'app/Oversize.ts', actualChars: DOK_SOURCE_MAX_CHARS + 1,
      limitChars: DOK_SOURCE_MAX_CHARS, retryable: false,
      nextCommand: `cd ${shellQuotedRoot} && doklo generate --only 'CHILD' --yes`,
    })]);

    await expect(runGenerate({
      root, noIa: true, noCodeMapping: true, retries: 2,
      preparedGeneration: preview.preparedGeneration,
    }, { generateDokForFeature: generator })).rejects.toMatchObject({
      result: { diagnostics: [expect.objectContaining({
        code: 'DOK_SOURCE_CONTEXT_BLOCKED',
        nextCommand: `cd ${shellQuotedRoot} && doklo generate --only 'CHILD' --yes`,
      })] },
    });
    expect(generator).not.toHaveBeenCalled();

    const readyExistingPath = join(root, '.doklo/hub/doks/CHILD.json');
    const readyExisting = `${JSON.stringify({
      dok_id: 'CHILD', name: 'Human edited ready Dok', status: 'draft', description: 'Regenerate me.',
      tags: [], surfaces: ['web'],
      user_actions: { steps: [{
        order: 1, actor: { kind: 'system' }, intent: 'Regenerate', outcome: 'Regenerated',
        variants: [{ platform: 'all', interaction: 'auto' }],
      }] },
      business_rules: { rules: [] }, acceptance_criteria: { criteria: [] },
      _meta: { version: 1, history: [], source_anchors: [{ file: 'app/page.tsx' }] },
    }, null, 2)}\n`;
    await writeFile(readyExistingPath, readyExisting);
    const forcedPreview = await runGenerate({
      root, serviceId: 'web', dryRun: true, force: true, noIa: true, noCodeMapping: true,
    }, { generateDokForFeature: generator });
    expect(forcedPreview.failures).toEqual([expect.objectContaining({
      dokId: 'OVERSIZE',
      nextCommand: `cd ${shellQuotedRoot} && doklo generate --service 'web' --only 'CHILD' --force --yes`,
    })]);
    const forcedReadySubset = await runGenerate({
      root, serviceId: 'web', dryRun: true, force: true, onlyDokIds: ['CHILD'],
      noIa: true, noCodeMapping: true,
    }, { generateDokForFeature: generator });
    expect(forcedReadySubset.plan.map(item => item.dokId)).toEqual(['CHILD']);
    expect(forcedReadySubset.skippedExisting).not.toContain('CHILD');
    expect(await readFile(readyExistingPath, 'utf8')).toBe(readyExisting);

    const allBlocked = await runGenerate({
      root, dryRun: true, onlyDokIds: ['OVERSIZE'], noIa: true, noCodeMapping: true,
    }, { generateDokForFeature: generator });
    expect(allBlocked.preparedGeneration?.items).toEqual([]);
    expect(allBlocked.failures).toEqual([expect.not.objectContaining({ nextCommand: expect.anything() })]);
    await expect(runGenerate({
      root, noIa: true, noCodeMapping: true,
      preparedGeneration: allBlocked.preparedGeneration,
    }, { generateDokForFeature: generator })).rejects.toMatchObject({
      result: { diagnostics: [expect.objectContaining({
        code: 'DOK_SOURCE_CONTEXT_BLOCKED',
        message: expect.not.stringContaining('ready subset'),
      })] },
    });

    const readySubset = await runGenerate({
      root, dryRun: true, onlyDokIds: ['CHILD'], noIa: true, noCodeMapping: true,
    }, { generateDokForFeature: generator });
    expect(readySubset.skippedExisting).toContain('CHILD');
    expect(readySubset.preparedGeneration!.items).toEqual([]);

    const existingPath = join(root, '.doklo/hub/doks/OVERSIZE.json');
    const existing = `${JSON.stringify({
      dok_id: 'OVERSIZE', name: 'Human edited oversize Dok', status: 'draft', description: 'Preserve me.',
      tags: [], surfaces: ['web'],
      user_actions: { steps: [{
        order: 1, actor: { kind: 'system' }, intent: 'Preserve', outcome: 'Preserved',
        variants: [{ platform: 'all', interaction: 'auto' }],
      }] },
      business_rules: { rules: [] }, acceptance_criteria: { criteria: [] },
      _meta: { version: 1, history: [], source_anchors: [{ file: 'app/Oversize.ts' }] },
    }, null, 2)}\n`;
    await writeFile(existingPath, existing);
    const withExisting = await runGenerate({
      root, dryRun: true, noIa: true, noCodeMapping: true,
    }, { generateDokForFeature: generator });
    expect(withExisting.skippedExisting).toContain('OVERSIZE');
    expect(withExisting.failures).toEqual([]);
    expect(await readFile(existingPath, 'utf8')).toBe(existing);
    expect(generator).not.toHaveBeenCalled();
  });

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
