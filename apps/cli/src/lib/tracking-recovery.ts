import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DokSchema, type Dok, type ProjectIR } from '@doklo-beta/core';
import {
  attachSourceFiles, assignDokIds, irToFeatures, parseConsolidatedFeatureConfig,
  resolveContainedPath, resolveContainedOutputPath,
  type ConsolidatedFeature, type ConsolidatedFeatureConfig,
} from '@doklo-beta/generator';
import type { WorkspacePaths } from './paths.js';

export class TrackingRecoveryError extends Error {
  readonly code = 'TRACKING_RECOVERY_INCOMPLETE';
}

/** Version describes the static import resolver, not complete runtime coverage. */
export function hasValidatedTrackingGraph(ir: ProjectIR): boolean {
  const data = ir.framework_specific;
  if (data?.['import_graph_tracking_version'] !== 2) return false;
  const graph = data['import_graph'];
  const ledger = data['file_ledger'];
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Array.isArray(ledger)) return false;
  const files = new Set(ir.files);
  if (files.size !== ir.files.length) return false;
  const included = new Set<string>();
  for (const entry of ledger) {
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || !Array.isArray(entry.stages)) return false;
    if (entry.status === 'excluded') continue;
    if (entry.status !== 'processed' || included.has(entry.file) || !files.has(entry.file)) return false;
    included.add(entry.file);
  }
  if (included.size !== files.size) return false;
  for (const [file, targets] of Object.entries(graph)) {
    if (!files.has(file) || !Array.isArray(targets) || targets.some(target => typeof target !== 'string' || !files.has(target))) return false;
  }
  if (ir.routes.some(route => route.kind === 'page' && !Object.hasOwn(graph, route.file))) return false;
  const diagnostics = data['import_diagnostics'];
  if (diagnostics !== undefined && (!Array.isArray(diagnostics) || diagnostics.length > 0)) return false;
  return true;
}

/** Generic text inventory establishes a conservative file baseline, not import edges. */
export function hasValidatedTrackingEvidence(ir: ProjectIR): boolean {
  if (hasValidatedTrackingGraph(ir)) return true;
  if (ir.framework_specific?.['analysis_strategy'] !== 'generic-files-v1') return false;
  const files = new Set(ir.files);
  const ledger = ir.framework_specific['file_ledger'];
  if (files.size === 0 || files.size !== ir.files.length || !Array.isArray(ledger)) return false;
  const included = new Set<string>();
  for (const entry of ledger) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.status === 'excluded') continue;
    if (entry.status !== 'processed' || entry.reason !== 'TEXT_SOURCE' || included.has(entry.file) || !files.has(entry.file)) return false;
    included.add(entry.file);
  }
  const units = ir.analysis_units ?? [];
  const covered = new Set(units.flatMap(unit => unit.files));
  return included.size === files.size && covered.size === files.size && [...covered].every(file => files.has(file));
}

export function refreshTrackingMappings(config: ConsolidatedFeatureConfig, ir: ProjectIR): ConsolidatedFeatureConfig {
  if (!hasValidatedTrackingEvidence(ir)) throw new TrackingRecoveryError('Tracking recovery requires validated source evidence. Run doklo scan first.');
  const source = irToFeatures(ir, { projectName: config.projectName });
  const ids = new Set(source.featureGroups.flatMap(group => group.features.map(feature => feature.id)));
  const missing = config.groups.flatMap(group => group.features.flatMap(feature => feature.members.filter(id => !ids.has(id))));
  if (missing.length) throw new TrackingRecoveryError(`Tracking recovery has missing members: ${[...new Set(missing)].sort().join(', ')}`);
  return attachSourceFiles(structuredClone(config), source);
}

function sameFiles(left: string[], right: string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

export function repairDokTracking(dok: Dok, feature: ConsolidatedFeature, serviceId: string): Dok {
  const source = feature.source_files ?? [];
  const logic = feature.logic_files ?? [];
  if (!source.length || !logic.length) throw new TrackingRecoveryError(`Tracking recovery has no files for ${feature.canonical_id}.`);
  const repaired = structuredClone(dok);
  const meta = repaired._meta;
  const changed = meta.tracking_version !== 2 || meta.anchor_service_id !== serviceId ||
    !sameFiles((meta.source_anchors ?? []).map(anchor => anchor.file), source) ||
    !sameFiles((meta.logic_files ?? meta.source_anchors ?? []).map(anchor => anchor.file), logic);
  if (!changed) return repaired;
  meta.source_anchors = source.map(file => ({ file }));
  meta.logic_files = logic.map(file => ({ file }));
  meta.anchor_service_id = serviceId;
  meta.tracking_version = 2;
  meta.tracking_review_required = true;
  return repaired;
}

export interface TrackingRepairPlan {
  cachePath: string;
  writes: Array<{ path: string; content: string }>;
  repairedDokIds: string[];
  unmatchedDokIds: string[];
}

/** Read and validate every update before the scan writes its first cache. */
export async function prepareTrackingRepair(paths: WorkspacePaths, serviceId: string, ir: ProjectIR): Promise<TrackingRepairPlan> {
  const cachePath = join(paths.cacheDir, `${serviceId}.consolidated.json`);
  await resolveContainedPath(paths.root, relative(paths.root, cachePath), { rejectSymlinkLeaf: true });
  const config = parseConsolidatedFeatureConfig(JSON.parse(await readFile(cachePath, 'utf8')));
  const refreshed = refreshTrackingMappings(config, ir);
  const assigned = assignDokIds(refreshed);
  const features = refreshed.groups.flatMap(group => group.features).filter(feature => feature.decision !== 'exclude');
  const plan: TrackingRepairPlan = { cachePath, writes: [{ path: cachePath, content: JSON.stringify(refreshed, null, 2) + '\n' }], repairedDokIds: [], unmatchedDokIds: [] };
  const doksDir = await resolveContainedOutputPath(paths.root, relative(paths.root, paths.doksDir));
  let entries: string[];
  try { entries = await readdir(doksDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return plan; throw error; }
  for (const entry of entries.filter(entry => entry.endsWith('.json')).sort()) {
    const path = join(paths.doksDir, entry);
    await resolveContainedPath(paths.root, relative(paths.root, path), { rejectSymlinkLeaf: true });
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const dok = DokSchema.parse(raw);
    const origins = dok._meta.origins?.filter(origin => origin.service_id === serviceId) ?? [];
    const belongs = dok._meta.anchor_service_id !== undefined
      ? dok._meta.anchor_service_id === serviceId
      : origins.length > 0 || (dok.surfaces.length === 1 && dok.surfaces[0] === serviceId);
    if (dok._meta.anchor_service_id === undefined && (dok._meta.origins?.length ?? 0) > 1) {
      if (belongs) plan.unmatchedDokIds.push(dok.dok_id);
      continue; // Multiple service origins do not identify the anchor root.
    }
    if (!belongs) continue;
    const matches = features.filter(feature => origins.length > 0
      ? origins.some(origin => origin.canonical_feature_id === feature.canonical_id)
      : assigned.get(feature.canonical_id) === dok.dok_id);
    if (matches.length !== 1) { plan.unmatchedDokIds.push(dok.dok_id); continue; }
    const repaired = repairDokTracking(dok, matches[0]!, serviceId);
    if (JSON.stringify(repaired._meta) === JSON.stringify(dok._meta)) continue;
    plan.writes.push({ path, content: JSON.stringify({ ...raw, _meta: { ...raw._meta, ...repaired._meta } }, null, 2) + '\n' });
    plan.repairedDokIds.push(dok.dok_id);
  }
  return plan;
}
