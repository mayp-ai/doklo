// Feature-aware token + cost estimators.
//
// These were excluded from estimator.ts because they depend on the Feature
// shape from @doklo-beta/generator. We avoid a circular dep by accepting
// any value that matches FeatureLike — TypeScript structural typing makes
// the real Feature compatible without an import.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bytesToTokens,
  estimateTokensFromBytes,
  calculateCost,
  type CostEstimate,
} from './estimator.js';

// Minimal subset of @doklo-beta/generator's Feature that we need to
// compute a token estimate. Any compatible object works (structural typing).
export interface FeatureLike {
  id: string;
  label: string;
  routePath: string;
  files: { path: string; isShared: boolean }[];
}

export interface FeatureConfigLike {
  projectRoot: string;
  featureGroups: {
    enabled: boolean;
    features: (FeatureLike & { enabled: boolean })[];
  }[];
}

export interface FeatureTokenEstimate extends CostEstimate {
  featureId: string;
  featureLabel: string;
  routePath: string;
  fileCount: number;
  totalBytes: number;
}

export interface AllTokenEstimate {
  features: FeatureTokenEstimate[];
  summary: {
    totalFeatures: number;
    totalFiles: number;
    totalBytes: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalEstimatedCost: number;
  };
}

// Shared infra files (utils/lib/types/...) are stamped into prompts as
// signatures only, so we count them at this fixed size rather than full bytes.
const SHARED_INFRA_BYTES = 150;
const FALLBACK_BYTES_PER_FILE = 2000;

const INFRA_PREFIXES = [
  'utils/', 'lib/', 'libs/', 'helpers/', 'helper/',
  'constants/', 'const/', 'config/', 'configs/',
  'types/', 'type/', 'models/', 'model/',
  'src/utils/', 'src/lib/', 'src/libs/', 'src/helpers/',
  'src/constants/', 'src/config/', 'src/types/', 'src/models/',
];

export function isInfraPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, '/');
  if (INFRA_PREFIXES.some((p) => normalized.startsWith(p))) return true;
  if (/\.(config|const|constants|types|model)\.(ts|js)$/.test(normalized)) return true;
  const filename = normalized.split('/').pop() ?? '';
  if (/^(cn|db|env|api|cookies?|fetcher)\.(ts|tsx|js|jsx)$/.test(filename)) return true;
  return false;
}

export async function getFeatureBytes(
  feature: FeatureLike,
  projectRoot: string,
): Promise<number> {
  let totalBytes = 0;
  for (const file of feature.files) {
    if (file.isShared && isInfraPath(file.path)) {
      totalBytes += SHARED_INFRA_BYTES;
      continue;
    }
    try {
      const fullPath = join(projectRoot, file.path);
      const s = await stat(fullPath);
      totalBytes += s.size;
    } catch {
      totalBytes += FALLBACK_BYTES_PER_FILE;
    }
  }
  return totalBytes;
}

export async function estimateFeatureTokens(
  feature: FeatureLike,
  projectRoot: string,
): Promise<FeatureTokenEstimate> {
  const totalBytes = await getFeatureBytes(feature, projectRoot);
  const tokens = estimateTokensFromBytes(totalBytes);
  return {
    featureId: feature.id,
    featureLabel: feature.label,
    routePath: feature.routePath,
    fileCount: feature.files.length,
    totalBytes,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    estimatedCost: calculateCost(tokens.inputTokens, tokens.outputTokens),
  };
}

export async function estimateAllTokens(
  config: FeatureConfigLike,
): Promise<AllTokenEstimate> {
  const allFeatures = config.featureGroups
    .filter((g) => g.enabled)
    .flatMap((g) => g.features.filter((f) => f.enabled));

  const features: FeatureTokenEstimate[] = [];
  for (const f of allFeatures) {
    features.push(await estimateFeatureTokens(f, config.projectRoot));
  }

  return {
    features,
    summary: {
      totalFeatures: features.length,
      totalFiles: features.reduce((s, f) => s + f.fileCount, 0),
      totalBytes: features.reduce((s, f) => s + f.totalBytes, 0),
      totalInputTokens: features.reduce((s, f) => s + f.inputTokens, 0),
      totalOutputTokens: features.reduce((s, f) => s + f.outputTokens, 0),
      totalTokens: features.reduce((s, f) => s + f.totalTokens, 0),
      totalEstimatedCost: features.reduce((s, f) => s + f.estimatedCost, 0),
    },
  };
}

// Quick text-only token estimate. Used when callers only have a prompt
// string and don't need Feature/file accounting.
export function estimateTokensFromText(text: string): number {
  return bytesToTokens(text.length);
}

// Format a complete cost estimate as a human-readable summary.
export function formatCostEstimate(estimate: AllTokenEstimate): string {
  const { summary } = estimate;
  const fmt = (t: number) =>
    t >= 1_000_000 ? `~${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `~${Math.round(t / 1000)}K` : `~${t}`;
  const cost = (c: number) => (c < 0.01 ? `~$${c.toFixed(3)}` : `~$${c.toFixed(2)}`);

  return [
    `Total: ${fmt(summary.totalTokens)} tokens (${cost(summary.totalEstimatedCost)} estimated)`,
    `  Input:  ${fmt(summary.totalInputTokens)} tokens`,
    `  Output: ${fmt(summary.totalOutputTokens)} tokens`,
    `  Files:  ${summary.totalFiles}`,
    `  Features: ${summary.totalFeatures}`,
  ].join('\n');
}
