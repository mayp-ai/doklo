import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScan } from '../src/commands/scan.js';
import { describe, it, expect } from 'vitest';
import { DokSchema, ProjectIRSchema } from '@doklo-beta/core';
import type { ConsolidatedFeatureConfig } from '@doklo-beta/generator';
import { refreshTrackingMappings, repairDokTracking } from '../src/lib/tracking-recovery.js';

function fixture() {
  const ir = ProjectIRSchema.parse({ framework: 'nextjs', root: '/tmp/project',
    files: ['app/page.jsx', 'components/Uploader.jsx'],
    routes: [{ kind: 'page', path: '/', file: 'app/page.jsx' }], components: [], stores: [],
    framework_specific: { import_graph_tracking_version: 2,
      import_graph: { 'app/page.jsx': ['components/Uploader.jsx'], 'components/Uploader.jsx': [] },
      file_ledger: ['app/page.jsx', 'components/Uploader.jsx'].map(file => ({ file, status: 'processed', stages: ['discovery', 'import-graph'], reason: 'OK' })) },
  });
  const config: ConsolidatedFeatureConfig = { projectName: 'demo', generatedAt: 'old', basedOnFeaturesAt: 'old', model: 'old', userReviewed: true,
    originalFeatureIds: ['home'], stats: { originalFeatures: 1, consolidatedFeatures: 1, merges: 0, excluded: 0 },
    groups: [{ group_id: 'home', label: 'My group', excluded: [], features: [{ canonical_id: 'home', label: 'My upload', decision: 'keep', members: ['home'], primary_route: '/', reason: 'Human choice', user_reviewed: true, dok_id_prefix: 'UPLOAD', source_files: ['app/page.jsx'], logic_files: ['app/page.jsx'] }] }],
  };
  return { ir, config };
}

describe('tracking recovery', () => {
  it('refreshes only file mappings and does not mutate classification decisions', () => {
    const { ir, config } = fixture();
    const refreshed = refreshTrackingMappings(config, ir);
    expect(refreshed.groups[0]!.features[0]!.logic_files).toEqual(['app/page.jsx', 'components/Uploader.jsx']);
    expect(refreshed.groups[0]!.features[0]).toMatchObject({ label: 'My upload', decision: 'keep', members: ['home'], user_reviewed: true });
    expect(config.groups[0]!.features[0]!.logic_files).toEqual(['app/page.jsx']);
  });
  it('rejects old or failed graph evidence and missing consolidated members', () => {
    const { ir, config } = fixture();
    delete ir.framework_specific!['import_graph_tracking_version'];
    expect(() => refreshTrackingMappings(config, ir)).toThrow(/tracking/i);
    ir.framework_specific!['import_graph_tracking_version'] = 2;
    config.groups[0]!.features[0]!.members = ['removed'];
    expect(() => refreshTrackingMappings(config, ir)).toThrow(/removed/);
    config.groups[0]!.features[0]!.members = ['home'];
    (ir.framework_specific!['file_ledger'] as any[])[0].status = 'failed';
    expect(() => refreshTrackingMappings(config, ir)).toThrow(/tracking/i);
  });
  it('repairs legacy scope while retaining body, hash, human edits and history', () => {
    const { ir, config } = fixture();
    const feature = refreshTrackingMappings(config, ir).groups[0]!.features[0]!;
    const dok = DokSchema.parse({ dok_id: 'UPLOAD', name: 'Human title', description: 'Human body', status: 'active', tags: [], surfaces: ['web'],
      user_actions: { steps: [] }, business_rules: { rules: [] }, acceptance_criteria: { criteria: [] },
      _meta: { version: 7, history: [], edited_by_human: true, logic_hash: 'old-hash', source_anchors: [{ file: 'app/page.jsx' }] } });
    const repaired = repairDokTracking(dok, feature, 'web');
    expect(repaired).toMatchObject({ name: 'Human title', description: 'Human body', status: 'active', _meta: {
      version: 7, history: [], edited_by_human: true, logic_hash: 'old-hash', tracking_version: 2, tracking_review_required: true,
      logic_files: [{ file: 'app/page.jsx' }, { file: 'components/Uploader.jsx' }],
    } });
    expect(dok._meta.tracking_version).toBeUndefined();
    expect(repairDokTracking(repaired, feature, 'web')).toEqual(repaired);
  });
});


describe('scan tracking repair', () => {
  it('rebuilds the cache locally and preserves the old Dok baseline for review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-repair-'));
    await mkdir(join(root, '.doklo/cache'), { recursive: true });
    await mkdir(join(root, '.doklo/hub/doks'), { recursive: true });
    await mkdir(join(root, 'app'));
    await mkdir(join(root, 'components'));
    await writeFile(join(root, 'app/page.jsx'), 'export default () => null;');
    await writeFile(join(root, 'components/Uploader.jsx'), 'export default () => null;');
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
    await writeFile(join(root, 'workspace.json'), JSON.stringify({ workspace_id: 'demo', name: 'Demo', services: [{ service_id: 'web', code_root: '.', framework: 'nextjs', type: 'frontend' }], default_locale: 'en', supported_locales: ['en'] }));
    const { ir, config } = fixture();
    const cachePath = join(root, '.doklo/cache/web.consolidated.json');
    await writeFile(cachePath, JSON.stringify(config));
    const dok = { dok_id: 'UPLOAD', name: 'Human title', status: 'active', tags: [], surfaces: ['web'], description: 'Human body', user_actions: { steps: [] }, business_rules: { rules: [] }, acceptance_criteria: { criteria: [] }, _meta: { version: 3, history: [], logic_hash: 'old', edited_by_human: true, source_anchors: [{ file: 'app/page.jsx' }] } };
    const dokPath = join(root, '.doklo/hub/doks/UPLOAD.json');
    await writeFile(dokPath, JSON.stringify(dok));
    const result = await runScan({ root, repairTracking: true }, { extractIR: async () => ir });
    expect(result.results[0]?.trackingRepair?.repairedDokIds).toEqual(['UPLOAD']);
    expect(JSON.parse(await readFile(cachePath, 'utf8')).groups[0].features[0].logic_files).toEqual(['app/page.jsx', 'components/Uploader.jsx']);
    const repaired = JSON.parse(await readFile(dokPath, 'utf8'));
    expect(repaired).toMatchObject({ description: 'Human body', status: 'active', _meta: { version: 3, history: [], logic_hash: 'old', edited_by_human: true, tracking_review_required: true, tracking_version: 2 } });
    config.groups[0]!.features[0]!.members = ['missing-member'];
    await writeFile(cachePath, JSON.stringify(config));
    const scanBefore = await readFile(join(root, '.doklo/cache/web.scan.json'), 'utf8');
    await expect(runScan({ root, repairTracking: true }, { extractIR: async () => ir })).rejects.toThrow(/missing-member/);
    expect(await readFile(join(root, '.doklo/cache/web.scan.json'), 'utf8')).toBe(scanBefore);
    expect(JSON.parse(await readFile(dokPath, 'utf8'))).toEqual(repaired);
  });
});
