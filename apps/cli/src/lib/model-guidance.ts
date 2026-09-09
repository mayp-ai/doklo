// Benchmark-informed model guidance (3 tiers). Evidence: docs/decisions.md
// "모델×프로젝트 벤치마크" entries + benchmarks/model-matrix runs (2026-07).
// Update these lists by re-running `pnpm bench:models`, not by intuition.
import type { ModelCost } from '@doklo-beta/generator';

export type GuidanceTier = 'recommended' | 'neutral' | 'warned';

export interface ModelGuidance {
  tier: GuidanceTier;
  /** i18n key for the picker hint / post-pick message; null for plain neutral. */
  messageKey: string | null;
}

/** ref (exact or prefix) → picker hint i18n key. Order = display priority. */
export const RECOMMENDED: ReadonlyArray<{ prefix: string; hintKey: string }> = [
  { prefix: 'anthropic/claude-sonnet-5', hintKey: 'model.rec_sonnet5' },
  { prefix: 'anthropic/claude-opus-4-8', hintKey: 'model.rec_opus48' },
  { prefix: 'openai/gpt-5.6-sol', hintKey: 'model.rec_sol' },
  { prefix: 'openai/gpt-5.6-luna', hintKey: 'model.rec_luna' },
];

/** Measured-poor refs (prefix match catches dated ids like -20251001). */
export const WARNED: ReadonlyArray<string> = ['anthropic/claude-haiku-4-5'];

// Price-proxy fallback for UNMEASURED models only (kept from the old heuristic).
export const WEAK_OUTPUT_THRESHOLD = 2;

export function modelGuidance(ref: string, cost: ModelCost | undefined): ModelGuidance {
  if (WARNED.some((w) => ref.startsWith(w))) {
    return { tier: 'warned', messageKey: 'model.warn_measured' };
  }
  const rec = RECOMMENDED.find((r) => ref.startsWith(r.prefix));
  if (rec) return { tier: 'recommended', messageKey: rec.hintKey };
  if (cost !== undefined && cost.output < WEAK_OUTPUT_THRESHOLD) {
    return { tier: 'neutral', messageKey: 'model.weak_warning' };
  }
  return { tier: 'neutral', messageKey: null };
}
